import assert from 'node:assert/strict';
import test from 'node:test';
import {
  claimNextResearchRun,
  parseResearchQueueClaimRequest,
} from './research-agent-queue.js';
import {stableResearchTaskId} from './research-agent-ingest.js';

const runId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const createdAt = '2026-07-30T12:00:00.000Z';
const claimedAt = '2026-07-30T12:05:00.000Z';

const run = {
  id: runId,
  name: 'Reviewed contractor queue',
  source: 'file',
  status: 'queued',
  company_limit: 1,
  configuration: {
    requestedSources: ['website', 'apollo'],
    apolloMaxPeople: 5,
    procurementDays: 0,
    companies: [{
      companyId: 'sitefinder_contractor:123',
      domain: 'bam.co.uk',
      apolloSearchDomain: 'ukandireland.bam.com',
    }],
    requestedBy: actorId,
    requestVersion: 1,
  },
  created_at: createdAt,
};
const task = {
  id: stableResearchTaskId(runId, 'sitefinder_contractor:123'),
  run_id: runId,
  company_id: 'sitefinder_contractor:123',
  company_name: 'BAM UK & Ireland',
  domain: 'bam.co.uk',
  status: 'waiting',
  created_at: createdAt,
};

function queueClient({
  queuedRuns = [run],
  tasks = [task],
  claimWins = true,
} = {}) {
  const calls = [];
  let runReads = 0;
  return {
    calls,
    client: {
      from(table) {
        const state = {table, operation: 'select', values: null};
        const chain = {
          select(columns) {
            calls.push(['select', table, columns]);
            return chain;
          },
          update(values) {
            state.operation = 'update';
            state.values = values;
            calls.push(['update', table, values]);
            return chain;
          },
          eq(column, value) {
            calls.push(['eq', table, column, value]);
            return chain;
          },
          order(column, options) {
            calls.push(['order', table, column, options]);
            if (table === 'research_tasks') {
              return Promise.resolve({data: tasks, error: null});
            }
            return chain;
          },
          limit(value) {
            calls.push(['limit', table, value]);
            return chain;
          },
          async maybeSingle() {
            if (state.operation === 'update') {
              return {
                data: claimWins ? {id: runId} : null,
                error: null,
              };
            }
            const value = queuedRuns[runReads] ?? null;
            runReads += 1;
            return {data: value, error: null};
          },
          then(resolve) {
            resolve({data: null, error: null});
          },
        };
        return chain;
      },
    },
  };
}

test('accepts only bounded non-sensitive worker identifiers', () => {
  assert.deepEqual(
    parseResearchQueueClaimRequest({workerId: 'gsd-local-worker'}),
    {workerId: 'gsd-local-worker'},
  );
  assert.throws(() => parseResearchQueueClaimRequest({
    workerId: 'Greg’s MacBook /Users/greg',
  }));
});

test('claims one reviewed run with a conditional queued-status update', async () => {
  const {client, calls} = queueClient();
  const result = await claimNextResearchRun(
    client,
    {workerId: 'gsd-local-worker'},
    {now: () => claimedAt},
  );
  assert.deepEqual(result, {
    claimed: true,
    run: {
      id: runId,
      name: 'Reviewed contractor queue',
      requestedSources: ['website', 'apollo'],
      apolloMaxPeople: 5,
      procurementDays: 0,
      companies: [{
        companyId: 'sitefinder_contractor:123',
        companyName: 'BAM UK & Ireland',
        domain: 'bam.co.uk',
        apolloSearchDomain: 'ukandireland.bam.com',
      }],
    },
  });
  const claimUpdate = calls.find(
    call => call[0] === 'update' && call[2].status === 'running',
  );
  assert.equal(claimUpdate[2].configuration.workerClaim.workerId, 'gsd-local-worker');
  assert.ok(calls.some(
    call =>
      call[0] === 'eq'
      && call[1] === 'research_runs'
      && call[2] === 'status'
      && call[3] === 'queued',
  ));
});

test('returns no work when another worker wins the conditional update', async () => {
  const {client} = queueClient({
    queuedRuns: [run, null],
    claimWins: false,
  });
  assert.deepEqual(
    await claimNextResearchRun(
      client,
      {workerId: 'second-worker'},
      {now: () => claimedAt},
    ),
    {claimed: false},
  );
});

test('fails a malformed queued request before it can be claimed', async () => {
  const malformed = {
    ...run,
    company_limit: 2,
  };
  const {client, calls} = queueClient({
    queuedRuns: [malformed, null],
  });
  assert.deepEqual(
    await claimNextResearchRun(
      client,
      {workerId: 'gsd-local-worker'},
      {now: () => claimedAt},
    ),
    {claimed: false},
  );
  assert.ok(calls.some(
    call =>
      call[0] === 'update'
      && call[2].status === 'failed'
      && !JSON.stringify(call[2]).includes('sitefinder_contractor:123'),
  ));
});
