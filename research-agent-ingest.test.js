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
  const client = {
    from(table) {
      assert.equal(table, 'research_runs');
      return {
        upsert(row) {
          savedRow = row;
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
  assert.equal(savedRow.created_by, undefined);
  assert.equal(savedRow.updated_by, undefined);
});

test('worker heartbeats cannot undo a human pause or stop request', async () => {
  let allowedStatuses;
  const client = {
    from(table) {
      assert.equal(table, 'research_runs');
      return {
        update() {
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
});
