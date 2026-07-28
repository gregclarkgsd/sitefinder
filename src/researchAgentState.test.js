import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advancePreviewRun,
  createPreviewResearchRun,
  pendingReviewCount,
  requestStopAfterCurrent,
  reviewCandidate,
  setRunStatus,
} from './researchAgentState.js';

test('preview run starts read-only with a visible running task', () => {
  const run = createPreviewResearchRun();
  assert.equal(run.mode, 'preview');
  assert.equal(run.status, 'running');
  assert.equal(run.tasks.filter(task => task.status === 'running').length, 1);
  assert.equal(pendingReviewCount(run), 3);
});

test('candidate decisions update the review queue without changing run status', () => {
  const run = createPreviewResearchRun();
  const reviewed = reviewCandidate(run, 'preview-candidate', 'approved');
  assert.equal(reviewed.candidates[0].reviewStatus, 'approved');
  assert.equal(pendingReviewCount(reviewed), 2);
  assert.equal(reviewed.status, 'running');
  assert.equal(run.candidates[0].reviewStatus, 'pending');
});

test('pause prevents preview progress and resume allows it', () => {
  const run = createPreviewResearchRun();
  const paused = setRunStatus(run, 'paused');
  assert.deepEqual(advancePreviewRun(paused), paused);
  const resumed = setRunStatus(paused, 'running');
  assert.notDeepEqual(advancePreviewRun(resumed), resumed);
});

test('stop-after-current records an orderly stop request', () => {
  const run = requestStopAfterCurrent(createPreviewResearchRun());
  assert.equal(run.status, 'stopping');
  assert.equal(run.stopAfterCurrent, true);
});
