// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Apple Jobs provider — reads Apple’s public search API (no auth, login, or
// browser required). It auto-detects the public jobs.apple.com board.
//
// Optional portals.yml entry fields:
//   keywords: ["Machine Learning", "Software Engineer"]
//   max_pages: 20
//   apple:
//     locale: en-us
//     location_ids: [postLocation-USA]

import { sleep } from './_http.mjs';
import { safeEncodeURIComponent } from './_safe-url.mjs';

const BOARD_HOST = 'jobs.apple.com';
const API_URL = `https://${BOARD_HOST}/api/v1/search`;
const DETAIL_ROOT = `https://${BOARD_HOST}/en-us/details`;
const DEFAULT_LOCALE = 'en-us';
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
  if (!value) return undefined;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? undefined : parsed;
}

function titleSlug(value) {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'job';
}

function locationNames(value) {
  if (!Array.isArray(value)) return '';
  const names = [];
  for (const location of value) {
    if (!location || typeof location !== 'object') continue;
    const name = typeof location.name === 'string'
      ? location.name.trim()
      : typeof location.city === 'string' ? location.city.trim() : '';
    if (name && !names.includes(name)) names.push(name);
  }
  return names.join(', ');
}

function responseResults(json) {
  if (json == null || (typeof json === 'object' && !Array.isArray(json) && Object.keys(json).length === 0)) return [];
  const body = json && typeof json.res === 'object' && !Array.isArray(json.res) ? json.res : json;
  if (body == null || (typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0)) return [];
  if (!Array.isArray(body.searchResults)) {
    const keys = body && typeof body === 'object' ? Object.keys(body).join(', ') : typeof body;
    throw new Error(`apple: unexpected API response — expected searchResults[], got keys: [${keys}]`);
  }
  return body.searchResults;
}

/**
 * Normalize one Apple search response. Exported for the provider contract test.
 * @param {any} json
 * @param {string} companyName
 * @returns {import('./_types.js').Job[]}
 */
export function parseAppleResponse(json, companyName) {
  const jobs = [];
  for (const item of responseResults(json)) {
    if (!item || typeof item !== 'object') continue;
    const rawId = item.id ?? item.jobNumber ?? item.reqId;
    if (rawId == null || String(rawId).trim() === '') continue;
    const id = String(rawId).trim();
    const encodedId = safeEncodeURIComponent(id);
    const title = typeof item.postingTitle === 'string'
      ? item.postingTitle.trim()
      : typeof item.title === 'string' ? item.title.trim() : '';
    if (!encodedId || !title) continue;
    const transformedTitle = typeof item.transformedPostingTitle === 'string' && item.transformedPostingTitle.trim()
      ? item.transformedPostingTitle.trim()
      : titleSlug(title);
    const encodedTitle = safeEncodeURIComponent(transformedTitle);
    if (!encodedTitle) continue;
    const job = {
      title,
      url: `${DETAIL_ROOT}/${encodedId}/${encodedTitle}`,
      company: companyName,
      location: locationNames(item.locations ?? item.localeLocation),
    };
    const postedAt = toEpochMs(item.postingDate ?? item.postDateInGMT);
    if (postedAt !== undefined) job.postedAt = postedAt;
    jobs.push(job);
  }
  return jobs;
}

function buildSearchBody(keyword, page, entry) {
  const cfg = entry?.apple && typeof entry.apple === 'object' ? entry.apple : {};
  const locale = typeof cfg.locale === 'string' && cfg.locale.trim() ? cfg.locale.trim() : DEFAULT_LOCALE;
  return JSON.stringify({
    query: keyword,
    filters: { locations: cleanStrings(cfg.location_ids) },
    page,
    locale,
    sort: 'newest',
    format: { longDate: 'MMMM D, YYYY', mediumDate: 'MMM D, YYYY' },
  });
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
  id: 'apple',

  detect(entry) {
    const url = entry?.api || entry?.careers_url;
    if (typeof url !== 'string') return null;
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' && parsed.hostname === BOARD_HOST ? { url } : null;
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
      for (let page = 1; page <= maxPages; page++) {
        if (firstRequest) firstRequest = false;
        else await sleep(INTER_PAGE_DELAY_MS, ctx);
        const json = await ctx.fetchJson(API_URL, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            origin: `https://${BOARD_HOST}`,
          },
          body: buildSearchBody(keyword, page, entry),
          redirect: 'error',
        });
        const records = responseResults(json);
        for (const job of parseAppleResponse(json, entry?.name || 'Apple')) {
          if (!seen.has(job.url)) seen.set(job.url, job);
        }
        if (records.length === 0) break;
      }
    }
    return [...seen.values()];
  },
};
