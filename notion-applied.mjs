#!/usr/bin/env node
/**
 * Notion applied-requisition gate for career-ops.
 *
 * Syncs Job Link URLs (and company+role keys) from the user's Notion Applications
 * database — the same DB VOYAGER logs completed applications into — and exposes
 * helpers used by scan.mjs and pipeline mode to skip already-applied postings.
 *
 * Env (career-ops .env, or fall back to VOYAGER jobprompter .env read-only):
 *   NOTION_API_KEY or NOTION_ACCESS_TOKEN
 *   NOTION_DATABASE_ID
 *
 * portals.yml (optional):
 *   notion_applied_filter:
 *     enabled: true              # default: auto when credentials exist
 *     sync_max_age_hours: 12     # re-sync if cache older than this
 *
 * CLI:
 *   node notion-applied.mjs sync
 *   node notion-applied.mjs filter-pipeline
 *   node notion-applied.mjs check <url>
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './lib/is-main-module.mjs';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname);
const DATA = join(ROOT, 'data');
export const CACHE_PATH = join(DATA, 'notion-applied-cache.json');
const PIPELINE = join(DATA, 'pipeline.md');
const VOYAGER_ENV_DEFAULT = join(
  process.env.HOME || '',
  'Documents/DevWorld/VOYAGER/src/jobprompter/.env',
);

const OPEN_AGAIN = new Set([
  'rejected',
  'discarded',
  'skip',
  "won't apply",
  'wont apply',
  'closed',
  'withdrawn',
]);

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return;
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

export function loadNotionEnv() {
  loadDotEnv(join(ROOT, '.env'));
  if (!process.env.NOTION_API_KEY && !process.env.NOTION_ACCESS_TOKEN) {
    loadDotEnv(process.env.VOYAGER_ENV || VOYAGER_ENV_DEFAULT);
  }
  const token = process.env.NOTION_API_KEY || process.env.NOTION_ACCESS_TOKEN;
  const databaseId = process.env.NOTION_DATABASE_ID;
  return { token, databaseId, configured: Boolean(token && databaseId) };
}

function plain(prop) {
  if (!prop) return '';
  if (prop.type === 'title') return (prop.title || []).map((t) => t.plain_text).join('');
  if (prop.type === 'rich_text') return (prop.rich_text || []).map((t) => t.plain_text).join('');
  if (prop.type === 'url') return prop.url || '';
  if (prop.type === 'select') return prop.select?.name || '';
  if (prop.type === 'status') return prop.status?.name || '';
  return '';
}

function propByName(properties, ...names) {
  const keys = Object.keys(properties || {});
  for (const want of names) {
    const hit = keys.find((k) => k.trim().toLowerCase() === want.toLowerCase());
    if (hit) return properties[hit];
  }
  return null;
}

function extractRecord(page) {
  const p = page.properties || {};
  const url = plain(propByName(p, 'Job Link', 'Link', 'URL', 'Job URL')).trim();
  const status = plain(propByName(p, 'Status')).trim();
  const role = plain(propByName(p, 'Job Title', 'Role')).trim();
  let company = plain(propByName(p, 'Company', 'Name')).trim();
  if (company.includes(' - ')) company = company.split(' - ')[0].trim();
  return { url, status, role, company, id: page.id };
}

function shouldSkipStatus(status) {
  if (!status) return true;
  return !OPEN_AGAIN.has(status.toLowerCase());
}

async function notionQueryAll(token, databaseId) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json',
  };
  const out = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const j = await res.json();
    if (!res.ok) {
      throw new Error(`Notion query failed: ${j.code || res.status}: ${j.message || JSON.stringify(j)}`);
    }
    out.push(...(j.results || []));
    cursor = j.has_more ? j.next_cursor : null;
    await new Promise((r) => setTimeout(r, 360));
  } while (cursor);
  return out;
}

function normalizeUrl(url) {
  if (typeof url !== 'string' || !url) return url;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const strip = new Set([
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'gh_src', 'ref', 'source', 'ss', 'lever-source',
  ]);
  for (const param of Array.from(parsed.searchParams.keys())) {
    if (strip.has(param.toLowerCase())) parsed.searchParams.delete(param);
  }
  parsed.hash = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '').toLowerCase() || '/';
  return parsed.toString();
}

export async function syncNotionAppliedCache({ log = console.log } = {}) {
  const { token, databaseId, configured } = loadNotionEnv();
  if (!configured) {
    throw new Error(
      'Notion not configured. Set NOTION_API_KEY (or NOTION_ACCESS_TOKEN) and NOTION_DATABASE_ID.',
    );
  }
  const pages = await notionQueryAll(token, databaseId);
  const urls = new Set();
  const companyRoles = new Set();
  let withUrl = 0;
  let excludedByStatus = 0;
  for (const page of pages) {
    const rec = extractRecord(page);
    if (!shouldSkipStatus(rec.status)) {
      excludedByStatus++;
      continue;
    }
    if (rec.url && /^https?:\/\//i.test(rec.url)) {
      urls.add(normalizeUrl(rec.url));
      withUrl++;
    }
    if (rec.company && rec.role) {
      companyRoles.add(`${rec.company.toLowerCase()}::${rec.role.toLowerCase()}`);
    }
  }
  mkdirSync(DATA, { recursive: true });
  const payload = {
    syncedAt: new Date().toISOString(),
    databaseId,
    urlCount: urls.size,
    companyRoleCount: companyRoles.size,
    pagesScanned: pages.length,
    withUrl,
    excludedByStatus,
    urls: [...urls],
    companyRoles: [...companyRoles],
  };
  writeFileSync(CACHE_PATH, JSON.stringify(payload, null, 2));
  log(
    `Notion applied: ${urls.size} URLs, ${companyRoles.size} company+role (${pages.length} pages, ${excludedByStatus} open-again excluded)`,
  );
  return payload;
}

export function readNotionAppliedCache() {
  if (!existsSync(CACHE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

export function cacheAgeHours(cache = readNotionAppliedCache()) {
  if (!cache?.syncedAt) return Infinity;
  const t = Date.parse(cache.syncedAt);
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / 3_600_000;
}

/**
 * Resolve filter settings from portals.yml notion_applied_filter + env.
 * enabled: true | false | 'auto' (default auto = on when credentials exist)
 */
