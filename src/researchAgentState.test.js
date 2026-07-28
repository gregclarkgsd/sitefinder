import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advancePreviewRun,
  createPreviewResearchRun,
  pendingReviewCount,
  primaryRunControl,
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
