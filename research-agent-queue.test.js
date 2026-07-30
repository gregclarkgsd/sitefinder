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
  return {
    calls,
    client: {
      from(table) {
        const state = {
          table,
          operation: 'select',
          values: null,
          filters: {},
        };
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
            state.filters[column] = value;
            calls.push(['eq', table, column, value]);
            return chain;
          },
          order(column, options) {
            calls.push(['order', table, column, options]);
            if (table === 'research_tasks') {
              return Promise.resolve({
                data: tasks.filter(
                  queuedTask => queuedTask.run_id === state.filters.run_id,
                ),
                error: null,
              });
            }
            return chain;
          },
          limit(value) {
            calls.push(['limit', table, value]);
            if (table === 'research_runs') {
              return Promise.resolve({
                data: queuedRuns.slice(0, value),
                error: null,
              });
            }
            return chain;
          },
          async maybeSingle() {
            if (state.operation === 'update') {
              return {
                data: claimWins ? {id: state.filters.id} : null,
                error: null,
              };
            }
            return {data: null, error: null};
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
    {
      workerId: 'gsd-local-worker',
      availableSources: [
        'website',
        'apollo',
        'companiesHouse',
        'procurement',
      ],
    },
  );
  assert.deepEqual(
    parseResearchQueueClaimRequest({
      workerId: 'public-worker',
      availableSources: ['website', 'procurement'],
    }),
    {
      workerId: 'public-worker',
      availableSources: ['website', 'procurement'],
    },
  );
  assert.throws(() => parseResearchQueueClaimRequest({
    workerId: 'Greg’s MacBook /Users/greg',
  }));
  assert.throws(() => parseResearchQueueClaimRequest({
    workerId: 'worker-without-website',
    availableSources: ['apollo'],
  }));
});

test('claims one reviewed run with a conditional queued-status update', async () => {
  const {client, calls} = queueClient();
  const result = await claimNextResearchRun(
    client,
    {
      workerId: 'gsd-local-worker',
      availableSources: ['website', 'apollo'],
    },
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
  assert.deepEqual(
    claimUpdate[2].configuration.workerClaim.availableSources,
    ['website', 'apollo'],
  );
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
    queuedRuns: [run],
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

test('leaves unsupported runs queued and claims the oldest compatible run', async () => {
  const compatibleRunId = '33333333-3333-4333-8333-333333333333';
  const compatibleRun = {
    ...run,
    id: compatibleRunId,
    name: 'Website-only contractor queue',
    configuration: {
      ...run.configuration,
      requestedSources: ['website'],
      companies: [{
        companyId: 'sitefinder_contractor:456',
        domain: 'example.co.uk',
      }],
    },
  };
  const compatibleTask = {
    ...task,
    id: stableResearchTaskId(
      compatibleRunId,
      'sitefinder_contractor:456',
    ),
    run_id: compatibleRunId,
    company_id: 'sitefinder_contractor:456',
    company_name: 'Example Construction',
    domain: 'example.co.uk',
  };
  const {client, calls} = queueClient({
    queuedRuns: [run, compatibleRun],
    tasks: [task, compatibleTask],
  });

  const result = await claimNextResearchRun(
    client,
    {
      workerId: 'public-source-worker',
      availableSources: ['website', 'procurement'],
    },
    {now: () => claimedAt},
  );

  assert.equal(result.claimed, true);
  assert.equal(result.run.id, compatibleRunId);
  assert.deepEqual(result.run.requestedSources, ['website']);
  assert.equal(
    calls.some(
      call =>
        call[0] === 'update'
        && call[2].status === 'failed',
    ),
    false,
  );
  assert.ok(calls.some(
    call =>
      call[0] === 'eq'
      && call[1] === 'research_runs'
      && call[2] === 'id'
      && call[3] === compatibleRunId,
  ));
});

test('fails a malformed queued request before it can be claimed', async () => {
  const malformed = {
    ...run,
    company_limit: 2,
  };
  const {client, calls} = queueClient({
    queuedRuns: [malformed],
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
