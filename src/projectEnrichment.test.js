import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyCcsProject,
  postcodeFromAddress,
} from '../supabase/functions/_shared/project-enrichment.js';

test('extracts a UK postcode from a native CCS address', () => {
  assert.equal(
    postcodeFromAddress('Peterborough Court, 133 Fleet Street, London, EC4M 8AL'),
    'EC4M 8AL',
  );
  assert.equal(postcodeFromAddress('Address not published'), null);
});

test('classifies explicit office fit-out evidence without guessing housing', () => {
  const result = classifyCcsProject({
    project_name: 'Head Office Fit Out',
    summary: null,
  });

  assert.equal(result.sector, 'Commercial Office');
  assert.equal(result.work_type, 'Fit Out');
  assert.equal(result.fit_out_state, 'yes');
  assert.equal(result.new_build_housing_state, 'no');
  assert.equal(result.classification_confidence, 0.9);
});

test('classifies explicit new-build housing evidence', () => {
  const result = classifyCcsProject({
    project_name: 'New Build 48 Homes',
    summary: null,
  });

  assert.equal(result.sector, 'Residential');
  assert.equal(result.work_type, 'New Build');
  assert.equal(result.fit_out_state, 'unknown');
  assert.equal(result.new_build_housing_state, 'yes');
});

test('classifies explicit education extension as not new-build housing', () => {
  const result = classifyCcsProject({
    project_name: 'Primary School Extension',
    summary: null,
  });

  assert.equal(result.sector, 'Education');
  assert.equal(result.work_type, 'Extension');
  assert.equal(result.fit_out_state, 'unknown');
  assert.equal(result.new_build_housing_state, 'no');
});

test('keeps unsupported classifications honestly unknown', () => {
  const result = classifyCcsProject({
    project_name: 'Morgan Lewis Expansion Project',
    summary: null,
  });

  assert.equal(result.sector, null);
  assert.equal(result.work_type, null);
  assert.equal(result.fit_out_state, 'unknown');
  assert.equal(result.new_build_housing_state, 'unknown');
});

test('does not treat a generic project name as evidence', () => {
  const result = classifyCcsProject({
    project_name: '20 Bloomsbury Square',
    summary: null,
  });

  assert.equal(result.sector, null);
  assert.equal(result.work_type, null);
  assert.equal(result.classification_confidence, null);
  assert.deepEqual(result.classification_evidence, []);
});