export function resolveNotionFilterConfig(portalsConfig = {}) {
  const block = portalsConfig.notion_applied_filter || {};
  const { configured } = loadNotionEnv();
  let enabled = block.enabled;
  if (enabled === undefined || enabled === 'auto') enabled = configured;
  return {
    enabled: Boolean(enabled),
    syncMaxAgeHours: Number(block.sync_max_age_hours ?? 12),
    configured,
  };
}

/**
 * Ensure cache is fresh enough, then return { urls: Set, companyRoles: Set }.
 * No-op empty sets when filter disabled or unconfigured.
 */
export async function loadNotionAppliedSets(portalsConfig = {}, { log = console.log, forceSync = false } = {}) {
  const cfg = resolveNotionFilterConfig(portalsConfig);
  if (!cfg.enabled) return { urls: new Set(), companyRoles: new Set(), active: false };

  let cache = readNotionAppliedCache();
  const stale = !cache || cacheAgeHours(cache) > cfg.syncMaxAgeHours;
  if (forceSync || stale) {
    if (!cfg.configured) {
      log('Notion applied filter enabled but credentials missing — skipping Notion gate.');
      return { urls: new Set(), companyRoles: new Set(), active: false };
    }
    try {
      cache = await syncNotionAppliedCache({ log });
    } catch (e) {
      log(`Notion sync failed (${e.message}) — using ${cache ? 'stale cache' : 'empty set'}.`);
    }
  }
  if (!cache) return { urls: new Set(), companyRoles: new Set(), active: false };
  return {
    urls: new Set(cache.urls || []),
    companyRoles: new Set(cache.companyRoles || []),
    active: true,
    cache,
  };
}

