import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  londonHour,
  parsePullRequest,
  planSourceWindow,
  RequestError,
  rescoreTenants,
  runTenderPull,
  secretMatches,
} from './tender-pull.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const ftsPage = fixture('tender-fts-page.json');
const cfPage = fixture('tender-cf-page.json');

// 05:30 Europe/London during BST is 04:30 UTC.
const fiveAmLondon = new Date('2026-10-20T04:30:00Z');
const sixAmLondon = new Date('2026-10-20T05:30:00Z');

function fakeDb({ runs = [], settings = [], leads = [], failIngest = false, failScores = false } = {}) {
  const state = { runs: runs.map((r, i) => ({ id: `old-${i}`, ...r })), notices: new Map(), leads: new Map(), ingests: 0 };
  for (const lead of leads) state.leads.set(`${lead.tenant_id}|${lead.ocid}`, lead);
  let nextId = 0;
  return {
    state,
    async recentRuns(source) { return state.runs.filter((r) => r.source === source); },
    async startRun(row) { const id = `run-${nextId += 1}`; state.runs.push({ id, started_at: new Date().toISOString(), ...row }); return id; },
    async finishRun(id, patch) { Object.assign(state.runs.find((r) => r.id === id), patch); },
    async ingest(notices) {
      if (failIngest) throw new Error('database unavailable');
      state.ingests += 1;
      const touched = [];
      let inserted = 0;
      for (const n of notices) {
        if (!state.notices.has(n.ocid)) inserted += 1;
        state.notices.set(n.ocid, n);
        touched.push(n.ocid);
      }
      return { received: notices.length, inserted, updated: notices.length - inserted, touched_ocids: touched };
    },
    async tenantSettings(ids) { return settings.filter((s) => !ids || ids.includes(s.tenant_id)); },
    async noticesByOcid(ocids) { return ocids.map((o) => state.notices.get(o)).filter(Boolean); },
    async* allNoticeBatches(size) {
      const all = [...state.notices.values()];
      for (let i = 0; i < all.length; i += size) yield all.slice(i, i + size);
    },
    async existingLeadOcids(tenantId, ocids) { return ocids.filter((o) => state.leads.has(`${tenantId}|${o}`)); },
    async upsertLeadScores(rows) {
      if (failScores) throw new Error('scores rejected');
      for (const row of rows) {
        const key = `${row.tenant_id}|${row.ocid}`;
        state.leads.set(key, { status: 'to_qualify', ...state.leads.get(key), ...row });
      }
    },
  };
}

function fakeFetch(bySource) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const source = url.includes('find-tender') ? 'fts' : 'cf';
    const next = bySource[source].shift();
    if (!next) throw new Error(`unexpected request ${url}`);
    return new Response(next.body, { status: next.status ?? 200, headers: next.headers });
  };
  return { calls, fetchImpl };
}

const page = (releases) => ({ body: JSON.stringify({ releases, links: {} }) });
const noSleep = { sleep: async () => {}, clock: () => Date.now() };
const settingsA = { tenant_id: 'tenant-a', settings_version: 2, cpv_primary: ['45000000'], keywords: [] };
const settingsB = { tenant_id: 'tenant-b', settings_version: 1, keywords: ['transport'] };

test('checks the pull secret in constant time and rejects empty secrets', () => {
  assert.equal(secretMatches('s3cret', 's3cret'), true);
  assert.equal(secretMatches('s3cret', 's3creT'), false);
  assert.equal(secretMatches('s3cret', 's3cret-longer'), false);
  assert.equal(secretMatches('', ''), false);
  assert.equal(secretMatches('s3cret', undefined), false);
});

test('reads the Europe/London hour across daylight saving', () => {
  assert.equal(londonHour(new Date('2026-07-01T04:00:00Z')), 5);
  assert.equal(londonHour(new Date('2026-12-01T05:00:00Z')), 5);
  assert.equal(londonHour(new Date('2026-12-01T04:00:00Z')), 4);
});

