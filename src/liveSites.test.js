import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bestLiveSitesContact,
  captureClassificationSnapshot,
  chooseLiveSitesMatch,
  classifyLiveSitesProject,
  normaliseLiveSitesProject,
  normalisePostcode,
  parseCurrencyGbp,
  preserveReviewedLiveSitesMatch,
  requireLiveSitesConflictReview,
  restoreClassificationSnapshot,
  sourceConflicts,
} from '../supabase/functions/_shared/livesites.js';

test('normalises the LiveSites fields shown for Edwards House', () => {
  const project = normaliseLiveSitesProject({
    siteid: 24859,
    name: 'Edwards House',
    address: '8 Albion Row, Cambridge, CB3 0BH',
    value: '£5m',
    project_overview: '16 Flats',
    description: 'Replacement development providing 16 one-bedroom almshouse apartments.',
    contractor: 'Cocksedge Building Contractors Ltd',
    client: 'The Foundation of Edward Storey',
    start_date: '25/05/2026',
    end_date: '18/01/2028',
    exported_at: '28/07/2026',
    trades: ['Brickwork', 'Painting & Decorating'],
    contacts: [{
      name: 'Simon Eaglen',
      role: 'Site Manager',
      direct_mobile: '07879 476637',
      verified_email: 'seaglen@cocksedge.com',
      verified: true,
    }],
  });

  assert.equal(project.livesites_site_id, '24859');
  assert.equal(project.source_url, 'https://livesites.co.uk/projects?siteid=24859');
  assert.equal(project.postcode, 'CB3 0BH');
  assert.equal(project.contract_value_gbp, 5_000_000);
  assert.equal(project.unit_count, 16);
  assert.equal(project.unit_type, 'Flats');
  assert.equal(project.painting_and_decorating_required, true);
  assert.equal(project.source_verified_at, '2026-07-28T00:00:00.000Z');
  assert.equal(project.contacts[0].email, 'seaglen@cocksedge.com');
  assert.equal(project.contacts[0].email_verified, true);
});

test('parses supported UK contract value and postcode formats', () => {
  assert.equal(parseCurrencyGbp('£120m'), 120_000_000);
  assert.equal(parseCurrencyGbp('750k'), 750_000);
  assert.equal(parseCurrencyGbp('not published'), null);
  assert.equal(normalisePostcode('London, sw1x9lf'), 'SW1X 9LF');
});

test('accepts only safe HTTPS image and LiveSites source URLs', () => {
  const project = normaliseLiveSitesProject({
    siteid: 10,
    name: 'Safe Project',
    image_url: 'javascript:alert(1)',
  });
  assert.equal(project.image_url, null);
  assert.throws(
    () => normaliseLiveSitesProject({
      siteid: 11,
      name: 'Wrong Source',
      source_url: 'https://example.com/project/11',
    }),
    /Invalid LiveSites source URL/,
  );
});

test('keeps unsupported classifications unknown', () => {
  const classification = classifyLiveSitesProject({
    project_type: 'General construction works',
    project_description: null,
    painting_and_decorating_required: false,
  });
  assert.equal(classification.sector, null);
  assert.equal(classification.work_type, null);
  assert.equal(classification.fit_out_state, 'unknown');
  assert.equal(classification.new_build_housing_state, 'unknown');
  assert.equal(classification.classification_confidence, null);
});

test('classifies explicit refurbishment and residential development evidence', () => {
  const refurbishment = classifyLiveSitesProject({
    project_type: 'Office Refurbishment',
    project_description: null,
    painting_and_decorating_required: true,
  });
  assert.equal(refurbishment.sector, 'Commercial Office');
  assert.equal(refurbishment.work_type, 'Refurbishment');
  assert.equal(refurbishment.fit_out_state, 'yes');
  assert.equal(refurbishment.new_build_housing_state, 'no');

  const housing = classifyLiveSitesProject({
    project_type: '16 Flats',
    project_description: 'Replacement development providing 16 one-bedroom almshouse apartments.',
    painting_and_decorating_required: true,
  });
  assert.equal(housing.sector, 'Residential');
  assert.equal(housing.work_type, 'Redevelopment');
  assert.equal(housing.new_build_housing_state, 'yes');
});

test('auto-matches only a strong and unambiguous postcode candidate', () => {
  const source = {
    project_name: 'Edwards House',
    address: '8 Albion Row, Cambridge, CB3 0BH',
    postcode: 'CB3 0BH',
    main_contractor: 'Cocksedge Building Contractors Ltd',
    site_start_date: '2026-05-25',
    site_end_date: '2028-01-18',
  };
  const result = chooseLiveSitesMatch(source, [
    {
      project_id: 'site24859',
      project_name: 'Edwards House',
      address: '8 Albion Row Cambridge CB3 0BH',
      main_contractor: 'Cocksedge Building Contractors',
      site_start_date: '2026-05-25',
      site_end_date: '2028-01-18',
    },
    {
      project_id: 'site99999',
      project_name: 'Albion Row Works',
      address: '10 Albion Row Cambridge CB3 0BH',
      main_contractor: 'Another Contractor',
    },
  ]);

  assert.equal(result.status, 'auto_confirmed');
  assert.equal(result.project_id, 'site24859');
  assert.ok(result.score >= 0.9);
});

