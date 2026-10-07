import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectReader } from './project-reader.js';
const start = Date.parse('2026-10-07T12:00:00Z');
const project = { Id: 'site1', Name: 'Office', LaId: 'City of London', SiteStartDate: '2027-01-01', SiteEndDate: '2027-06-01' };
const json = (data, headers = {}) => Response.json(data, { headers });

test('retrieval, source HTTP metadata, programme and successful sync dates remain distinct', async () => {
  let clock = start;
  let requests = 0;
  const reader = createProjectReader({ now: () => clock, fetchImpl: async () => { requests++; return json([project], { 'last-modified': 'Wed, 01 Jul 2026 00:00:00 GMT' }); } });
  const chain = { select() { return this; }, eq(field, value) { assert.equal(field, 'status'); assert.equal(value, 'completed'); return this; }, order() { return this; }, limit() { return this; }, maybeSingle: async () => ({ data: { completed_at: '2026-10-06T23:00:00Z' }, error: null }) };
  const userClient = { from(table) { assert.equal(table, 'ccs_sync_runs'); return chain; } };
  const first = await reader.listProjects({}, userClient);
  clock += 60_000;
  const second = await reader.listProjects({}, userClient);
  assert.equal(requests, 1);
  assert.equal(first.markerRetrievedAt, second.markerRetrievedAt);
  assert.notEqual(first.retrievedAt, second.retrievedAt);
  assert.equal(second.lastSuccessfulSyncAt, '2026-10-06T23:00:00Z');
  assert.equal(second.sourcePublicationDate, null, 'Last-Modified must not be treated as publication');
  assert.equal(second.sourceLastModifiedAt, 'Wed, 01 Jul 2026 00:00:00 GMT');
  assert.equal(second.projects[0].SiteStartDate, '2027-01-01');
  assert.equal(second.projects[0].SiteEndDate, '2027-06-01');
});
test('unavailable sync is null and a failed refresh retains an explicitly stale feed', async () => {
  let clock = start;
  let fail = false;
  const reader = createProjectReader({ now: () => clock, fetchImpl: async () => {
    if (fail) throw new Error('source unavailable');
    return json([project]);
  }});
  const first = await reader.listProjects();
  assert.equal(first.lastSuccessfulSyncAt, null);
  assert.equal(first.syncStatus, 'unavailable');
  fail = true; clock += 31 * 60_000;
  const stale = await reader.listProjects();
  assert.equal(stale.stale, true);
  assert.equal(stale.markerRetrievedAt, first.markerRetrievedAt);
  assert.equal(reader.health().markerCacheStatus, 'stale');
});
test('API filtering and detail IDs preserve region and programme semantics', async () => {
  const reader = createProjectReader({ fetchImpl: async url => json(url.endsWith('sitemarkers.json') ? [project, { ...project, Id: 'site2', LaId: 'Edinburgh' }] : project) });
  assert.equal((await reader.listProjects()).total, 1);
  assert.equal((await reader.listProjects({ region: 'all' })).total, 2);
  assert.equal((await reader.listProjects({ q: 'office', completion_from: '2028-01-01' })).total, 0);
  const detail = await reader.getProject('SITE1');
  assert.ok(detail.retrievedAt);
  assert.match(detail.SourceUrl, /\/1\/null$/);
  await assert.rejects(reader.getProject('../secrets'), error => error.statusCode === 400);
});
test('concurrent reads coalesce a marker refresh', async () => {
  let requests = 0;
  const reader = createProjectReader({ fetchImpl: async () => { requests++; await new Promise(resolve => setTimeout(resolve, 10)); return json([project]); } });
  await Promise.all([reader.listProjects(), reader.listProjects()]);
  assert.equal(requests, 1);
});
test('malformed CCS payloads fail clearly rather than returning successful empty records', async () => {
  const reader = createProjectReader({ fetchImpl: async () => Response.json(null) });
  await assert.rejects(reader.listProjects(), /invalid project list/);
  assert.equal(reader.health().ok, false);
  await assert.rejects(reader.getProject('1'), /invalid project record/);
});
