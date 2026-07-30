import test from 'node:test';
import assert from 'node:assert/strict';
import {
  changedCcsFields,
  hasCcsDetailChanged,
  latestCcsChangedFields,
} from './ccs-change-fields.js';

test('reports the exact CCS fields that changed without duplicate location labels', () => {
  assert.deepEqual(
    changedCcsFields(
      {
        project_name: 'Project A',
        main_contractor: 'Old Contractor',
        latitude: 51.4,
        longitude: -0.1,
        site_end_date: '2026-10-01',
      },
      {
        project_name: 'Project A',
        main_contractor: 'New Contractor',
        latitude: 51.5,
        longitude: -0.2,
        site_end_date: '2026-11-01',
      },
    ),
    ['Main contractor', 'Location coordinates', 'Finish date'],
  );
});

test('first successful detail retrieval resurfaces an existing project', () => {
  assert.equal(
    hasCcsDetailChanged({
      projectExists: true,
      previousHash: null,
      nextHash: 'first-detail-hash',
    }),
    true,
  );
  assert.equal(
    hasCcsDetailChanged({
      projectExists: false,
      previousHash: null,
      nextHash: 'new-project-detail-hash',
    }),
    false,
  );
  assert.equal(
    hasCcsDetailChanged({
      projectExists: true,
      previousHash: 'same',
      nextHash: 'same',
    }),
    false,
  );
});

test('ignores harmless surrounding and repeated whitespace', () => {
  assert.deepEqual(
    changedCcsFields(
      {project_name: '  Project   A ', address: null},
      {project_name: 'Project A', address: undefined},
    ),
    [],
  );
  assert.deepEqual(
    latestCcsChangedFields({
      reactivated: true,
      before: {project_name: 'Returning project'},
      after: {project_name: 'Returning project'},
    }),
    ['Reactivated in CCS feed'],
  );
});

test('the sync payload keeps prior evidence when unchanged and uses an honest fallback', () => {
  assert.deepEqual(
    latestCcsChangedFields({
      previous: ['Client'],
      before: {client: 'Acme'},
      after: {client: 'Acme'},
    }),
    ['Client'],
  );
  assert.deepEqual(
    latestCcsChangedFields({
      before: {project_name: 'Same'},
      after: {project_name: 'Same'},
      markerChanged: true,
      detailChanged: true,
    }),
    ['CCS map listing', 'CCS project details'],
  );
  assert.deepEqual(
    latestCcsChangedFields({
      isNew: true,
      markerChanged: true,
      before: {},
      after: {project_name: 'New'},
    }),
    [],
  );
});
