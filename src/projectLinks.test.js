import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseProjectId,
  projectIdFromSearch,
  projectSearchUrl,
  sitefinderProjectUrl,
} from './projectLinks.js';

test('normalises CCS numeric and SiteFinder project IDs', () => {
  assert.equal(normaliseProjectId('519795'), 'site519795');
  assert.equal(normaliseProjectId('site519795'), 'site519795');
  assert.equal(normaliseProjectId('not-a-project'), null);
});

test('reads the exact project from a deep-link query', () => {
  assert.equal(projectIdFromSearch('?project=site519795'), 'site519795');
  assert.equal(projectIdFromSearch('?project=519795'), 'site519795');
  assert.equal(projectIdFromSearch('?authorization_id=abc'), null);
});

test('adds and removes a project without disturbing other query values', () => {
  const location = { href: 'https://example.test/?view=map#results' };
  assert.equal(
    projectSearchUrl(location, '519795'),
    '/?view=map&project=site519795#results',
  );
  const linked = { href: 'https://example.test/?view=map&project=site519795#results' };
  assert.equal(projectSearchUrl(linked, null), '/?view=map#results');
});

test('builds the production Attio return URL', () => {
  assert.equal(
    sitefinderProjectUrl('519795'),
    'https://gsd-sitefinder.onrender.com/?project=site519795',
  );
});