test('parses scheduled, manual and backfill requests', () => {
  const now = new Date('2026-10-25T12:00:00Z');
  assert.deepEqual(parsePullRequest('https://x/pull', now), {
    mode: 'scheduled', sources: ['fts', 'cf'], maxPages: 10, window: null, cursor: null,
  });
  assert.equal(parsePullRequest('https://x/pull?mode=manual&sources=cf&max_pages=3', now).mode, 'manual');
  const backfill = parsePullRequest('https://x/pull?from=2026-10-01T00:00:00Z&to=2026-10-08T00:00:00Z&cursor=abc', now);
  assert.equal(backfill.mode, 'backfill');
  assert.equal(backfill.window.from.toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(backfill.cursor, 'abc');
  for (const bad of [
    '?from=2026-10-01T00:00:00Z',
    '?from=2026-10-08T00:00:00Z&to=2026-10-01T00:00:00Z',
    '?from=2026-09-01T00:00:00Z&to=2026-10-01T00:00:00Z',
    '?from=2026-10-25T00:00:00Z&to=2026-10-26T00:00:00Z',
    '?from=nope&to=2026-10-01T00:00:00Z',
    '?sources=fts,ted',
    '?max_pages=0',
    '?max_pages=50',
  ]) {
    assert.throws(() => parsePullRequest(`https://x/pull${bad}`, now), RequestError, bad);
  }
});

test('plans windows from the last ok or empty run with an hour of overlap', () => {
  const now = new Date('2026-10-25T04:30:00Z');
  assert.equal(planSourceWindow([], now).from.toISOString(), '2026-10-24T04:30:00.000Z');
  const runs = [
    { status: 'failed', mode: 'scheduled', started_at: '2026-10-24T04:00:00Z', window_to: '2026-10-24T04:05:00Z' },
    { status: 'empty', mode: 'scheduled', started_at: '2026-10-23T04:00:00Z', window_to: '2026-10-23T04:05:00Z' },
    { status: 'ok', mode: 'scheduled', started_at: '2026-10-22T04:00:00Z', window_to: '2026-10-22T04:05:00Z' },
    { status: 'ok', mode: 'backfill', started_at: '2026-10-24T09:00:00Z', window_to: '2026-10-24T00:00:00Z' },
  ];
  const plan = planSourceWindow(runs, now);
  assert.equal(plan.from.toISOString(), '2026-10-23T03:05:00.000Z');
  assert.equal(plan.to, now);
  assert.equal(plan.cursor, null);
});

test('resumes the latest partial run from its cursor', () => {
  const now = new Date('2026-10-25T04:30:00Z');
  const plan = planSourceWindow([
    { status: 'skipped', mode: 'scheduled', started_at: '2026-10-25T03:00:00Z' },
    { status: 'partial', mode: 'scheduled', started_at: '2026-10-24T04:00:00Z', window_from: '2026-10-23T04:00:00Z', window_to: '2026-10-24T04:00:00Z', next_cursor: 'c9' },
    { status: 'ok', mode: 'scheduled', started_at: '2026-10-23T04:00:00Z', window_to: '2026-10-23T04:05:00Z' },
  ], now);
  assert.deepEqual([plan.from.toISOString(), plan.to.toISOString(), plan.cursor, plan.resumed],
    ['2026-10-23T04:00:00.000Z', '2026-10-24T04:00:00.000Z', 'c9', true]);
});

test('a scheduled call outside 05:00 London logs skipped and fetches nothing', async () => {
  const db = fakeDb();
  const { calls, fetchImpl } = fakeFetch({ fts: [], cf: [] });
  const result = await runTenderPull({ db, request: parsePullRequest('https://x/pull', sixAmLondon), now: sixAmLondon, fetchImpl, ...noSleep });
  assert.equal(result.status, 'skipped');
  assert.equal(calls.length, 0);
  assert.deepEqual(db.state.runs.map((r) => [r.source, r.status, Boolean(r.finished_at)]), [['fts', 'skipped', true], ['cf', 'skipped', true]]);
});

test('a scheduled 05:00 run stores notices, logs runs and scores every tenant', async () => {
  const db = fakeDb({ settings: [settingsA, settingsB] });
  const { calls, fetchImpl } = fakeFetch({ fts: [page(ftsPage.releases)], cf: [page(cfPage.releases)] });
  const result = await runTenderPull({ db, request: parsePullRequest('https://x/pull', fiveAmLondon), now: fiveAmLondon, fetchImpl, ...noSleep });

  assert.equal(result.status, 'ok');
  assert.equal(calls.length, 2);
  assert.ok(calls.every((url) => /(updatedTo|publishedTo)=2026-10-20T04%3A30%3A00/u.test(url)));
  const runs = Object.fromEntries(db.state.runs.map((r) => [r.source, r]));
  assert.equal(runs.fts.status, 'ok');
  assert.equal(runs.fts.fetched, 3);
  assert.equal(runs.fts.upserted, 3);
  assert.equal(runs.fts.http_status, 200);
  assert.equal(runs.fts.window_from, '2026-10-19T04:30:00.000Z');
  assert.equal(runs.cf.upserted, 2);
  assert.equal(db.state.notices.size, 5);

  assert.deepEqual(result.rescore, { tenants: 2, notices: 5, leads_written: 3 });
  assert.equal(db.state.leads.has('tenant-a|ocds-b5fd17-b44aa063-f444-4586-a47d-6c02e847b67c'), false,
    'a council buyer alone does not make a lead');
  const groundworks = db.state.leads.get('tenant-a|ocds-h6vhtk-078c53');
  assert.equal(groundworks.settings_version, 2);
  assert.ok(groundworks.score >= 40);
  assert.ok(db.state.leads.get('tenant-b|ocds-h6vhtk-078c55'), 'transport keyword matched for tenant B');
  assert.equal(db.state.leads.has('tenant-b|ocds-h6vhtk-078c53'), false, 'zero scores do not create leads');
});

test('re-scoring keeps workflow fields and refreshes leads that drop to 0', async () => {
  const db = fakeDb({
    settings: [{ tenant_id: 'tenant-a', settings_version: 5, keywords: ['nothing matches this'] }],
    leads: [{ tenant_id: 'tenant-a', ocid: 'ocds-h6vhtk-078c53', score: 80, status: 'bidding', assigned_to: 'user-1' }],
  });
  await db.ingest(ftsPage.releases.map((r) => ({ ocid: r.ocid, title: r.tender.title, cpv_codes: [], regions: [], postcodes: [] })));
  const summary = await rescoreTenants({ db, ocids: null });
  assert.equal(summary.notices, 3);
  const lead = db.state.leads.get('tenant-a|ocds-h6vhtk-078c53');
  assert.deepEqual([lead.score, lead.status, lead.assigned_to, lead.settings_version], [0, 'bidding', 'user-1', 5]);
  assert.equal(db.state.leads.size, 1);
});

test('re-scoring with no tenant settings does nothing', async () => {
  const db = fakeDb();
  assert.deepEqual(await rescoreTenants({ db, ocids: ['x'] }), { tenants: 0, notices: 0, leads_written: 0 });
});

test('a broken feed is logged failed while the other source still succeeds', async () => {
  const db = fakeDb({ settings: [settingsA] });
  const { fetchImpl } = fakeFetch({
    fts: [{ status: 200, body: '<html>Service unavailable</html>' }],
    cf: [page(cfPage.releases)],
  });
  const result = await runTenderPull({ db, request: parsePullRequest('https://x/pull?mode=manual', sixAmLondon), now: sixAmLondon, fetchImpl, ...noSleep });
  assert.equal(result.status, 'partial');
  const fts = db.state.runs.find((r) => r.source === 'fts');
  assert.equal(fts.status, 'failed');
  assert.equal(fts.mode, 'manual');
  assert.match(fts.error, /not JSON/u);
  assert.equal(db.state.runs.find((r) => r.source === 'cf').status, 'ok');
});

test('a genuinely empty window is logged empty, not failed', async () => {
  const db = fakeDb();
  const { fetchImpl } = fakeFetch({ fts: [page([])], cf: [page([])] });
  const result = await runTenderPull({ db, request: parsePullRequest('https://x/pull?mode=manual', sixAmLondon), now: sixAmLondon, fetchImpl, ...noSleep });
  assert.equal(result.status, 'empty');
  assert.deepEqual(db.state.runs.map((r) => r.status), ['empty', 'empty']);
});

test('a storage failure marks the run failed rather than empty', async () => {
  const db = fakeDb({ failIngest: true });
  const { fetchImpl } = fakeFetch({ fts: [page(ftsPage.releases)], cf: [page(cfPage.releases)] });
  const result = await runTenderPull({ db, request: parsePullRequest('https://x/pull?mode=manual', sixAmLondon), now: sixAmLondon, fetchImpl, ...noSleep });
  assert.equal(result.status, 'failed');
  assert.ok(db.state.runs.every((r) => r.status === 'failed' && /database unavailable/u.test(r.error)));
});

test('a re-score failure keeps the notices and marks the runs partial', async () => {
  const db = fakeDb({ settings: [settingsA], failScores: true });
  const { fetchImpl } = fakeFetch({ fts: [page(ftsPage.releases)], cf: [page([])] });
  const result = await runTenderPull({ db, request: parsePullRequest('https://x/pull?mode=manual', sixAmLondon), now: sixAmLondon, fetchImpl, ...noSleep });
  assert.equal(result.status, 'partial');
  assert.match(result.rescore_error, /scores rejected/u);
  assert.equal(db.state.notices.size, 3);
  const fts = db.state.runs.find((r) => r.source === 'fts');
  assert.equal(fts.status, 'partial');
  assert.match(fts.error, /re-score failed/u);
  assert.equal(db.state.runs.find((r) => r.source === 'cf').status, 'empty');
});

test('a backfill pulls the explicit window from the given cursor', async () => {
  const db = fakeDb();
  const { calls, fetchImpl } = fakeFetch({ fts: [page(ftsPage.releases)], cf: [] });
  const request = parsePullRequest('https://x/pull?from=2026-10-01T00:00:00Z&to=2026-10-08T00:00:00Z&sources=fts&cursor=c5', sixAmLondon);
  const result = await runTenderPull({ db, request, now: sixAmLondon, fetchImpl, ...noSleep });
  assert.equal(result.status, 'ok');
  const url = new URL(calls[0]);
  assert.equal(url.searchParams.get('updatedFrom'), '2026-10-01T00:00:00');
  assert.equal(url.searchParams.get('cursor'), 'c5');
  assert.equal(db.state.runs[0].mode, 'backfill');
});