export function isNotionApplied(job, sets, normalizeUrlFn = normalizeUrl) {
  if (!sets?.active) return false;
  const url = job?.url || job;
  if (typeof url === 'string' && url.startsWith('http')) {
    if (sets.urls.has(normalizeUrlFn(url))) return true;
  }
  const company = String(job?.company || '').trim().toLowerCase();
  const role = String(job?.title || job?.role || '').trim().toLowerCase();
  if (company && role && sets.companyRoles.has(`${company}::${role}`)) return true;
  return false;
}

export function filterPipelineAgainstNotion(normalizeUrlFn = normalizeUrl) {
  const cache = readNotionAppliedCache();
  if (!cache?.urls?.length) {
    return { removed: 0, reason: 'empty-cache' };
  }
  const urlSet = new Set(cache.urls);
  if (!existsSync(PIPELINE)) return { removed: 0, reason: 'no-pipeline' };
  const lines = readFileSync(PIPELINE, 'utf8').split(/\r?\n/);
  const kept = [];
  let removed = 0;
  const removedLines = [];
  for (const line of lines) {
    const unchecked = /^\s*-\s*\[\s*\]\s*/.test(line);
    if (!unchecked) {
      kept.push(line);
      continue;
    }
    const m = line.match(/https?:\/\/[^\s)\]]+/i);
    if (!m) {
      kept.push(line);
      continue;
    }
    const key = normalizeUrlFn(m[0].replace(/[.,;]+$/, ''));
    if (urlSet.has(key)) {
      removed++;
      removedLines.push(line.trim().slice(0, 140));
      // Move to processed as skipped rather than silent delete
      kept.push(
        line.replace(/^\s*-\s*\[\s*\]\s*/, '- [x] ').replace(/\s*$/, '')
          + ' — skipped (already applied — Notion)',
      );
      continue;
    }
    kept.push(line);
  }
  writeFileSync(PIPELINE, kept.join('\n').replace(/\n*$/, '\n'));
  return { removed, removedLines };
}

// ── CLI ─────────────────────────────────────────────────────────────
async function main() {
  const cmd = process.argv[2] || 'help';
  const arg = process.argv[3];
  if (cmd === 'sync') {
    await syncNotionAppliedCache();
    return;
  }
  if (cmd === 'filter-pipeline') {
    const { token, databaseId, configured } = loadNotionEnv();
    if (configured && (!readNotionAppliedCache() || cacheAgeHours() > 12)) {
      await syncNotionAppliedCache();
    } else if (!configured && !readNotionAppliedCache()) {
      console.error('No Notion credentials and no cache. Nothing to filter.');
      process.exit(1);
    }
    const { normalizeUrlForDedup } = await import('./scan.mjs');
    const r = filterPipelineAgainstNotion(normalizeUrlForDedup);
    console.log(`filter-pipeline: marked ${r.removed} already-applied pending URL(s)`);
    for (const l of (r.removedLines || []).slice(0, 15)) console.log(`  ${l}`);
    return;
  }
  if (cmd === 'check') {
    if (!arg) {
      console.error('Usage: check <url>');
      process.exit(2);
    }
    const cache = readNotionAppliedCache();
    if (!cache) {
      console.error('No cache — run: node notion-applied.mjs sync');
      process.exit(1);
    }
    const { normalizeUrlForDedup } = await import('./scan.mjs');
    const hit = (cache.urls || []).includes(normalizeUrlForDedup(arg));
    console.log(hit ? `APPLIED (Notion): ${arg}` : `not applied in Notion cache: ${arg}`);
    process.exit(hit ? 0 : 1);
  }
  console.log(`Usage:
  node notion-applied.mjs sync
  node notion-applied.mjs filter-pipeline
  node notion-applied.mjs check <url>`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
