import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildFeedUrl,
  classifyFeedResponse,
  extractNextCursor,
  FEED_USER_AGENT,
  formatFeedTimestamp,
  normaliseRelease,
  normaliseReleases,
  parseRetryAfter,
  pullFeedWindow,
  stageFromTags,
} from './tender-ingest.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const ftsPage = fixture('tender-fts-page.json');
const cfPage = fixture('tender-cf-page.json');

test('formats feed timestamps without milliseconds or offsets', () => {
  assert.equal(formatFeedTimestamp('2026-10-20T09:15:30.123Z'), '2026-10-20T09:15:30');
  assert.equal(formatFeedTimestamp('2026-10-20T10:15:30+01:00'), '2026-10-20T09:15:30');
  assert.throws(() => formatFeedTimestamp('not a date'), /Invalid feed timestamp/u);
});

test('builds Find a Tender URLs with updated window, capped limit and cursor', () => {
  const url = new URL(buildFeedUrl('fts', {
    from: '2026-10-20T00:00:00Z', to: '2026-10-21T00:00:00Z', limit: 500, cursor: 'abc', stages: ['tender', 'award'],
  }));
  assert.equal(url.origin + url.pathname, 'https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages');
  assert.equal(url.searchParams.get('updatedFrom'), '2026-10-20T00:00:00');
  assert.equal(url.searchParams.get('updatedTo'), '2026-10-21T00:00:00');
  assert.equal(url.searchParams.get('limit'), '100');
  assert.equal(url.searchParams.get('cursor'), 'abc');
  assert.equal(url.searchParams.get('stages'), 'tender,award');
});

test('builds Contracts Finder URLs that always carry publishedTo', () => {
  const url = new URL(buildFeedUrl('cf', { from: '2026-10-20T00:00:00Z', to: '2026-10-21T00:00:00Z' }));
  assert.equal(url.origin + url.pathname, 'https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search');
  assert.equal(url.searchParams.get('publishedFrom'), '2026-10-20T00:00:00');
  assert.equal(url.searchParams.get('publishedTo'), '2026-10-21T00:00:00');
  assert.equal(url.searchParams.get('stages'), null);
  assert.throws(() => buildFeedUrl('cf', { from: '2026-10-20T00:00:00Z' }), /both a from and a to/u);
});

test('honours a base URL override for testing', () => {
  const url = buildFeedUrl('fts', { baseUrl: 'http://127.0.0.1:9999', from: '2026-10-20', to: '2026-10-21' });
  assert.match(url, /^http:\/\/127\.0\.0\.1:9999\/api\/1\.0\/ocdsReleasePackages\?/u);
  assert.throws(() => buildFeedUrl('xx', { from: 1, to: 2 }), /Unknown tender source/u);
});

test('parses Retry-After seconds and HTTP dates, capped and never negative', () => {
  const now = Date.parse('2026-10-20T00:00:00Z');
  assert.equal(parseRetryAfter('12', { now }), 12000);
  assert.equal(parseRetryAfter('Tue, 20 Oct 2026 00:00:30 GMT', { now }), 30000);
  assert.equal(parseRetryAfter('Mon, 19 Oct 2026 00:00:00 GMT', { now }), 0);
  assert.equal(parseRetryAfter('99999', { now }), 120000);
  assert.equal(parseRetryAfter(undefined, { now }), 6000);
});

test('reads the next cursor from links.next', () => {
  assert.match(extractNextCursor(ftsPage), /^dXBk/u);
  assert.equal(extractNextCursor({ releases: [] }), null);
  assert.equal(extractNextCursor({ links: { next: 'not a url' } }), null);
});

