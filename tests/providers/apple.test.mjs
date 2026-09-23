// Apple Jobs provider contract. The mutations this catches are: removing
// jobs.apple.com host pinning, failing to preserve configurable search filters,
// or emitting broken/dedup-unsafe postings from Apple search results.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — Apple Jobs');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/apple.mjs')).href);
  const apple = mod.default;
  const { parseAppleResponse } = mod;

  if (apple.id === 'apple') pass('apple.id is "apple"');
  else fail(`apple.id is ${JSON.stringify(apple.id)}`);

  if (apple.detect({ name: 'Apple', careers_url: 'https://jobs.apple.com/en-us/search' })) {
    pass('apple.detect() claims the public jobs.apple.com board');
  } else {
    fail('apple.detect() should claim jobs.apple.com');
  }
  if (apple.detect({ name: 'Spoof', careers_url: 'https://example.test/jobs.apple.com/en-us/search' }) === null) {
    pass('apple.detect() rejects a path-spoofed board URL');
  } else {
    fail('apple.detect() must not claim a URL that only contains jobs.apple.com in its path');
  }

  const parsed = parseAppleResponse({
    res: {
      searchResults: [
        {
          id: 'REQ 123',
          postingTitle: '  Machine Learning Engineer  ',
          transformedPostingTitle: 'machine-learning-engineer',
          locations: [{ name: 'Cupertino' }, { city: 'Austin' }, { name: 'Cupertino' }],
          postingDate: '2026-06-01T00:00:00Z',
        },
        { id: '\uD800', postingTitle: 'Bad identifier', locations: [] },
        { postingTitle: 'No identifier', locations: [] },
        { id: 'REQ 124', postingTitle: '   ', locations: [] },
      ],
    },
  }, 'Apple');

  if (parsed.length === 1) pass('parseAppleResponse drops malformed identifiers and title-less rows');
  else fail(`parseAppleResponse returned ${parsed.length} jobs, expected 1`);
  const job = parsed[0];
  if (job?.url === 'https://jobs.apple.com/en-us/details/REQ%20123/machine-learning-engineer') {
    pass('parseAppleResponse builds an encoded canonical Apple posting URL');
  } else {
    fail(`Apple posting URL was ${JSON.stringify(job?.url)}`);
  }
  if (job?.location === 'Cupertino, Austin' && job?.company === 'Apple' && job?.postedAt === Date.parse('2026-06-01T00:00:00Z')) {
    pass('parseAppleResponse normalizes location, company, and posting date');
  } else {
    fail(`Apple job mapping was ${JSON.stringify(job)}`);
  }
  let malformedThrew = false;
  try { parseAppleResponse({ res: { unexpected: [] } }, 'Apple'); } catch { malformedThrew = true; }
  if (malformedThrew) pass('parseAppleResponse surfaces an unexpected API shape instead of returning an empty board');
  else fail('parseAppleResponse must throw for a non-empty response without searchResults');

  const requests = [];
  const pages = [
    { res: { searchResults: [{ id: 'R1', postingTitle: 'AI Engineer', locations: [{ name: 'Remote' }] }] } },
    { res: { searchResults: [] } },
  ];
  const jobs = await apple.fetch({
    name: 'Apple',
    careers_url: 'https://jobs.apple.com/en-us/search',
    keywords: ['AI Engineer'],
    max_pages: 5,
    apple: { locale: 'de-de', location_ids: ['postLocation-DEU'] },
  }, {
    async fetchJson(url, opts) {
      requests.push({ url, opts });
      return pages.shift();
    },
  });
  const firstBody = JSON.parse(requests[0]?.opts?.body || '{}');
  if (requests.length === 2 && requests.every(r => r.url === 'https://jobs.apple.com/api/v1/search' && r.opts?.method === 'POST' && r.opts?.redirect === 'error')) {
    pass('apple.fetch() uses the fixed public API with POST and redirect protection');
  } else {
    fail(`Apple requests were ${JSON.stringify(requests)}`);
  }
  if (firstBody.query === 'AI Engineer' && firstBody.page === 1 && firstBody.locale === 'de-de'
      && JSON.stringify(firstBody.filters?.locations) === JSON.stringify(['postLocation-DEU'])) {
    pass('apple.fetch() sends the configured keyword, locale, and Apple location IDs');
  } else {
    fail(`Apple search body was ${JSON.stringify(firstBody)}`);
  }
  if (jobs.length === 1 && jobs[0].url.endsWith('/R1/ai-engineer')) {
    pass('apple.fetch() returns normalized results and stops at the empty page');
  } else {
    fail(`apple.fetch() returned ${JSON.stringify(jobs)}`);
  }
} catch (err) {
  fail(`apple provider tests crashed: ${err.message}`);
}
