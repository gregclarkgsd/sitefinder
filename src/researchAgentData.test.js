import assert from 'node:assert/strict';
import test from 'node:test';
import {buildResearchRun} from './researchAgentData.js';

test('maps persisted research rows into the control-room model', () => {
  const result = buildResearchRun({
    run: {
      id: 'run-1',
      name: 'Daily research',
      mode: 'read_only',
      source: 'attio',
      status: 'running',
      company_limit: 50,
      companies_checked: 2,
      pages_inspected: 14,
      people_found: 3,
      started_at: '2026-07-28T09:00:00.000Z',
    },
    tasks: [{
      id: 'task-1',
      company_id: 'company-1',
      company_name: 'Example Construction',
      domain: 'example.com',
      status: 'running',
      progress: 2,
      page_count: 5,
      contacts_found: 1,
      current_url: null,
    }],
    events: [{
      id: 1,
      task_id: 'task-1',
      sequence: 1,
      event_type: 'page',
      message: 'Opened a public team page.',
      source_url: 'https://example.com/team',
      created_at: '2026-07-28T09:01:00.000Z',
    }],
    candidates: [{
      id: 'candidate-1',
      task_id: 'task-1',
      external_candidate_id: 'external-1',
      company_id: 'company-1',
      name: 'Example person',
      job_title: 'Commercial Manager',
      role_category: 'commercial',
      source_kind: 'company_website',
      source_url: 'https://example.com/team',
      evidence_excerpt: 'Published role evidence.',
      crm_comparison: 'likely_new',
      email_status: 'not_publicly_found',
      confidence: '0.910',
      review_status: 'pending',
    }],
  });

  assert.equal(result.mode, 'read_only');
  assert.equal(result.tasks[0].currentUrl, 'https://example.com/');
  assert.equal(result.events[0].message, 'Opened a public team page.');
  assert.equal(result.candidates[0].confidence, 0.91);
});

test('returns null when no saved run exists', () => {
  assert.equal(buildResearchRun({run: null}), null);
});