test('classifies non-JSON, error and 429 responses as failures, never empty', () => {
  assert.equal(classifyFeedResponse({ status: 200, bodyText: '<html>Service down</html>' }).kind, 'failed');
  assert.match(classifyFeedResponse({ status: 200, bodyText: '' }).error, /not JSON/u);
  assert.match(classifyFeedResponse({ status: 200, bodyText: '{"uri":"x"}' }).error, /no releases array/u);
  assert.equal(classifyFeedResponse({ status: 500, bodyText: 'oops' }).kind, 'failed');
  const limited = classifyFeedResponse({ status: 429, headers: { 'retry-after': '7' }, bodyText: 'slow down' });
  assert.deepEqual([limited.kind, limited.retryAfterMs], ['retry', 7000]);
  const headers = new Headers({ 'Retry-After': '3' });
  assert.equal(classifyFeedResponse({ status: 503, headers, bodyText: '' }).retryAfterMs, 3000);
  const ok = classifyFeedResponse({ status: 200, bodyText: JSON.stringify(ftsPage) });
  assert.equal(ok.kind, 'ok');
  assert.equal(ok.releases.length, 3);
  assert.ok(ok.nextCursor);
  assert.equal(classifyFeedResponse({ status: 200, bodyText: '{"releases":[]}' }).kind, 'ok');
});

test('maps OCDS tags to the most advanced stage', () => {
  assert.equal(stageFromTags(['award', 'contract']), 'contract');
  assert.equal(stageFromTags(['tenderAmendment']), 'tender');
  assert.equal(stageFromTags(['planningUpdate']), 'planning');
  assert.equal(stageFromTags(['awardUpdate', 'tender']), 'award');
  assert.equal(stageFromTags(['compiled']), null);
  assert.equal(stageFromTags(undefined), null);
});

test('normalises a Find a Tender open tender', () => {
  const notice = normaliseRelease(ftsPage.releases[2], 'fts');
  assert.equal(notice.ocid, 'ocds-h6vhtk-078c53');
  assert.equal(notice.source, 'fts');
  assert.equal(notice.release_id, '099223-2026');
  assert.equal(notice.stage, 'tender');
  assert.equal(notice.tender_status, 'active');
  assert.equal(notice.title, 'General Groundworks and Landscaping Works');
  assert.deepEqual(notice.cpv_codes, ['45000000']);
  assert.deepEqual(notice.regions, ['UKD37']);
  assert.equal(notice.value_amount, 240000);
  assert.equal(notice.value_currency, 'GBP');
  assert.equal(notice.tender_deadline, '2026-12-02T12:00:00.000Z');
  assert.equal(notice.contract_start, '2027-04-01');
  assert.equal(notice.contract_end, '2031-03-31');
  assert.equal(notice.notice_url, 'https://www.find-tender.service.gov.uk/Notice/099223-2026');
  assert.equal(notice.source_updated_at, '2026-10-20T17:19:49.000Z');
  assert.equal(notice.is_framework_or_dps, false);
  assert.deepEqual(notice.award_suppliers, []);
  assert.equal(notice.raw, ftsPage.releases[2]);
});

test('normalises a Find a Tender planning notice with a framework flag', () => {
  const notice = normaliseRelease(ftsPage.releases[1], 'fts');
  assert.equal(notice.stage, 'planning');
  assert.equal(notice.buyer_name, 'YORKSHIRE WATER SERVICES LIMITED');
  assert.deepEqual(notice.cpv_codes, ['45232410', '45232440', '50511000', '90400000']);
  assert.deepEqual(notice.regions, ['UKE']);
  assert.equal(notice.is_framework_or_dps, true);
  assert.equal(notice.tender_deadline, null);
  assert.equal(notice.contract_end, '2030-08-02');
});

test('normalises a Find a Tender award with suppliers and award-item CPVs', () => {
  const notice = normaliseRelease(ftsPage.releases[0], 'fts');
  assert.equal(notice.stage, 'contract');
  assert.equal(notice.buyer_name, 'Surrey County Council');
  assert.deepEqual(notice.cpv_codes, ['60000000']);
  assert.deepEqual(notice.regions, ['UKJ26'], 'falls back to the buyer region when there is no delivery region');
  assert.deepEqual(notice.postcodes, ['RH2 8EF']);
  assert.deepEqual(notice.award_suppliers, [{ id: 'GB-FTS-9007', name: 'ANGEL CARS (WOKING) LTD' }]);
});

