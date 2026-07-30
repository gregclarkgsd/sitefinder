import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advancePreviewRun,
  canApproveResearchCandidate,
  createPreviewResearchRun,
  pendingReviewCount,
  primaryRunControl,
  researchCandidateApprovalBlockReason,
  researchCrmComparisonLabel,
  requestStopAfterCurrent,
  reviewCandidate,
  setRunStatus,
} from './researchAgentState.js';

test('preview run starts read-only with a visible running task', () => {
  const run = createPreviewResearchRun();
  assert.equal(run.mode, 'preview');
  assert.equal(run.status, 'running');
  assert.equal(run.tasks.filter(task => task.status === 'running').length, 1);
  assert.equal(pendingReviewCount(run), 5);
});

test('candidate decisions update the review queue without changing run status', () => {
  const run = createPreviewResearchRun();
  const reviewed = reviewCandidate(run, 'preview-candidate', 'approved');
  assert.equal(reviewed.candidates[0].reviewStatus, 'approved');
  assert.equal(pendingReviewCount(reviewed), 4);
  assert.equal(reviewed.status, 'running');
  assert.equal(run.candidates[0].reviewStatus, 'pending');
});

test('approval fails closed on unknown CRM states, missing public email or weak evidence', () => {
  const candidate = createPreviewResearchRun().candidates[0];
  assert.equal(canApproveResearchCandidate(candidate), true);
  assert.equal(canApproveResearchCandidate({...candidate, crmComparison: 'not_checked'}), false);
  assert.equal(canApproveResearchCandidate({...candidate, emailStatus: 'not_publicly_found'}), false);
  assert.equal(
    canApproveResearchCandidate({...candidate, emailStatus: 'licensed_business_email_found'}),
    false,
  );
  assert.match(
    researchCandidateApprovalBlockReason({
      ...candidate,
      emailStatus: 'licensed_business_email_found',
    }),
    /independent public verification/u,
  );
  assert.equal(canApproveResearchCandidate({...candidate, confidence: 0.649}), false);
  assert.throws(
    () => reviewCandidate(
      {
        ...createPreviewResearchRun(),
        candidates: [{...candidate, crmComparison: 'unexpected'}],
      },
      candidate.id,
      'approved',
    ),
    /verified exact-email CRM comparison/u,
  );
});

test('CRM comparison copy describes exact-email evidence and unknown values as unverified', () => {
  assert.equal(
    researchCrmComparisonLabel('missing_from_both'),
    'No exact work-email match in either CRM',
  );
  assert.match(
    researchCrmComparisonLabel('pipedrive_only'),
    /no exact match in Attio/u,
  );
  assert.equal(
    researchCrmComparisonLabel('unexpected'),
    'Unverified CRM comparison',
  );
});

test('candidates marked for investigation remain in the review queue', () => {
  const run = createPreviewResearchRun();
  const reviewed = reviewCandidate(run, 'preview-candidate', 'investigate');
  assert.equal(pendingReviewCount(reviewed), 5);
});

test('pause prevents preview progress and resume allows it', () => {
  const run = createPreviewResearchRun();
  const paused = setRunStatus(run, 'paused');
  assert.deepEqual(advancePreviewRun(paused), paused);
  const resumed = setRunStatus(paused, 'running');
  assert.notDeepEqual(advancePreviewRun(resumed), resumed);
});

test('preview page progress never exceeds the task page count', () => {
  let run = createPreviewResearchRun();
  for (let index = 0; index < 30; index += 1) {
    run = advancePreviewRun(run);
  }
  const activeTask = run.tasks.find(task => task.status === 'running');
  assert.equal(activeTask.progress, activeTask.pageCount);
  const settled = advancePreviewRun(run);
  assert.deepEqual(settled, run);
});

test('offers truthful primary controls for queued, running and paused runs', () => {
  assert.deepEqual(primaryRunControl('queued'), {status: 'running', label: 'Start'});
  assert.deepEqual(primaryRunControl('running'), {status: 'paused', label: 'Pause'});
  assert.deepEqual(primaryRunControl('paused'), {status: 'running', label: 'Resume'});
  assert.equal(primaryRunControl('completed'), null);
});

test('stop-after-current records an orderly stop request', () => {
  const run = requestStopAfterCurrent(createPreviewResearchRun());
  assert.equal(run.status, 'stopping');
  assert.equal(run.stopAfterCurrent, true);
});