test('routes a plausible but ambiguous match to review', () => {
  const source = {
    project_name: 'School Extension',
    postcode: 'N1 1AA',
    main_contractor: 'Example Construction',
  };
  const result = chooseLiveSitesMatch(source, [
    {
      project_id: 'site1',
      project_name: 'North School Extension',
      address: '1 Road, N1 1AA',
      main_contractor: 'Example Construction Ltd',
    },
    {
      project_id: 'site2',
      project_name: 'South School Extension',
      address: '2 Road, N1 1AA',
      main_contractor: 'Example Construction Ltd',
    },
  ]);

  assert.equal(result.status, 'review');
});

test('forces an otherwise automatic match into review when sources conflict', () => {
  const calculated = {
    status: 'auto_confirmed',
    project_id: 'site24859',
    score: 0.96,
    method: 'postcode_name_contractor_dates_v1',
    evidence: { score_margin: 0.4 },
  };
  const result = requireLiveSitesConflictReview(calculated, [
    'client',
    'site_end_date',
  ]);

  assert.equal(result.status, 'review');
  assert.equal(result.method, 'source_conflict_review_v1');
  assert.deepEqual(result.evidence.source_conflicts, [
    'client',
    'site_end_date',
  ]);
});

test('preserves a manual match decision when source data is re-imported', () => {
  const calculated = {
    status: 'review',
    project_id: 'site-new',
    score: 0.68,
    method: 'candidate_scoring_v1',
    evidence: { score_margin: 0.05 },
  };
  const confirmed = preserveReviewedLiveSitesMatch(calculated, {
    match_status: 'confirmed',
    project_id: 'site-reviewed',
    match_score: 0.91,
    match_method: 'manual_review',
    match_evidence: { reviewed: true },
  });
  const rejected = preserveReviewedLiveSitesMatch(calculated, {
    match_status: 'rejected',
    project_id: null,
    match_score: 0.7,
    match_method: 'manual_review',
    match_evidence: { reviewed: true },
  });

  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.project_id, 'site-reviewed');
  assert.equal(confirmed.manually_reviewed, true);
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.project_id, null);
});

test('restores the exact pre-LiveSites classification when a match is removed', () => {
  const before = {
    sector: 'Education',
    work_type: null,
    fit_out_state: 'unknown',
    new_build_housing_state: 'no',
    classification_confidence: 0.6,
    classification_evidence: ['CCS evidence'],
    classification_sources: [{ source_system: 'ccs' }],
    classification_method: 'ccs_deterministic_v1',
    researched_at: '2026-07-20T00:00:00.000Z',
  };
  const snapshot = captureClassificationSnapshot(before);
  const restored = restoreClassificationSnapshot({
    ...before,
    sector: 'Residential',
    work_type: 'New Build',
    classification_method: 'ccs_plus_livesites_deterministic_v1',
    livesites_previous_classification: snapshot,
  });

  assert.equal(restored.sector, 'Education');
  assert.equal(restored.work_type, null);
  assert.deepEqual(restored.classification_sources, [{ source_system: 'ccs' }]);
  assert.equal(restored.livesites_previous_classification, null);
});

test('surfaces conflicting source values without overwriting either source', () => {
  const conflicts = sourceConflicts(
    {
      project_name: 'Edwards House',
      main_contractor: 'Cocksedge Building Contractors',
      client: 'The Foundation of Edward Storey',
      site_start_date: '2026-05-25',
      site_end_date: '2028-01-18',
    },
    {
      project_name: 'Edwards House',
      main_contractor: 'Cocksedge Building Contractors Ltd',
      client: 'An Individual Contact',
      site_start_date: '2026-05-25',
      site_end_date: '2027-01-01',
    },
  );
  assert.deepEqual(conflicts, ['client', 'site_end_date']);
});

test('selects the best verified contact without changing People records', () => {
  const contact = bestLiveSitesContact([
    { full_name: 'Unverified', email: 'one@example.com', email_verified: false },
    {
      full_name: 'Simon Eaglen',
      job_title: 'Site Manager',
      email: 'seaglen@cocksedge.com',
      phone: '07879 476637',
      email_verified: true,
    },
  ]);
  assert.equal(contact.full_name, 'Simon Eaglen');
});
