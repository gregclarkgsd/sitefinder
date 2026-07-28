import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyResearchIngestMessage,
  parseResearchIngestMessage,
  parseResearchRunId,
  stableResearchTaskId,
} from './research-agent-ingest.js';

const runId = '11111111-1111-4111-8111-111111111111';
const taskId = '22222222-2222-4222-8222-222222222222';

test('accepts a bounded read-only run message', () => {
  const message = parseResearchIngestMessage({
    type: 'run.upsert',
    run: {
      id: runId,
      name: 'Daily main contractors',
      source: 'attio',
      status: 'running',
      companyLimit: 50,
      startedAt: '2026-07-28T09:00:00.000Z',
    },
  });
  assert.equal(message.run.companyLimit, 50);
  assert.equal(message.run.companiesChecked, 0);
});

test('accepts an HTTPS evidence event', () => {
  const message = parseResearchIngestMessage({
    type: 'event.append',
    event: {
      runId,
      taskId,
      sequence: 3,
      eventType: 'page',
      message: 'Opened an official company page.',
      sourceUrl: 'https://example.com/team',
    },
  });
  assert.equal(message.event.sourceUrl, 'https://example.com/team');
});

test('rejects non-HTTPS source URLs', () => {
  assert.throws(() => parseResearchIngestMessage({
    type: 'event.append',
    event: {
      runId,
      sequence: 1,
      eventType: 'page',
      message: 'Unsafe source.',
      sourceUrl: 'http://example.com/team',
    },
  }), /Only HTTPS source URLs/u);
});

test('rejects unknown event fields and oversized runs', () => {
  assert.throws(() => parseResearchIngestMessage({
    type: 'run.upsert',
    run: {
      id: runId,
      name: 'Too large',
      source: 'attio',
      status: 'running',
      companyLimit: 500,
      startedAt: '2026-07-28T09:00:00.000Z',
      attioToken: 'must never be accepted',
    },
  }));
});

test('accepts only a valid UUID for research control lookups', () => {
  assert.equal(parseResearchRunId(runId), runId);
  assert.throws(() => parseResearchRunId('../research_runs'));
});

test('requires the deterministic task identifier used by the worker', () => {
  const companyId = 'company-1';
  const expectedTaskId = stableResearchTaskId(runId, companyId);
  const message = parseResearchIngestMessage({
    type: 'task.upsert',
    task: {
      id: expectedTaskId,
      runId,
      companyId,
      companyName: 'Example Construction',
      domain: 'example.com',
      status: 'waiting',
    },
  });
  assert.equal(message.task.id, expectedTaskId);
  assert.throws(() => parseResearchIngestMessage({
    type: 'task.upsert',
    task: {
      id: taskId,
      runId,
      companyId,
      companyName: 'Example Construction',
      domain: 'example.com',
      status: 'waiting',
    },
  }), /Task identifier must match/u);
});

test('records machine progress without impersonating a human actor', async () => {
  let savedRow;
  let upsertOptions;
  const client = {
    from(table) {
      assert.equal(table, 'research_runs');
      return {
        upsert(row, options) {
          savedRow = row;
          upsertOptions = options;
          return Promise.resolve({error: null});
        },
      };
    },
  };

  await applyResearchIngestMessage(client, {
    type: 'run.upsert',
    run: {
      id: runId,
      name: 'Five company live pilot',
      source: 'file',
      status: 'running',
      companyLimit: 5,
      startedAt: '2026-07-28T09:00:00.000Z',
    },
  });

  assert.equal(savedRow.mode, 'read_only');
  assert.equal(savedRow.created_by, null);
  assert.equal(savedRow.updated_by, null);
  assert.deepEqual(upsertOptions, {
    onConflict: 'id',
    ignoreDuplicates: true,
  });
});

test('worker heartbeats cannot undo a human pause or stop request', async () => {
  let allowedStatuses;
  let updateRow;
  const client = {
    from(table) {
      assert.equal(table, 'research_runs');
      return {
        update(row) {
          updateRow = row;
          return {
            eq() {
              return {
                in(column, values) {
                  assert.equal(column, 'status');
                  allowedStatuses = values;
                  return Promise.resolve({error: null});
                },
              };
            },
          };
        },
      };
    },
  };

  await applyResearchIngestMessage(client, {
    type: 'run.status',
    run: {
      id: runId,
      status: 'running',
      companiesChecked: 1,
      pagesInspected: 3,
      peopleFound: 1,
    },
  });

  assert.deepEqual(allowedStatuses, ['queued', 'running']);
  assert.equal(allowedStatuses.includes('paused'), false);
  assert.equal(allowedStatuses.includes('stopping'), false);
  assert.equal(updateRow.updated_by, null);
});

test('all machine-authored detail rows have null human attribution', async () => {
  const companyId = 'company-1';
  const deterministicTaskId = stableResearchTaskId(runId, companyId);
  const capture = async (expectedTable, message) => {
    let savedRow;
    const client = {
      from(table) {
        assert.equal(table, expectedTable);
        return {
          upsert(row) {
            savedRow = row;
            return Promise.resolve({error: null});
          },
        };
      },
    };
    await applyResearchIngestMessage(client, message);
    return savedRow;
  };

  const task = await capture('research_tasks', {
    type: 'task.upsert',
    task: {
      id: deterministicTaskId,
      runId,
      companyId,
      companyName: 'Example Construction',
      domain: 'example.com',
      status: 'waiting',
    },
  });
  assert.equal(task.created_by, null);
  assert.equal(task.updated_by, null);

  const event = await capture('research_events', {
    type: 'event.append',
    event: {
      runId,
      taskId: deterministicTaskId,
      sequence: 1,
      eventType: 'page',
      message: 'Opened an official company page.',
      sourceUrl: 'https://example.com/team',
    },
  });
  assert.equal(event.created_by, null);

  const candidate = await capture('research_candidates', {
    type: 'candidate.upsert',
    candidate: {
      id: '33333333-3333-4333-8333-333333333333',
      runId,
      taskId: deterministicTaskId,
      externalCandidateId: 'candidate-1',
      companyId,
      name: 'Example Person',
      jobTitle: 'Commercial Manager',
      roleCategory: 'commercial',
      sourceKind: 'company_website',
      sourceUrl: 'https://example.com/team',
      confidence: 0.9,
    },
  });
  assert.equal(candidate.created_by, null);
  assert.equal(candidate.updated_by, null);
});
