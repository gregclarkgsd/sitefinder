import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyResearchCandidateReview,
  applyResearchRunControl,
  parseResearchControlRequest,
  parseResearchReviewRequest,
  ResearchActionError,
} from './research-agent-actions.js';

const runId = '11111111-1111-4111-8111-111111111111';
const candidateId = '22222222-2222-4222-8222-222222222222';
const actorId = '33333333-3333-4333-8333-333333333333';

function updateClient(result = {data: {id: runId}, error: null}) {
  const calls = [];
  const chain = {
    update(values) {
      calls.push(['update', values]);
      return chain;
    },
    eq(column, value) {
      calls.push(['eq', column, value]);
      return chain;
    },
    in(column, values) {
      calls.push(['in', column, values]);
      return chain;
    },
    gte(column, value) {
      calls.push(['gte', column, value]);
      return chain;
    },
    select(columns) {
      calls.push(['select', columns]);
      return chain;
    },
    async maybeSingle() {
      return result;
    },
  };
  return {
    calls,
    client: {
      from(table) {
        calls.push(['from', table]);
        return chain;
      },
    },
  };
}

test('accepts only bounded Research Agent controls and decisions', () => {
  assert.deepEqual(
    parseResearchControlRequest(runId, {status: 'paused'}),
    {runId, status: 'paused'},
  );
  assert.deepEqual(
    parseResearchReviewRequest(candidateId, {decision: 'approved'}),
    {candidateId, decision: 'approved'},
  );
  assert.throws(() => parseResearchControlRequest(runId, {status: 'completed'}));
  assert.throws(() => parseResearchReviewRequest(candidateId, {decision: 'email'}));
  assert.throws(() => parseResearchReviewRequest('../candidate', {decision: 'approved'}));
});

test('applies a valid run transition with the authenticated actor', async () => {
  const {client, calls} = updateClient();
  const result = await applyResearchRunControl(
    client,
    {runId, status: 'paused'},
    actorId,
  );
  assert.deepEqual(result, {accepted: true, status: 'paused'});
  assert.ok(calls.some(call => call[0] === 'from' && call[1] === 'research_runs'));
  assert.ok(calls.some(call =>
    call[0] === 'in'
    && call[1] === 'status'
    && call[2].includes('running')
    && !call[2].includes('completed')
  ));
  const update = calls.find(call => call[0] === 'update')[1];
  assert.equal(update.updated_by, actorId);
});

test('rejects an invalid or completed run transition', async () => {
  const {client} = updateClient({data: null, error: null});
  await assert.rejects(
    applyResearchRunControl(client, {runId, status: 'paused'}, actorId),
    error => error instanceof ResearchActionError && error.statusCode === 409,
  );
});

test('records a human review without creating a CRM write', async () => {
  const {client, calls} = updateClient({data: {id: candidateId}, error: null});
  const result = await applyResearchCandidateReview(
    client,
    {candidateId, decision: 'investigate'},
    actorId,
  );
  assert.deepEqual(result, {
    accepted: true,
    decision: 'investigate',
    crmWritebackAuthorized: false,
  });
  const update = calls.find(call => call[0] === 'update')[1];
  assert.equal(update.review_status, 'investigate');
  assert.equal(update.reviewed_by, actorId);
  assert.deepEqual(
    calls.filter(call => call[0] === 'from').map(call => call[1]),
    ['research_candidates'],
  );
});

test('server-side approval is limited to candidates missing from Attio', async () => {
  const {client, calls} = updateClient({data: {id: candidateId}, error: null});
  const result = await applyResearchCandidateReview(
    client,
    {candidateId, decision: 'approved'},
    actorId,
  );
  assert.equal(result.crmWritebackAuthorized, false);
  assert.ok(calls.some(call =>
    call[0] === 'in'
    && call[1] === 'crm_comparison'
    && call[2].includes('pipedrive_only')
    && call[2].includes('missing_from_both')
    && !call[2].includes('already_in_attio')
  ));
  assert.ok(calls.some(call =>
    call[0] === 'eq'
    && call[1] === 'email_status'
    && call[2] === 'public_email_found'
  ));
  assert.ok(calls.some(call =>
    call[0] === 'gte'
    && call[1] === 'confidence'
    && call[2] === 0.65
  ));
});

test('returns a conflict when an approval candidate is not eligible', async () => {
  const {client} = updateClient({data: null, error: null});
  await assert.rejects(
    applyResearchCandidateReview(
      client,
      {candidateId, decision: 'approved'},
      actorId,
    ),
    error =>
      error instanceof ResearchActionError &&
      error.statusCode === 409,
  );
});
