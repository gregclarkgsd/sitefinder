import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDatabaseReview, createProviderSnapshotReader, createSupabaseReadPort } from './lemlist-adapters.js';
import { evaluateCandidate, initializeReview, reviewInsert } from './lemlist-review.js';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardGmailProvider, insertSyncLink } from './supabase/functions/_shared/lemlist-linkage.js';
import {createSourceInventoryReader} from './lemlist-offline-ports.js';

const now = '2030-02-02T00:05:00Z';
function fixture() {
  const project = { project_id: 'site-new', project_name: 'Mock school', first_seen_at: '2030-02-02T00:00:00Z', first_seen_sync_run_id: 2, discovered_after_baseline: true, is_active: true, site_closed: false };
  const rows = {
    events: { id: 'event', capture_id: 'capture', project_id: project.project_id, sync_run_id: 2, captured_at: '2030-02-02T00:00:01Z', project: { ...project } },
    boundary: { capture_id: 'capture', campaign_id: 'mock-campaign', go_live_at: '2030-02-01T00:00:00Z' }, excluded: [],
    runs: { id: 2, status: 'completed', started_at: '2030-02-01T23:59:59Z', completed_at: '2030-02-02T00:01:00Z' }, projects: project,
    leads: [{ id: 'lead', project_id: project.project_id, recipient_email: 'test@example.invalid', attio_company_record_id: 'company', status: 'queued' }],
    tracking: { project_id: project.project_id, assigned_email: 'owner@example.invalid', stage: 'new' }, suppressions: [], communications: [], claims: [],
  };
  const review = { projectId: project.project_id, companyKey: 'attio:company', approved: true, checkedAt: now, approvedBy: 'owner@example.invalid', provider: 'lemlist',
    contact: { email: 'test@example.invalid', verified: true, suitableForDecoratingTender: true, firstName: 'Mock' } };
  const sources = Object.fromEntries(['lemlist', 'woodpecker', 'attio'].map(provider => [provider, { provider, complete: true, checkedAt: now, records: [] }]));
  const options = { sitefinder: { one: async key => structuredClone(rows[key]), all: async key => structuredClone(rows[key]) },
    providerSnapshot: async provider => structuredClone(sources[provider]), eventId: 'event', review, now };
  return { rows, review, sources, options };
}

test('completed originating sync produces a review-only projectName preview from read adapters', async () => {
  const { options } = fixture();
  const result = await buildDatabaseReview(options);
  const evaluated = evaluateCandidate(result.boundary, result.event, result.evidence, now);
  assert.equal(evaluated.eligible, true);
  assert.equal(evaluated.payload.projectName, 'Mock school');
  assert.equal(result.event.evidenceMode, 'database'); // mock port, not live verification
});
test('verified Woodpecker non-use supplies explicit coverage without requesting an integration',async()=>{
  const f=fixture();delete f.sources.woodpecker;const reads=[];
  const inventory=Object.fromEntries(['lemlist','attio','woodpecker'].map(provider=>[provider,{status:provider==='woodpecker'?'not_used':'in_use',checkedAt:now,verifiedBy:'owner',reference:'mock-inventory'}]));
  f.options.providerSnapshot=createSourceInventoryReader({inventory,readSnapshot:async provider=>{reads.push(provider);return f.sources[provider];}});
  const r=await buildDatabaseReview(f.options);
  assert.equal(evaluateCandidate(r.boundary,r.event,r.evidence,now).eligible,true);
  assert.deepEqual(reads.sort(),['attio','lemlist']);
  inventory.woodpecker.status='unknown';await assert.rejects(buildDatabaseReview(f.options),/unconfirmed/);
});

test('mocked read adapters flow through durable review and replay without external submission', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'lemlist-adapter-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.json');
  const result = await buildDatabaseReview(fixture().options);
  initializeReview(path, { ...result.boundary, snapshotComplete: true, captureInstalled: true }, '2030-01-01T00:00:00Z');
  const first = reviewInsert(path, result.event, result.evidence, now);
  assert.equal(first.submitted, false);
  assert.equal(first.candidate.requestPreview.body.projectName, 'Mock school');
  assert.equal(reviewInsert(path, result.event, result.evidence, now).status, 'already_reviewed');
  assert.equal(JSON.parse(readFileSync(path)).candidates.length, 1);
});

