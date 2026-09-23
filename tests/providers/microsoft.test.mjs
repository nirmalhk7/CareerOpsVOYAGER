// Microsoft Careers provider contract. The mutations this catches are: missing
// careers.microsoft.com host pinning, wrong query pagination, or unsafe/missing
// normalized posting URLs from PCS API records.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — Microsoft Careers');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/microsoft.mjs')).href);
  const microsoft = mod.default;
  const { parseMicrosoftResponse } = mod;

  if (microsoft.id === 'microsoft') pass('microsoft.id is "microsoft"');
  else fail(`microsoft.id is ${JSON.stringify(microsoft.id)}`);

  if (microsoft.detect({ name: 'Microsoft', careers_url: 'https://apply.careers.microsoft.com/careers' })) {
    pass('microsoft.detect() claims apply.careers.microsoft.com');
  } else {
    fail('microsoft.detect() should claim the Microsoft Careers board');
  }
  if (microsoft.detect({ name: 'Spoof', careers_url: 'https://example.test/apply.careers.microsoft.com/careers' }) === null) {
    pass('microsoft.detect() rejects a path-spoofed board URL');
  } else {
    fail('microsoft.detect() must not claim a URL that only contains the Microsoft hostname in its path');
  }

  const parsed = parseMicrosoftResponse({
    data: {
      count: 2,
      positions: [
        {
          id: '123 456', name: '  Principal Applied Scientist  ',
          standardizedLocations: ['Redmond, Washington', 'Remote'],
          postedTs: 1717200000000,
        },
        { id: '\uD800', name: 'Bad identifier', locations: ['Seattle'] },
        { name: 'No identifier', locations: ['Seattle'] },
        { id: '789', name: '   ', locations: ['Seattle'] },
      ],
    },
  }, 'Microsoft');
  if (parsed.jobs.length === 1 && parsed.count === 2) pass('parseMicrosoftResponse preserves the API count and drops malformed rows');
  else fail(`Microsoft parsed payload was ${JSON.stringify(parsed)}`);
  const job = parsed.jobs[0];
  if (job?.url === 'https://apply.careers.microsoft.com/careers/job/123%20456') {
    pass('parseMicrosoftResponse builds an encoded canonical Careers URL');
  } else {
    fail(`Microsoft posting URL was ${JSON.stringify(job?.url)}`);
  }
  if (job?.title === 'Principal Applied Scientist' && job?.location === 'Redmond, Washington, Remote'
      && job?.postedAt === 1717200000000 && job?.company === 'Microsoft') {
    pass('parseMicrosoftResponse normalizes title, locations, date, and company');
  } else {
    fail(`Microsoft job mapping was ${JSON.stringify(job)}`);
  }
  let malformedThrew = false;
  try { parseMicrosoftResponse({ data: { other: [] } }, 'Microsoft'); } catch { malformedThrew = true; }
  if (malformedThrew) pass('parseMicrosoftResponse surfaces an unexpected API shape instead of returning an empty board');
  else fail('parseMicrosoftResponse must throw for a non-empty response without positions');

  const calls = [];
  const pages = [
    { data: { count: 3, positions: [
      { id: '1', name: 'AI Engineer', locations: ['Redmond'] },
      { id: '2', name: 'ML Engineer', locations: ['Remote'] },
    ] } },
    { data: { count: 3, positions: [{ id: '3', name: 'Research Engineer', locations: ['Cambridge'] }] } },
  ];
  const jobs = await microsoft.fetch({
    name: 'Microsoft',
    careers_url: 'https://apply.careers.microsoft.com/careers',
    keywords: ['AI'],
    microsoft: { location: 'United States' },
  }, {
    async fetchJson(url, opts) {
      calls.push({ url, opts });
      return pages.shift();
    },
  });
  const firstUrl = new URL(calls[0]?.url);
  const secondUrl = new URL(calls[1]?.url);
  if (calls.length === 2 && calls.every(c => c.opts?.redirect === 'error')
      && firstUrl.origin === 'https://apply.careers.microsoft.com' && firstUrl.pathname === '/api/pcsx/search') {
    pass('microsoft.fetch() uses the fixed public PCS endpoint with redirect protection');
  } else {
    fail(`Microsoft requests were ${JSON.stringify(calls)}`);
  }
  if (firstUrl.searchParams.get('domain') === 'microsoft.com' && firstUrl.searchParams.get('query') === 'AI'
      && firstUrl.searchParams.get('location') === 'United States' && firstUrl.searchParams.get('start') === '0'
      && secondUrl.searchParams.get('start') === '2') {
    pass('microsoft.fetch() sends configured query/location and advances by returned records');
  } else {
    fail(`Microsoft query URLs were ${calls.map(c => c.url).join(', ')}`);
  }
  const requestHeaders = calls[0]?.opts?.headers || {};
  if (requestHeaders.origin === 'https://apply.careers.microsoft.com'
      && requestHeaders.referer === 'https://apply.careers.microsoft.com/careers?query=AI&location=United+States'
      && requestHeaders['sec-fetch-site'] === 'same-origin'
      && requestHeaders['sec-fetch-mode'] === 'cors') {
    pass('microsoft.fetch() supplies the public Careers request context required by the PCS endpoint');
  } else {
    fail(`Microsoft request headers were ${JSON.stringify(requestHeaders)}`);
  }
  if (jobs.length === 3 && jobs[2]?.url.endsWith('/3')) {
    pass('microsoft.fetch() collects every page through the reported total');
  } else {
    fail(`microsoft.fetch() returned ${JSON.stringify(jobs)}`);
  }
} catch (err) {
  fail(`microsoft provider tests crashed: ${err.message}`);
}
