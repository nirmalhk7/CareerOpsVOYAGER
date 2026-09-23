// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Microsoft Careers provider — reads Microsoft’s public PCS search API (no
// auth, login, or browser required). It auto-detects both public Microsoft
// careers hostnames and always queries the fixed, public API host.
//
// Optional portals.yml entry fields:
//   keywords: ["Applied Scientist", "Machine Learning"]
//   max_pages: 20
//   microsoft:
//     location: United States

import { BROWSER_LIKE_USER_AGENT, sleep } from './_http.mjs';
import { safeEncodeURIComponent } from './_safe-url.mjs';

const CAREERS_HOSTS = new Set(['apply.careers.microsoft.com', 'jobs.careers.microsoft.com']);
const API_ROOT = 'https://apply.careers.microsoft.com';
const API_URL = `${API_ROOT}/api/pcsx/search`;
const DETAIL_ROOT = `${API_ROOT}/careers/job`;
const DEFAULT_KEYWORDS = [''];
const DEFAULT_MAX_PAGES = 20;
const MAX_PAGES_CAP = 100;
const INTER_PAGE_DELAY_MS = 250;

function cleanStrings(value) {
  return Array.isArray(value)
    ? value.filter(v => typeof v === 'string').map(v => v.trim()).filter(Boolean)
    : [];
}

function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 100_000_000_000 ? value * 1000 : value;
  if (!value) return undefined;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? undefined : parsed;
}

function responseData(json) {
  if (json == null || (typeof json === 'object' && !Array.isArray(json) && Object.keys(json).length === 0)) {
    return { positions: [], count: undefined };
  }
  const data = json && typeof json.data === 'object' && !Array.isArray(json.data) ? json.data : json;
  if (data == null || (typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length === 0)) {
    return { positions: [], count: undefined };
  }
  if (!Array.isArray(data.positions)) {
    const keys = data && typeof data === 'object' ? Object.keys(data).join(', ') : typeof data;
    throw new Error(`microsoft: unexpected API response — expected positions[], got keys: [${keys}]`);
  }
  return { positions: data.positions, count: Number.isFinite(data.count) ? data.count : undefined };
}

function locationNames(item) {
  const standardized = cleanStrings(item.standardizedLocations);
  return (standardized.length ? standardized : cleanStrings(item.locations)).join(', ');
}

/**
 * Normalize one PCS search response. Exported for the provider contract test.
 * @param {any} json
 * @param {string} companyName
 * @returns {{jobs: import('./_types.js').Job[], count: number|undefined}}
 */
export function parseMicrosoftResponse(json, companyName) {
  const { positions, count } = responseData(json);
  const jobs = [];
  for (const item of positions) {
    if (!item || typeof item !== 'object') continue;
    const rawId = item.id ?? item.positionId ?? item.atsJobId;
    if (rawId == null || String(rawId).trim() === '') continue;
    const id = String(rawId).trim();
    const encodedId = safeEncodeURIComponent(id);
    const title = typeof item.name === 'string' ? item.name.trim()
      : typeof item.title === 'string' ? item.title.trim() : '';
    if (!encodedId || !title) continue;
    const job = {
      title,
      url: `${DETAIL_ROOT}/${encodedId}`,
      company: companyName,
      location: locationNames(item),
    };
    const postedAt = toEpochMs(item.postedTs ?? item.postedDate);
    if (postedAt !== undefined) job.postedAt = postedAt;
    jobs.push(job);
  }
  return { jobs, count };
}

function locationFor(entry) {
  const cfg = entry?.microsoft && typeof entry.microsoft === 'object' ? entry.microsoft : {};
  return typeof cfg.location === 'string' ? cfg.location.trim() : '';
}

function buildSearchUrl(keyword, start, entry) {
  const location = locationFor(entry);
  const params = new URLSearchParams({ domain: 'microsoft.com', query: keyword, location, start: String(start) });
  return `${API_URL}?${params}`;
}

function buildHeaders(keyword, entry) {
  const refererParams = new URLSearchParams({ query: keyword, location: locationFor(entry) });
  return {
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/json',
    origin: API_ROOT,
    referer: `${API_ROOT}/careers?${refererParams}`,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    'user-agent': BROWSER_LIKE_USER_AGENT,
  };
}

function resolveMaxPages(entry, ctx) {
  const configured = Number.isInteger(entry?.max_pages) && entry.max_pages > 0
    ? Math.min(entry.max_pages, MAX_PAGES_CAP)
    : DEFAULT_MAX_PAGES;
  const probeCap = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0 ? ctx.maxPages : Infinity;
  return Math.min(configured, probeCap);
}

/** @type {Provider} */
export default {
  id: 'microsoft',

  detect(entry) {
    const url = entry?.api || entry?.careers_url;
    if (typeof url !== 'string') return null;
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' && CAREERS_HOSTS.has(parsed.hostname) ? { url } : null;
    } catch {
      return null;
    }
  },

  async fetch(entry, ctx) {
    const keywords = cleanStrings(entry?.keywords);
    const searchTerms = keywords.length ? keywords : DEFAULT_KEYWORDS;
    const maxPages = resolveMaxPages(entry, ctx);
    const seen = new Map();
    let firstRequest = true;

    for (const keyword of searchTerms) {
      let start = 0;
      for (let page = 0; page < maxPages; page++) {
        if (firstRequest) firstRequest = false;
        else await sleep(INTER_PAGE_DELAY_MS, ctx);
        const json = await ctx.fetchJson(buildSearchUrl(keyword, start, entry), {
          headers: buildHeaders(keyword, entry),
          redirect: 'error',
        });
        const { positions } = responseData(json);
        const { jobs, count } = parseMicrosoftResponse(json, entry?.name || 'Microsoft');
        for (const job of jobs) {
          if (!seen.has(job.url)) seen.set(job.url, job);
        }
        if (positions.length === 0) break;
        start += positions.length;
        if (count !== undefined && start >= count) break;
      }
    }
    return [...seen.values()];
  },
};
