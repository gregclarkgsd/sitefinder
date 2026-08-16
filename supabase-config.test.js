import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const config = await readFile(new URL('./supabase/config.toml', import.meta.url), 'utf8');
const researchApprovalMigration = await readFile(
  new URL(
    './supabase/migrations/20260729203556_enforce_research_candidate_approval.sql',
    import.meta.url,
  ),
  'utf8',
);
const licensedEmailStatusMigration = await readFile(
  new URL(
    './supabase/migrations/20260730103000_add_licensed_research_email_status.sql',
    import.meta.url,
  ),
  'utf8',
);

function verifyJwtFor(functionName) {
  const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = config.match(
    new RegExp(`\\[functions\\.${escaped}\\][\\s\\S]*?verify_jwt\\s*=\\s*(true|false)(?=\\s|$)`),
  );
  if (!match) return undefined;
  return match[1] === 'true';
}

test('declares the gateway JWT boundary for every deployed Edge Function', () => {
  for (const functionName of [
    'sync-approved-leads-to-attio',
    'send-approved-outreach',
    'connect-gmail-watch',
  ]) {
    assert.equal(verifyJwtFor(functionName), true, functionName);
  }

  for (const functionName of [
    'sync-ccs-projects',
    'sync-ccs-projects-to-attio',
    'gmail-mailboxes',
    'gmail-outreach-webhook',
    'process-outreach-followups',
    'process-scheduled-initial-outreach',
  ]) {
    assert.equal(verifyJwtFor(functionName), false, functionName);
  }
});

test('pins local Postgres to the production major version', () => {
  assert.match(config, /\[db\]\s+major_version\s*=\s*17/u);
});

test('database approval requires a public exact-email comparison and evidence floor', () => {
  assert.match(
    researchApprovalMigration,
    /research_candidates_approval_eligibility_check/u,
  );
  assert.match(
    researchApprovalMigration,
    /crm_comparison in \('pipedrive_only', 'missing_from_both'\)/u,
  );
  assert.match(
    researchApprovalMigration,
    /email_status = 'public_email_found'/u,
  );
  assert.match(researchApprovalMigration, /confidence >= 0\.65/u);
  assert.match(
    researchApprovalMigration,
    /create trigger recheck_research_candidate_approval/u,
  );
});

test('database accepts a licensed email status without making it approvable', () => {
  assert.match(
    licensedEmailStatusMigration,
    /'licensed_business_email_found'/u,
  );
  assert.doesNotMatch(
    researchApprovalMigration,
    /email_status = 'licensed_business_email_found'/u,
  );
});
