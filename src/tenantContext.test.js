import assert from 'node:assert/strict';
import test from 'node:test';
import {canEditTenantData, chooseTenant, loadTenantMemberships} from './tenantContext.js';

const alpha = {tenantId: 'a', role: 'member', name: 'Alpha', slug: 'alpha'};
const beta = {tenantId: 'b', role: 'viewer', name: 'Beta', slug: 'beta'};

test('chooses nothing when the user has no tenant', () => {
  assert.equal(chooseTenant([], 'a'), null);
  assert.equal(chooseTenant(null, null), null);
});

test('keeps the stored tenant while the user still belongs to it', () => {
  assert.equal(chooseTenant([alpha, beta], 'b'), beta);
});

test('falls back to the first membership when the stored tenant is gone', () => {
  assert.equal(chooseTenant([alpha, beta], 'removed'), alpha);
  assert.equal(chooseTenant([alpha, beta], null), alpha);
});

test('viewers cannot edit tenant data', () => {
  assert.equal(canEditTenantData(alpha), true);
  assert.equal(canEditTenantData({...alpha, role: 'admin'}), true);
  assert.equal(canEditTenantData(beta), false);
  assert.equal(canEditTenantData(null), false);
});

test('loads only the signed-in user\'s memberships, sorted by tenant name', async () => {
  const calls = [];
  const client = {
    from(table) {
      calls.push(['from', table]);
      return {
        select(columns) {
          calls.push(['select', columns]);
          return {
            eq(column, value) {
              calls.push(['eq', column, value]);
              return Promise.resolve({
                data: [
                  {tenant_id: 'b', role: 'viewer', tenants: {name: 'Beta', slug: 'beta'}},
                  {tenant_id: 'a', role: 'member', tenants: {name: 'Alpha', slug: 'alpha'}},
                ],
                error: null,
              });
            },
          };
        },
      };
    },
  };

  const memberships = await loadTenantMemberships(client, 'user-1');
  assert.deepEqual(memberships, [alpha, beta]);
  assert.deepEqual(calls[0], ['from', 'tenant_members']);
  assert.deepEqual(calls[2], ['eq', 'user_id', 'user-1']);
});

test('surfaces membership load errors', async () => {
  const failure = new Error('denied');
  const client = {from: () => ({select: () => ({eq: () => Promise.resolve({data: null, error: failure})})})};
  await assert.rejects(loadTenantMemberships(client, 'user-1'), failure);
});
