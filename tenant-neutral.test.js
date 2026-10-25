import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';
import test from 'node:test';

// Everything written for the multi-tenant model must stay tenant-neutral:
// no tenant ids, brand names or email domains in source. Migrations up to the
// last drift-reconciled version are historical records of live and are exempt.
const FIRST_TENANT_NEUTRAL_MIGRATION = '20261025000000';

const FORBIDDEN = [
  {pattern: /gsd/i, label: 'GSD brand'},
  {pattern: /@[a-z0-9-]+\.(?:com|co\.uk|org|net|io)\b/i, label: 'email domain'},
];

async function tenantNeutralFiles() {
  const migrations = (await readdir(new URL('./supabase/migrations/', import.meta.url)))
    .filter((name) => name.endsWith('.sql') && name.slice(0, 14) >= FIRST_TENANT_NEUTRAL_MIGRATION)
    .map((name) => `supabase/migrations/${name}`);
  const scripts = (await readdir(new URL('./scripts/tenancy/', import.meta.url)))
    .map((name) => `scripts/tenancy/${name}`);
  return [...migrations, ...scripts];
}

test('tenant model files exist to check', async () => {
  const files = await tenantNeutralFiles();
  assert.ok(files.some((file) => file.includes('add_tenants_and_memberships')));
});

test('tenant-scoped migrations and scripts hard-code no tenant brand or email domain', async () => {
  for (const file of await tenantNeutralFiles()) {
    const source = await readFile(new URL(`./${file}`, import.meta.url), 'utf8');
    const code = source.replace(/^\s*--.*$/gm, '');
    for (const {pattern, label} of FORBIDDEN) {
      assert.doesNotMatch(code, pattern, `${file} contains a ${label}`);
    }
  }
});

test('tenant_id columns never get a default', async () => {
  for (const file of await tenantNeutralFiles()) {
    const source = await readFile(new URL(`./${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(
      source,
      /tenant_id\s+uuid[^,;\n]*\bdefault\b/i,
      `${file} gives tenant_id a default`,
    );
    assert.doesNotMatch(
      source,
      /alter\s+column\s+tenant_id\s+set\s+default/i,
      `${file} sets a tenant_id default`,
    );
  }
});
