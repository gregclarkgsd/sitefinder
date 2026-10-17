import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeReview, reviewInsert, evaluateCandidate } from './lemlist-review.js';

const initializedAt = '2030-01-01T00:00:00Z';
const goLiveAt = '2030-02-01T00:00:00Z';
const now = '2030-02-02T00:05:00Z';
const config = { campaignId: 'mock-campaign', goLiveAt, excludedProjectIds: ['site-old'], snapshotComplete: true, captureInstalled: true, captureId: 'mock-capture', evidenceMode: 'mock' };
function fixture(id = 'site-new') {
  return {
    event: { id: `insert-${id}`, operation: 'INSERT', captureId: 'mock-capture', evidenceMode: 'mock', capturedAt: '2030-02-02T00:00:01Z', project: { project_id: id, project_name: 'Example school refurbishment', first_seen_at: '2030-02-02T00:00:00Z', discovered_after_baseline: true, is_active: true, site_closed: false } },
    evidence: { checkedAt: now, projectId: id, insertEventId: `insert-${id}`, syncCompleted: true, projectActive: true, projectClosed: false,
      contact: { email: 'review@example.invalid', firstName: 'Test', companyName: 'Example Contractor', verified: true, suitableForDecoratingTender: true },
      companyKey: 'attio:mock-company', companyVerified: true, suppressionChecksComplete: true, suppressed: false, bounced: false, replied: false,
      historyChecksComplete: true, existingProjectOutreach: false, existingContactOutreach: false, existingCompanyOutreach: false,
      ownershipChecksComplete: true, ownerConflict: false, ownerEmail: 'owner@example.invalid', ownerApproved: true, stage: 'new',
      provider: 'lemlist', gmailActive: false, otherProviderActive: false, reviewedBy: 'mock-reviewer', manualReviewApproved: true },
  };
}
function store(t) {
  const directory = mkdtempSync(join(tmpdir(), 'lemlist-review-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'review.json');
  initializeReview(path, config, initializedAt);
  return path;
}

test('eligible insert creates only a direct API preview with exact projectName', t => {
  const path = store(t), { event, evidence } = fixture();
  const output = reviewInsert(path, event, evidence, now);
  assert.equal(output.status, 'review_only');
  assert.equal(output.submitted, false);
  assert.equal(output.candidate.evidenceMode, 'mock');
  assert.equal(output.candidate.requestPreview.body.projectName, event.project.project_name);
  assert.match(output.candidate.requestPreview.path, /deduplicate=true&updateStrategy=fillEmptyOnly/);
  assert.equal(JSON.parse(readFileSync(path)).automaticSending, false);
});

test('durable idempotency survives reopening and immutable event replay', t => {
  const path = store(t), { event, evidence } = fixture();
  const first = reviewInsert(path, event, evidence, now);
  const second = reviewInsert(path, JSON.parse(JSON.stringify(event)), evidence, now);
  assert.equal(second.status, 'already_reviewed');
  assert.equal(first.candidate.id, second.candidateId);
  assert.equal(JSON.parse(readFileSync(path)).candidates.length, 1);
  event.project.project_name = 'Another project';
  assert.throws(() => reviewInsert(path, event, evidence, now), /event changed/);
});

for (const [label, mutate, reason] of [
  ['baseline', f => { f.event.project.discovered_after_baseline = false; }, 'baseline_project'],
  ['old ID reimported with fresh date', f => { f.event.project.project_id = 'site-old'; }, 'historical_project'],
  ['pre-launch', f => { f.event.project.first_seen_at = initializedAt; }, 'outside_go_live_boundary'],
  ['exact boundary', f => { f.event.project.first_seen_at = goLiveAt; }, 'outside_go_live_boundary'],
  ['update', f => { f.event.operation = 'UPDATE'; }, 'unverified_insert'],
  ['unknown source', f => { f.event.captureId = 'other'; }, 'unverified_insert'],
  ['missing contact', f => { delete f.evidence.contact.email; }, 'unverified_or_unsuitable_contact'],
  ['suppression unavailable', f => { delete f.evidence.suppressionChecksComplete; }, 'suppression_or_reply_hold'],
  ['opt-out', f => { f.evidence.suppressed = true; }, 'suppression_or_reply_hold'],
  ['bounce', f => { f.evidence.bounced = true; }, 'suppression_or_reply_hold'],
  ['reply', f => { f.evidence.replied = true; }, 'suppression_or_reply_hold'],
  ['Sam/Greg owner conflict', f => { f.evidence.ownerConflict = true; }, 'ownership_hold'],
  ['existing company relationship', f => { f.evidence.existingCompanyOutreach = true; }, 'existing_or_unknown_outreach'],
  ['Gmail follow-up active', f => { f.evidence.gmailActive = true; }, 'provider_conflict'],
  ['unreviewed', f => { f.evidence.manualReviewApproved = false; }, 'manual_review_required'],
  ['failed sync', f => { f.evidence.syncCompleted = false; }, 'unverified_project_or_sync'],
  ['closed since insert', f => { f.evidence.projectClosed = true; }, 'unverified_project_or_sync'],
  ['stale checks', f => { f.evidence.checkedAt = goLiveAt; }, 'stale_or_missing_checks'],
  ['name-only company match', f => { f.evidence.companyKey = 'Example Contractor'; }, 'unverified_company'],
]) {
  test(`holds ${label}`, () => {
    const f = fixture(); mutate(f);
    const result = evaluateCandidate(config, f.event, f.evidence, now);
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.includes(reason));
  });
}

test('same contact or company across different projects is held; distinct contacts and companies pass', t => {
  const path = store(t), first = fixture();
  reviewInsert(path, first.event, first.evidence, now);
  const second = fixture('site-two');
  let result = reviewInsert(path, second.event, second.evidence, now);
  assert.ok(result.reasons.includes('duplicate_contact'));
  assert.ok(result.reasons.includes('duplicate_company'));
  second.evidence.contact.email = 'other@example.invalid';
  result = reviewInsert(path, second.event, second.evidence, now);
  assert.ok(result.reasons.includes('duplicate_company'));
  second.evidence.companyKey = 'attio:other-company';
  assert.equal(reviewInsert(path, second.event, second.evidence, now).status, 'review_only');
});

test('different event IDs cannot bypass project uniqueness', t => {
  const path = store(t), f = fixture();
  reviewInsert(path, f.event, f.evidence, now);
  f.event.id = 'another-event'; f.evidence.insertEventId = f.event.id;
  f.evidence.contact.email = 'other@example.invalid'; f.evidence.companyKey = 'attio:other';
  assert.ok(reviewInsert(path, f.event, f.evidence, now).reasons.includes('duplicate_project'));
});

test('pending contact can be completed without replacing the captured insert', t => {
  const path = store(t), f = fixture();
  f.evidence.contact.verified = false;
  assert.equal(reviewInsert(path, f.event, f.evidence, now).status, 'held');
  f.evidence.contact.verified = true;
  assert.equal(reviewInsert(path, f.event, f.evidence, now).status, 'review_only');
});

test('boundary resets, corruption and concurrent/stale locks fail closed', t => {
  const path = store(t), f = fixture();
  assert.throws(() => initializeReview(path, config, initializedAt), /already exists/);
  writeFileSync(`${path}.lock`, 'another writer');
  assert.throws(() => reviewInsert(path, f.event, f.evidence, now), /EEXIST/);
  rmSync(`${path}.lock`);
  const state = JSON.parse(readFileSync(path)); state.boundary.goLiveAt = initializedAt;
  writeFileSync(path, JSON.stringify(state));
  assert.throws(() => reviewInsert(path, f.event, f.evidence, now), /Boundary changed/);
});

test('replay rechecks opt-outs and retains duplicate reservations while held', t => {
  const path = store(t), f = fixture();
  reviewInsert(path, f.event, f.evidence, now);
  f.evidence.suppressed = true;
  assert.equal(reviewInsert(path, f.event, f.evidence, now).status, 'held');
  assert.equal(JSON.parse(readFileSync(path)).candidates[0].status, 'held');
  const other = fixture('site-other');
  assert.ok(reviewInsert(path, other.event, other.evidence, now).reasons.includes('duplicate_contact'));
});

test('replay cannot silently replace reviewed contact or project variables', t => {
  const path = store(t), f = fixture();
  reviewInsert(path, f.event, f.evidence, now);
  f.evidence.contact.email = 'replacement@example.invalid';
  assert.deepEqual(reviewInsert(path, f.event, f.evidence, now).reasons, ['reviewed_payload_changed']);
  assert.equal(JSON.parse(readFileSync(path)).candidates[0].recipient, 'review@example.invalid');
});
