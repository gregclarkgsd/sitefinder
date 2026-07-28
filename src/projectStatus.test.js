import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hasCurrentAttioLink,
  needsProjectClassification,
} from './projectStatus.js';

test('only treats a successfully synced Attio URL as current', () => {
  assert.equal(
    hasCurrentAttioLink({
      attio_web_url: 'https://app.attio.com/example',
      sync_status: 'synced',
    }),
    true,
  );
  assert.equal(
    hasCurrentAttioLink({
      attio_web_url: 'https://app.attio.com/example',
      sync_status: 'error',
    }),
    false,
  );
  assert.equal(
    hasCurrentAttioLink({
      attio_web_url: null,
      sync_status: 'synced',
    }),
    false,
  );
});

test('flags either missing project classification field', () => {
  assert.equal(
    needsProjectClassification({sector: 'Education', work_type: null}),
    true,
  );
  assert.equal(
    needsProjectClassification({sector: null, work_type: 'Extension'}),
    true,
  );
  assert.equal(
    needsProjectClassification({
      sector: 'Education',
      work_type: 'Extension',
    }),
    false,
  );
});
