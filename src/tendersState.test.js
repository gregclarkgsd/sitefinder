import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareLeads,
  EMPTY_TENDER_FILTERS,
  filterLeads,
  formatDeadline,
  formatTenderValue,
  matchedTerms,
  OGL_NOTICE,
  regionOptions,
  sourceHealth,
} from './tendersState.js';

const now = Date.parse('2026-10-25T12:00:00Z');
const hoursAgo = h => new Date(now - h * 3600000).toISOString();
const run = (source, status, finishedHoursAgo, extra = {}) => ({source, status, started_at: hoursAgo(finishedHoursAgo + 0.1), finished_at: hoursAgo(finishedHoursAgo), ...extra});

test('reports the last good pull per source', () => {
  const [fts, cf] = sourceHealth([run('fts', 'ok', 3), run('cf', 'ok', 5), run('fts', 'skipped', 1)], now);
  assert.equal(fts.state, 'ok');
  assert.match(fts.message, /^Find a Tender: Last good pull 25 Oct, 09:00$/u);
  assert.equal(cf.state, 'ok');
});

test('an empty run today reads "Nothing new today"', () => {
  const [fts] = sourceHealth([run('fts', 'empty', 2), run('fts', 'ok', 26)], now, ['fts']);
  assert.equal(fts.state, 'empty');
  assert.match(fts.message, /Nothing new today/u);
});

test('a failed latest run is broken since the first failure after the last good pull', () => {
  const [fts] = sourceHealth([
    run('fts', 'failed', 1, {error: 'HTTP 403'}),
    run('fts', 'failed', 25, {error: 'Response was not JSON'}),
    run('fts', 'ok', 49),
  ], now, ['fts']);
  assert.equal(fts.state, 'broken');
  assert.equal(fts.brokenSince, now - 25 * 3600000);
  assert.equal(fts.error, 'HTTP 403');
  assert.equal(fts.message, 'Find a Tender feed broken since 24 Oct, 12:00: data may be out of date');
});

test('a partial latest run is treated as broken', () => {
  const [cf] = sourceHealth([run('cf', 'partial', 1, {error: 'HTTP 500'}), run('cf', 'ok', 2)], now, ['cf']);
  assert.equal(cf.state, 'broken');
});

test('no ok or empty run in 26 hours counts as broken even without failures', () => {
  const [cf] = sourceHealth([run('cf', 'ok', 27)], now, ['cf']);
  assert.equal(cf.state, 'broken');
  assert.equal(cf.brokenSince, now - 1 * 3600000);
  assert.match(cf.message, /^Contracts Finder feed broken since/u);
});

test('a source that has never been pulled is flagged, not shown as fine', () => {
  const [fts] = sourceHealth([run('fts', 'running', 0)], now, ['fts']);
  assert.equal(fts.state, 'broken');
  assert.match(fts.message, /has not been pulled yet/u);
});

const lead = (ocid, score, notice = {}, extra = {}) => ({ocid, score, status: 'to_qualify', score_breakdown: {signals: []}, notice: {stage: 'tender', regions: [], ...notice}, ...extra});
const leads = [
  lead('a', 80, {title: 'Painting framework', buyer_name: 'Example Council', regions: ['UKD37'], tender_deadline: '2026-10-28T12:00:00Z', is_framework_or_dps: true},
    {score_breakdown: {signals: [{signal: 'keyword_title', matched: ['painting']}, {signal: 'cpv_primary', matched: ['45440000']}]}}),
  lead('b', 80, {title: 'Roof repairs', regions: ['UKI31'], tender_deadline: '2026-11-20T12:00:00Z'}),
  lead('c', 55, {title: 'Planned maintenance', stage: 'planning', regions: ['UKD'], tender_deadline: null}, {status: 'bidding'}),
  lead('d', 20, {title: 'Grounds', regions: ['UKE'], tender_deadline: '2026-10-20T12:00:00Z'}),
  lead('e', 90, {title: 'Dismissed thing', regions: ['UKD']}, {status: 'dismissed'}),
];
const ids = result => result.visible.map(l => l.ocid);

test('sorts by score, then soonest deadline, with no deadline last', () => {
  assert.deepEqual([...leads].sort(compareLeads).map(l => l.ocid), ['e', 'a', 'b', 'c', 'd']);
});

test('hides dismissed leads and leads below the tenant threshold by default', () => {
  const result = filterLeads(leads, EMPTY_TENDER_FILTERS, {now, minScoreToShow: 40});
  assert.deepEqual(ids(result), ['a', 'b', 'c']);
  assert.equal(result.hiddenBelowThreshold, 1);
  const all = filterLeads(leads, {showBelowThreshold: true}, {now, minScoreToShow: 40});
  assert.deepEqual(ids(all), ['a', 'b', 'c', 'd']);
  assert.equal(all.hiddenBelowThreshold, 0);
});

test('filters narrow the list', () => {
  const opts = {now, minScoreToShow: 0};
  assert.deepEqual(ids(filterLeads(leads, {stage: 'planning'}, opts)), ['c']);
  assert.deepEqual(ids(filterLeads(leads, {region: 'ukd'}, opts)), ['a', 'c']);
  assert.deepEqual(ids(filterLeads(leads, {minScore: '50', maxScore: '79'}, opts)), ['c']);
  assert.deepEqual(ids(filterLeads(leads, {deadline: '7'}, opts)), ['a']);
  assert.deepEqual(ids(filterLeads(leads, {deadline: 'past'}, opts)), ['d']);
  assert.deepEqual(ids(filterLeads(leads, {deadline: 'none'}, opts)), ['c']);
  assert.deepEqual(ids(filterLeads(leads, {frameworkOnly: true}, opts)), ['a']);
  assert.deepEqual(ids(filterLeads(leads, {status: 'saved'}, opts)), ['c']);
  assert.deepEqual(ids(filterLeads(leads, {status: 'new'}, opts)), ['a', 'b', 'd']);
  assert.deepEqual(ids(filterLeads(leads, {status: 'dismissed'}, opts)), ['e']);
  assert.deepEqual(ids(filterLeads(leads, {status: 'all'}, opts)), ['e', 'a', 'b', 'c', 'd']);
  assert.deepEqual(ids(filterLeads(leads, {search: 'COUNCIL'}, opts)), ['a']);
  assert.deepEqual(ids(filterLeads(leads, {search: '45440000'}, opts)), ['a'], 'search covers matched terms');
});

test('lists matched terms and region options', () => {
  assert.deepEqual(matchedTerms(leads[0]), ['painting', '45440000']);
  assert.deepEqual(matchedTerms({}), []);
  assert.deepEqual(regionOptions(leads), ['UKD', 'UKE', 'UKI']);
});

test('formats values and deadlines', () => {
  assert.equal(formatTenderValue(null), 'Not published');
  assert.equal(formatTenderValue(45000, 'GBP'), '£45,000');
  assert.equal(formatTenderValue(2400000, 'GBP'), '£2.4m');
  assert.equal(formatDeadline(null, now), 'No deadline');
  assert.equal(formatDeadline('2026-10-28T12:00:00Z', now), '28 Oct 2026 (3 days)');
  assert.equal(formatDeadline('2026-10-20T12:00:00Z', now), 'Closed 20 Oct 2026');
});

test('carries the exact OGL attribution', () => {
  assert.equal(OGL_NOTICE, 'Contains public sector information licensed under the Open Government Licence v3.0');
});