test('normalises a Contracts Finder award, ignoring undisclosed zero values', () => {
  const notice = normaliseRelease(cfPage.releases[0], 'cf');
  assert.equal(notice.source, 'cf');
  assert.equal(notice.stage, 'award');
  assert.deepEqual(notice.cpv_codes, ['80000000']);
  assert.deepEqual(notice.postcodes, ['TF3 4JA']);
  assert.deepEqual(notice.regions, []);
  assert.equal(notice.value_amount, null);
  assert.equal(notice.buyer_name, 'Telford and Wrekin Council');
  assert.equal(notice.notice_url, 'https://www.contractsfinder.service.gov.uk/Notice/ad8d669c-5eb1-49cf-845c-fc8805aa4ce5');
  assert.equal(notice.tender_deadline, '2026-10-09T16:00:00.000Z');
});

test('derives a Contracts Finder notice URL from the release id when no document links it', () => {
  const release = { ...cfPage.releases[1], awards: [] };
  assert.equal(
    normaliseRelease(release, 'cf').notice_url,
    'https://www.contractsfinder.service.gov.uk/Notice/277391c9-03e3-4209-bfb9-2c7227c84beb',
  );
});

test('strips CPV check digits, sums lot values and drops releases without identifiers', () => {
  const notice = normaliseRelease({
    ocid: 'ocds-test-1',
    id: 'r1',
    date: 'garbage',
    tag: ['tender'],
    tender: {
      classification: { scheme: 'CPV', id: '45442100-8' },
      items: [{ additionalClassifications: [{ scheme: 'CPV', id: '45442100' }, { scheme: 'CPVS', id: 'AA01' }] }],
      lots: [{ value: { amount: 1000, currency: 'GBP' } }, { value: { amount: 500, currency: 'GBP' } }],
      techniques: { hasDynamicPurchasingSystem: true },
    },
  }, 'cf');
  assert.deepEqual(notice.cpv_codes, ['45442100']);
  assert.equal(notice.value_amount, 1500);
  assert.equal(notice.is_framework_or_dps, true);
  assert.equal(notice.source_updated_at, null);
  assert.equal(normaliseRelease({ id: 'x' }, 'fts'), null);
  assert.equal(normaliseRelease(null, 'fts'), null);
  assert.deepEqual(normaliseReleases([{ ocid: 'a' }, ftsPage.releases[0]], 'fts').skipped, 1);
});

function fakeFeed(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    assert.equal(init.headers['user-agent'], FEED_USER_AGENT);
    assert.doesNotMatch(FEED_USER_AGENT, /deno/iu);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return new Response(next.body, { status: next.status ?? 200, headers: next.headers });
  };
  return { calls, fetchImpl };
}

function clock() {
  let t = Date.parse('2026-10-20T00:00:00Z');
  const sleeps = [];
  return { sleeps, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } };
}

const page = (releases, next) => JSON.stringify({ releases, links: next ? { next: `https://x.test/?cursor=${next}` } : {} });
const window = { from: '2026-10-20T00:00:00Z', to: '2026-10-21T00:00:00Z' };

test('pulls every page, throttling one request per interval', async () => {
  const { calls, fetchImpl } = fakeFeed([
    { body: page(ftsPage.releases.slice(0, 2), 'c2') },
    { body: page(ftsPage.releases.slice(2), null) },
  ]);
  const c = clock();
  const result = await pullFeedWindow({ source: 'fts', ...window, fetchImpl, ...c });
  assert.equal(result.status, 'ok');
  assert.equal(result.pages, 2);
  assert.equal(result.fetched, 3);
  assert.equal(result.notices.length, 3);
  assert.deepEqual(result.httpStatuses, [200, 200]);
  assert.equal(result.nextCursor, null);
  assert.equal(new URL(calls[1]).searchParams.get('cursor'), 'c2');
  assert.deepEqual(c.sleeps, [6000]);
});

test('reports a genuinely empty window as empty', async () => {
  const { fetchImpl } = fakeFeed([{ body: page([], null) }]);
  const result = await pullFeedWindow({ source: 'cf', ...window, fetchImpl, ...clock() });
  assert.equal(result.status, 'empty');
  assert.equal(result.error, null);
});

