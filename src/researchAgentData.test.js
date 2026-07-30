import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildResearchRun,
  createResearchRun,
  updateResearchCandidateReview,
  updateResearchRunStatus,
} from './researchAgentData.js';

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
      crm_comparison: 'conflicting_multiple_matches',
      email_status: 'not_publicly_found',
      confidence: '0.910',
      review_status: 'pending',
    }],
  });

  assert.equal(result.mode, 'read_only');
  assert.equal(result.tasks[0].currentUrl, null);
  assert.equal(result.tasks[0].currentRole, null);
  assert.equal(result.events[0].message, 'Opened a public team page.');
  assert.equal(result.candidates[0].confidence, 0.91);
  assert.equal(
    result.candidates[0].crmComparison,
    'conflicting_multiple_matches',
  );
});

test('returns null when no saved run exists', () => {
  assert.equal(buildResearchRun({run: null}), null);
});

test('uses authenticated server routes for runner controls and candidate decisions', async () => {
  const calls = [];
  const request = async (path, options) => {
    calls.push({
      path,
      method: options.method,
      body: JSON.parse(options.body),
    });
    return new Response(JSON.stringify({accepted: true}), {status: 200});
  };
  await updateResearchRunStatus(request, 'run-1', 'paused');
  await updateResearchCandidateReview(request, 'candidate-1', 'approved');
  assert.deepEqual(calls, [
    {
      path: '/api/research/runs/run-1/control',
      method: 'POST',
      body: {status: 'paused'},
    },
    {
      path: '/api/research/candidates/candidate-1/review',
      method: 'POST',
      body: {decision: 'approved'},
    },
  ]);
});

test('queues a reviewed research request through the authenticated server route', async () => {
  const input = {
    name: 'Two-company pilot',
    companies: [{
      companyId: 'sitefinder_contractor:123',
      companyName: 'Example Construction',
      domain: 'example.com',
    }],
    sources: {
      website: true,
      apollo: true,
      companiesHouse: false,
      procurement: false,
    },
    apolloMaxPeople: 5,
    procurementDays: 0,
  };
  const request = async (path, options) => {
    assert.equal(path, '/api/research/runs');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), input);
    return new Response(JSON.stringify({
      accepted: true,
      runId: 'run-2',
      status: 'queued',
    }), {status: 201});
  };

  assert.deepEqual(
    await createResearchRun(request, input),
    {accepted: true, runId: 'run-2', status: 'queued'},
  );
});

test('surfaces a safe server action error', async () => {
  const request = async () => new Response(
    JSON.stringify({error: 'Research run is not controllable'}),
    {status: 409},
  );
  await assert.rejects(
    updateResearchRunStatus(request, 'run-1', 'paused'),
    /Research run is not controllable/u,
  );
});
