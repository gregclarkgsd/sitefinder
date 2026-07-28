import assert from 'node:assert/strict';
import test from 'node:test';
import {parseResearchIngestMessage} from './research-agent-ingest.js';

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
      attioToken: 'must never be accepted',
    },
  }));
});