test('reports an HTML error page as failed, not empty', async () => {
  const { fetchImpl } = fakeFeed([{ body: '<html>maintenance</html>', headers: { 'content-type': 'text/html' } }]);
  const result = await pullFeedWindow({ source: 'cf', ...window, fetchImpl, ...clock() });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /not JSON/u);
  assert.deepEqual(result.notices, []);
});

test('retries 429 honouring Retry-After, then succeeds', async () => {
  const { fetchImpl } = fakeFeed([
    { status: 429, body: 'slow down', headers: { 'retry-after': '20' } },
    { body: page(cfPage.releases, null) },
  ]);
  const c = clock();
  const result = await pullFeedWindow({ source: 'cf', ...window, fetchImpl, ...c });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.httpStatuses, [429, 200]);
  assert.deepEqual(c.sleeps, [20000]);
});

test('gives up after three retries and reports failed', async () => {
  const busy = () => ({ status: 503, body: '', headers: { 'retry-after': '1' } });
  const { calls, fetchImpl } = fakeFeed([busy(), busy(), busy(), busy()]);
  const result = await pullFeedWindow({ source: 'fts', ...window, fetchImpl, ...clock() });
  assert.equal(calls.length, 4);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /after 3 retries/u);
  assert.equal(result.httpStatus, 503);
});

test('retries network errors', async () => {
  const { fetchImpl } = fakeFeed([new Error('ECONNRESET'), { body: page([], null) }]);
  const result = await pullFeedWindow({ source: 'fts', ...window, fetchImpl, ...clock() });
  assert.equal(result.status, 'empty');
  assert.deepEqual(result.httpStatuses, [null, 200]);
});

test('marks a mid-window failure partial and keeps the resume cursor', async () => {
  const { fetchImpl } = fakeFeed([
    { body: page(ftsPage.releases.slice(0, 1), 'c2') },
    { status: 500, body: 'boom' },
  ]);
  const result = await pullFeedWindow({ source: 'fts', ...window, fetchImpl, ...clock() });
  assert.equal(result.status, 'partial');
  assert.equal(result.nextCursor, 'c2');
  assert.equal(result.notices.length, 1);
});

test('stops at maxPages with status partial and a resume cursor', async () => {
  const { calls, fetchImpl } = fakeFeed([{ body: page(ftsPage.releases.slice(0, 1), 'c2') }]);
  const result = await pullFeedWindow({ source: 'fts', ...window, maxPages: 1, fetchImpl, ...clock() });
  assert.equal(calls.length, 1);
  assert.equal(result.status, 'partial');
  assert.equal(result.nextCursor, 'c2');
});

test('stops when the feed repeats the same cursor', async () => {
  const { calls, fetchImpl } = fakeFeed([
    { body: page(ftsPage.releases.slice(0, 1), 'same') },
    { body: page(ftsPage.releases.slice(1, 2), 'same') },
  ]);
  const result = await pullFeedWindow({ source: 'fts', ...window, fetchImpl, ...clock() });
  assert.equal(calls.length, 2);
  assert.equal(result.status, 'ok');
});

test('hands pages to onPage and turns storage errors into failed or partial', async () => {
  const stored = [];
  const ok = fakeFeed([{ body: page(ftsPage.releases.slice(0, 1), 'c2') }, { body: page(ftsPage.releases.slice(1), null) }]);
  const done = await pullFeedWindow({
    source: 'fts', ...window, fetchImpl: ok.fetchImpl, ...clock(), onPage: ({ notices }) => { stored.push(...notices); },
  });
  assert.equal(done.status, 'ok');
  assert.equal(stored.length, 3);
  assert.deepEqual(done.notices, []);

  const broken = fakeFeed([{ body: page(ftsPage.releases.slice(0, 1), 'c2') }, { body: page(ftsPage.releases.slice(1), null) }]);
  let calls = 0;
  const result = await pullFeedWindow({
    source: 'fts', ...window, fetchImpl: broken.fetchImpl, ...clock(),
    onPage: () => { calls += 1; if (calls === 2) throw new Error('db down'); },
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.pages, 1);
  assert.equal(result.nextCursor, 'c2');
  assert.match(result.error, /db down/u);
});
