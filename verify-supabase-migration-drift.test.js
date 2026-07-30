import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXPECTED_REMOTE_TO_LOCAL,
  REQUIRED_LOCAL_ONLY_MIGRATION,
  verifyMigrationSnapshot,
} from './scripts/verify-supabase-migration-drift.mjs';

const expectedLocalStems = [
  ...Object.values(EXPECTED_REMOTE_TO_LOCAL),
  REQUIRED_LOCAL_ONLY_MIGRATION,
];
const expectedLocalFiles = expectedLocalStems.map((value) => `${value}.sql`);
const expectedLocalVersions = expectedLocalStems.map((value) => value.split('_')[0]);
const expectedOldRemote = Object.keys(EXPECTED_REMOTE_TO_LOCAL);
const exactMappingPairs = Object.entries(EXPECTED_REMOTE_TO_LOCAL);
const exactSnapshot = JSON.stringify({ remote_to_local: exactMappingPairs });

function cliTable(remote, local, { ansi = false, prose = '' } = {}) {
  return cliRows([
    ...remote.map((version) => `                  │ \`${version}\` │ 2026-07-30 00:00:00`),
    ...local.map((version) => `  \`${version}\` │                  │ 2026-07-30 00:00:00`),
  ], { ansi, prose });
}

function cliRows(rows, { ansi = false, prose = '' } = {}) {
  const header = '`LOCAL`         │ `REMOTE`         │ `TIME (UTC)`';
  return `${prose}${ansi ? `\u001B[1m${header}\u001B[0m` : header}
──────────────────┼──────────────────┼────────────────────
${rows.join('\n')}`;
}

function pairedRow(localVersion, remoteVersion = localVersion) {
  return `  \`${localVersion}\` │ \`${remoteVersion}\` │ 2026-07-30 00:00:00`;
}

function stateTable(state) {
  const paired = expectedLocalVersions.map((version) => pairedRow(version));
  if (state === 'intermediate') {
    return cliRows([
      ...paired,
      ...expectedOldRemote.map((version) => `                  │ \`${version}\` │ 2026-07-30 00:00:00`),
    ]);
  }
  if (state === 'after') return cliRows(paired);
  return cliTable(expectedOldRemote, expectedLocalVersions);
}

test('accepts the exact verified semantic before-state mapping', () => {
  const report = verifyMigrationSnapshot(exactSnapshot, expectedLocalFiles);
  assert.equal(report.state, 'before');
  assert.equal(report.remoteCount, 20);
  assert.equal(report.localCount, 21);
});

test('accepts the exact 41-row ANSI/backtick CLI before-state fingerprint', () => {
  const snapshot = cliTable(expectedOldRemote, expectedLocalVersions, { ansi: true });
  const report = verifyMigrationSnapshot(snapshot, expectedLocalFiles, 'before');
  assert.equal(report.remoteCount, 20);
});

test('accepts Supabase-style JSON migrations with unpaired before-state rows', () => {
  const migrations = [
    ...expectedOldRemote.map((remote) => ({ local: '', remote })),
    ...expectedLocalVersions.map((local) => ({ local, remote: '' })),
  ];
  const report = verifyMigrationSnapshot(JSON.stringify({ migrations }), expectedLocalFiles, 'before');
  assert.equal(report.localCount, 21);
});

test('accepts and distinguishes intermediate and after repair states', () => {
  const intermediate = stateTable('intermediate');
  const after = stateTable('after');
  assert.equal(verifyMigrationSnapshot(intermediate, expectedLocalFiles, 'intermediate').remoteCount, 41);
  assert.equal(verifyMigrationSnapshot(after, expectedLocalFiles, 'after').remoteCount, 21);
});

test('rejects impossible paired and unpaired CLI row topology in every state', () => {
  const impossibleBefore = cliRows([
    ...expectedOldRemote.map((remote, index) => pairedRow(expectedLocalVersions[index], remote)),
    `  \`${expectedLocalVersions.at(-1)}\` │                  │ 2026-07-30 00:00:00`,
  ]);
  assert.throws(
    () => verifyMigrationSnapshot(impossibleBefore, expectedLocalFiles, 'before'),
    /row topology: expected 0 paired/,
  );

  const impossibleIntermediate = cliTable(
    [...expectedOldRemote, ...expectedLocalVersions],
    expectedLocalVersions,
  );
  assert.throws(
    () => verifyMigrationSnapshot(impossibleIntermediate, expectedLocalFiles, 'intermediate'),
    /row topology: expected 21 paired/,
  );

  const rotated = [...expectedLocalVersions.slice(1), expectedLocalVersions[0]];
  const impossibleAfter = cliRows(expectedLocalVersions.map((local, index) => pairedRow(local, rotated[index])));
  assert.throws(
    () => verifyMigrationSnapshot(impossibleAfter, expectedLocalFiles, 'after'),
    /paired LOCAL and REMOTE versions differ/,
  );
});

test('rejects an unexpected remote migration entry', () => {
  const snapshot = JSON.stringify({
    remote_to_local: [
      ...exactMappingPairs,
      ['20990101000000', EXPECTED_REMOTE_TO_LOCAL['20260716151011']],
    ],
  });
  assert.throws(() => verifyMigrationSnapshot(snapshot, expectedLocalFiles), /remote history: unexpected 20990101000000/);
});

test('rejects a missing local migration file', () => {
  assert.throws(
    () => verifyMigrationSnapshot(
      exactSnapshot,
      expectedLocalFiles.filter((filename) => !filename.startsWith('20260727110105_')),
    ),
    /local migration files: missing 20260727110105_add_public_ccs_schedule/,
  );
});

test('rejects a changed remote-to-local mapping', () => {
  const changed = exactMappingPairs.map(([remote, local]) => [
    remote,
    remote === '20260716151011' ? '202607160002_harden_team_workspace' : local,
  ]);
  assert.throws(
    () => verifyMigrationSnapshot(JSON.stringify({ remote_to_local: changed }), expectedLocalFiles),
    /mapping: 20260716151011 must map to 202607160001_initial_team_workspace/,
  );
});

test('rejects an empty strong mapping value', () => {
  const changed = exactMappingPairs.map(([remote, local]) => [remote, remote === '20260716151011' ? '' : local]);
  assert.throws(
    () => verifyMigrationSnapshot(JSON.stringify({ remote_to_local: changed }), expectedLocalFiles),
    /Invalid local migration value/,
  );
});

test('rejects duplicate semantic mapping pairs and legacy object mappings', () => {
  const duplicate = [...exactMappingPairs, exactMappingPairs[0]];
  assert.throws(
    () => verifyMigrationSnapshot(JSON.stringify({ remote_to_local: duplicate }), expectedLocalFiles),
    /remote history: duplicate/,
  );
  assert.throws(
    () => verifyMigrationSnapshot(
      JSON.stringify({ remote_to_local: EXPECTED_REMOTE_TO_LOCAL }),
      expectedLocalFiles,
    ),
    /remote_to_local must be an array/,
  );
});

test('rejects conflicting JSON snapshot shapes', () => {
  assert.throws(
    () => verifyMigrationSnapshot(
      JSON.stringify({ remote_to_local: exactMappingPairs, migrations: [] }),
      expectedLocalFiles,
    ),
    /exactly one supported shape/,
  );
});

test('rejects quote-wrapped identifiers outside display tables', () => {
  const quoted = exactMappingPairs.map(([remote, local], index) => (
    index === 0 ? [`\`${remote}\``, local] : [remote, local]
  ));
  assert.throws(
    () => verifyMigrationSnapshot(JSON.stringify({ remote_to_local: quoted }), expectedLocalFiles),
    /Invalid remote migration version/,
  );
});

test('rejects filesystem basenames that the Supabase CLI ignores', () => {
  const uppercase = [...expectedLocalFiles];
  uppercase[0] = uppercase[0].replace(/\.sql$/, '.SQL');
  assert.throws(
    () => verifyMigrationSnapshot(exactSnapshot, uppercase),
    /exact lowercase \.sql basename/,
  );

  const padded = [...expectedLocalFiles];
  padded[0] = ` ${padded[0]}`;
  assert.throws(
    () => verifyMigrationSnapshot(exactSnapshot, padded),
    /Invalid local migration value/,
  );

  const quoted = [...expectedLocalFiles];
  quoted[0] = `\`${quoted[0]}\``;
  assert.throws(
    () => verifyMigrationSnapshot(exactSnapshot, quoted),
    /exact lowercase \.sql basename/,
  );
});

test('rejects a remote-only timestamp snapshot', () => {
  const snapshot = JSON.stringify({ migrations: expectedOldRemote.map((remote) => ({ remote })) });
  assert.throws(
    () => verifyMigrationSnapshot(snapshot, expectedLocalFiles),
    /snapshot local history: missing/,
  );
});

test('rejects a truncated local timestamp instead of expanding it', () => {
  const local = [...expectedLocalVersions];
  local[0] = local[0].slice(0, -1);
  assert.throws(
    () => verifyMigrationSnapshot(cliTable(expectedOldRemote, local), expectedLocalFiles),
    /Invalid local migration value/,
  );
});

test('rejects duplicate remote and local snapshot rows', () => {
  assert.throws(
    () => verifyMigrationSnapshot(
      cliTable([...expectedOldRemote, expectedOldRemote[0]], expectedLocalVersions),
      expectedLocalFiles,
    ),
    /remote history: duplicate/,
  );
  assert.throws(
    () => verifyMigrationSnapshot(
      cliTable(expectedOldRemote, [...expectedLocalVersions, expectedLocalVersions[0]]),
      expectedLocalFiles,
    ),
    /snapshot local history: duplicate/,
  );
});

test('rejects malformed remote values including .sql suffixes', () => {
  const remote = [...expectedOldRemote];
  remote[0] = `${remote[0]}.sql`;
  assert.throws(
    () => verifyMigrationSnapshot(cliTable(remote, expectedLocalVersions), expectedLocalFiles),
    /Invalid remote migration version/,
  );
});

test('ignores prose mentioning local and remote before the exact table header', () => {
  const snapshot = cliTable(expectedOldRemote, expectedLocalVersions, {
    prose: 'Local and remote histories were captured for review.\nLOCAL │ REMOTE │ NOTES\n',
  });
  assert.equal(verifyMigrationSnapshot(snapshot, expectedLocalFiles).remoteCount, 20);
});