test('fictitious campaign template remains inert; mock review maps its ID and variables without submission', async t => {
  const target = JSON.parse(readFileSync(new URL('./docs/lemlist-target.example.json', import.meta.url)));
  const directory = mkdtempSync(join(tmpdir(), 'lemlist-target-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.json');
  assert.throws(() => initializeReview(path, target), /go-live boundary/);
  const f = fixture(); f.rows.boundary.campaign_id = target.campaignId;
  const r = await buildDatabaseReview(f.options);
  initializeReview(path, { ...r.boundary, snapshotComplete: true, captureInstalled: true }, '2030-01-01T00:00:00Z');
  const output = reviewInsert(path, r.event, r.evidence, now);
  assert.equal(output.submitted, false);
  assert.match(output.candidate.requestPreview.path, /\/cam_mock_review_only\/leads\//);
  assert.equal(output.candidate.requestPreview.body.firstName, 'Mock');
  assert.equal(output.candidate.requestPreview.body.projectName, 'Mock school');
});

for (const [name, change] of [
  ['running sync', f => { f.rows.runs.status = 'running'; }],
  ['failed sync', f => { f.rows.runs.status = 'failed'; }],
  ['unrelated successful run', f => { f.rows.runs.id = 3; }],
  ['missing insert linkage', f => { f.rows.events.sync_run_id = null; }],
  ['replaced original run', f => { f.rows.projects.first_seen_sync_run_id = 3; }],
  ['stale owner approval', f => { f.review.checkedAt = '2030-01-01T00:00:00Z'; }],
  ['owner mismatch', f => { f.rows.tracking.assigned_email = 'someone-else@example.invalid'; }],
  ['missing external history', f => { f.sources.woodpecker.complete = false; }],
  ['unknown external flags', f => { f.sources.lemlist.records = [{ email: 'test@example.invalid', companyKey: 'attio:company' }]; }],
]) test(`adapter holds ${name}`, async () => { const f = fixture(); change(f); await assert.rejects(buildDatabaseReview(f.options), /Review held/); });

for (const [name, change, reason] of [
  ['suppression', f => { f.rows.suppressions.push({ email: 'TEST@example.invalid' }); }, 'suppression_or_reply_hold'],
  ['historical exclusion', f => { f.rows.excluded.push({ project_id: 'site-new' }); }, 'historical_project'],
  ['Gmail follow-up', f => { f.rows.leads[0].next_follow_up_at = now; }, 'provider_conflict'],
  ['prior communication', f => { f.rows.communications.push({ project_id: 'site-new' }); }, 'existing_or_unknown_outreach'],
  ['other provider reservation', f => { f.rows.claims.push({ project_id: 'site-new' }); }, 'existing_or_unknown_outreach'],
  ['external opt-out', f => { f.sources.lemlist.records.push({ email: 'test@example.invalid', companyKey: 'attio:company', active: false, contacted: false, suppressed: true, bounced: false, replied: false }); }, 'suppression_or_reply_hold'],
]) test(`adapter derives ${name} hold`, async () => {
  const f = fixture(); change(f); const r = await buildDatabaseReview(f.options);
  assert.ok(evaluateCandidate(r.boundary, r.event, r.evidence, now).reasons.includes(reason));
});

test('provider pagination reaches completion and rejects looping/incomplete responses', async () => {
  const calls = [];
  const read = createProviderSnapshotReader(async (provider, cursor) => { calls.push(cursor); return { complete: true, records: [cursor], nextCursor: cursor === null ? 'next' : null }; });
  assert.equal((await read('lemlist', now)).records.length, 2);
  assert.deepEqual(calls, [null, 'next']);
  await assert.rejects(createProviderSnapshotReader(async () => ({ complete: true, records: [], nextCursor: 'loop' }))('lemlist', now), /invalid cursor/);
  await assert.rejects(createProviderSnapshotReader(async () => ({ complete: false, records: [], nextCursor: null }))('lemlist', now), /incomplete/);
});

test('Supabase port paginates beyond 1000 and fails on read errors', async () => {
  let pages = 0;
  const db = { schema: () => ({ from: () => ({ select: () => ({ order: () => ({ range: async from => {
    pages++; return { data: Array.from({ length: from === 0 ? 1000 : 1 }, (_, i) => ({ project_id: `site${from + i}` })) };
  } }) }) }) }) };
  assert.equal((await createSupabaseReadPort(db).all('excluded')).length, 1001);
  assert.equal(pages, 2);
  await assert.rejects(createSupabaseReadPort({ schema: () => ({ from: () => ({ select: () => ({ order: () => ({ range: async () => ({ error: 'offline' }) }) }) }) }) }).all('excluded'), /incomplete/);
});

test('disabled linkage/guard leave legacy behavior alone; enabled guard fails closed', async () => {
  assert.deepEqual(insertSyncLink(false, null), {});
  assert.deepEqual(insertSyncLink(true, 2), { first_seen_sync_run_id: 2 });
  assert.throws(() => insertSyncLink(true, null), /run ID/);
  let calls = 0;
  const db = { rpc: async () => { calls++; return { error: 'missing schema' }; } };
  await guardGmailProvider(db, 'lead', false); assert.equal(calls, 0);
  await assert.rejects(guardGmailProvider(db, 'lead', true), /no email sent/);
  await assert.rejects(guardGmailProvider({ rpc: async () => ({ data: { allowed: false } }) }, 'lead', true), /no email sent/);
  await guardGmailProvider({ rpc: async (name, args) => { assert.equal(name, 'claim_outreach_provider'); assert.equal(args.requested_provider, 'gmail'); return { data: { allowed: true } }; } }, 'lead', true);
});
