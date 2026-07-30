#!/usr/bin/env node

/** Read-only guard for the known SiteFinder Supabase migration-history drift. */
import fs from 'node:fs';
import process from 'node:process';

const MIGRATION_SUFFIX = /\.sql$/i;
const REPAIR_STATES = new Set(['before', 'intermediate', 'after']);

export const EXPECTED_REMOTE_TO_LOCAL = Object.freeze({
  '20260716151011': '202607160001_initial_team_workspace',
  '20260716151126': '202607160002_harden_team_workspace',
  '20260716155210': '20260716155113_add_ccs_history_and_pipeline',
  '20260716155509': '20260716155451_enable_nightly_ccs_sync',
  '20260717050143': '20260717050119_add_project_tasks',
  '20260727091404': '20260727091353_expand_ccs_project_details',
  '20260727100418': '20260727100331_add_outreach_queue_and_history',
  '20260727100917': '20260727104500_queue_new_ccs_projects_for_outreach',
  '20260727101025': '20260727105800_harden_outreach_policies_and_indexes',
  '20260727111614': '20260727111332_add_attio_sync_tracking',
  '20260727111857': '20260727111827_optimise_sitefinder_rls_and_foreign_keys',
  '20260727210802': '20260727203557_add_attio_project_links_and_enrichment',
  '20260728202441': '20260728185448_add_research_agent_control_room',
  '20260729115834': '20260729122000_attio_contacts_and_gmail_outreach',
  '20260729120830': '20260729123000_multi_gsd_mailboxes',
  '20260729213605': '20260729185344_preserve_outreach_compliance_history',
  '20260729213622': '20260729185749_add_outreach_send_claim_state',
  '20260729213633': '20260729191614_scope_gmail_message_ids_to_mailboxes',
  '20260729213700': '20260729203556_enforce_research_candidate_approval',
  '20260730112908': '20260730103000_add_licensed_research_email_status',
});

export const REQUIRED_LOCAL_ONLY_MIGRATION = '20260727110105_add_public_ccs_schedule';

const EXPECTED_LOCAL_STEMS = Object.freeze([
  ...Object.values(EXPECTED_REMOTE_TO_LOCAL),
  REQUIRED_LOCAL_ONLY_MIGRATION,
]);
const LOCAL_STEM_SET = new Set(EXPECTED_LOCAL_STEMS);
const LOCAL_VERSION_TO_STEM = new Map(EXPECTED_LOCAL_STEMS.map((stem) => [stem.split('_')[0], stem]));
const EXPECTED_OLD_REMOTE = Object.freeze(Object.keys(EXPECTED_REMOTE_TO_LOCAL));
const EXPECTED_LOCAL_VERSIONS = Object.freeze([...LOCAL_VERSION_TO_STEM.keys()]);

const stripTerminalFormatting = (value) => String(value)
  .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
  .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');

function stripCellWrapping(value) {
  let cell = String(value ?? '').trim();
  if (cell.length >= 2) {
    const first = cell[0];
    const last = cell[cell.length - 1];
    if (first === last && ['`', "'", '"'].includes(first)) cell = cell.slice(1, -1).trim();
  }
  return cell;
}

function parseRemote(value, { displayCell = false } = {}) {
  const remote = displayCell ? stripCellWrapping(value) : String(value ?? '');
  if (!remote) return '';
  if (!/^\d{12,14}$/.test(remote)) {
    throw new Error(`Invalid remote migration version "${remote}"; expected a bare migration timestamp.`);
  }
  return remote;
}

function parseLocal(value, { requireStem = false, displayCell = false } = {}) {
  const local = displayCell ? stripCellWrapping(value) : String(value ?? '');
  if (!local) {
    if (requireStem) throw new Error('Invalid local migration value ""; expected a non-empty exact filename stem.');
    return '';
  }
  if (MIGRATION_SUFFIX.test(local)) {
    throw new Error(`Invalid local migration value "${local}"; snapshots must not include .sql.`);
  }
  if (LOCAL_STEM_SET.has(local)) return local;
  if (!requireStem && LOCAL_VERSION_TO_STEM.has(local)) return LOCAL_VERSION_TO_STEM.get(local);
  throw new Error(
    `Invalid local migration value "${local}"; expected an exact known version${requireStem ? ' and filename stem' : ''}.`,
  );
}

function rowsFromMapping(mapping) {
  if (!Array.isArray(mapping)) {
    throw new Error('remote_to_local must be an array of exact [remote, local filename stem] pairs.');
  }
  return mapping.map((pair) => {
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new Error('Every remote_to_local entry must be an exact two-item [remote, local] pair.');
    }
    return {
      remote: parseRemote(pair[0]),
      local: parseLocal(pair[1], { requireStem: true }),
    };
  });
}

function migrationRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error('Every migrations entry must be an object with LOCAL and/or REMOTE values.');
  }
  const remote = parseRemote(row.remote ?? row.remote_version ?? '');
  const local = parseLocal(row.local ?? row.local_version ?? row.filename ?? '');
  if (!remote && !local) throw new Error('Migration snapshot row has neither a local nor a remote version.');
  return { remote, local };
}

function rowsFromJson(parsed) {
  if (Array.isArray(parsed)) return { strength: 'timestamp', rows: parsed.map(migrationRow) };
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Unsupported JSON snapshot. Use remote_to_local, migrations, or remote/local arrays.');
  }
  const hasMapping = Object.hasOwn(parsed, 'remote_to_local');
  const hasMigrations = Object.hasOwn(parsed, 'migrations');
  const hasRemoteOrLocal = Object.hasOwn(parsed, 'remote') || Object.hasOwn(parsed, 'local');
  const recognizedShapes = [hasMapping, hasMigrations, hasRemoteOrLocal].filter(Boolean).length;
  if (recognizedShapes !== 1) {
    throw new Error('JSON snapshot must contain exactly one supported shape.');
  }
  if (hasMapping) {
    return { strength: 'mapping', rows: rowsFromMapping(parsed.remote_to_local) };
  }
  if (hasMigrations && Array.isArray(parsed.migrations)) {
    return { strength: 'timestamp', rows: parsed.migrations.map(migrationRow) };
  }
  if (hasRemoteOrLocal && Array.isArray(parsed.remote) && Array.isArray(parsed.local)) {
    return {
      strength: 'timestamp',
      rows: [
        ...parsed.remote.map((remote) => ({ remote: parseRemote(remote), local: '' })),
        ...parsed.local.map((local) => ({ remote: '', local: parseLocal(local) })),
      ],
    };
  }
  throw new Error('Unsupported JSON snapshot. Use pair-array remote_to_local, migrations, or both remote and local arrays.');
}

const splitTableRow = (line) => line.split(/[|│]/).map((cell) => stripCellWrapping(cell));

function rowsFromText(snapshot) {
  const lines = stripTerminalFormatting(snapshot).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const headerIndex = lines.findIndex((line) => {
    if (!/[|│]/.test(line)) return false;
    const cells = splitTableRow(line).map((cell) => cell.toLowerCase());
    return cells.includes('local') && cells.includes('remote') && cells.includes('time (utc)');
  });
  if (headerIndex < 0) throw new Error('Text snapshot needs an exact delimited LOCAL and REMOTE table header.');
  const header = splitTableRow(lines[headerIndex]).map((cell) => cell.toLowerCase());
  const remoteIndex = header.indexOf('remote');
  const localIndex = header.indexOf('local');
  return {
    strength: 'timestamp',
    rows: lines.slice(headerIndex + 1)
      .filter((line) => /[|│]/.test(line) && !/^[-─┼|│\s]+$/.test(line))
      .map(splitTableRow)
      .map((cells) => ({
        remote: parseRemote(cells[remoteIndex], { displayCell: true }),
        local: parseLocal(cells[localIndex], { displayCell: true }),
      }))
      .filter((row) => row.remote || row.local),
  };
}

export function parseMigrationSnapshot(snapshot) {
  const text = String(snapshot).trim();
  if (!text) throw new Error('Snapshot is empty.');
  try {
    return rowsFromJson(JSON.parse(text));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return rowsFromText(text);
  }
}

function compareSets(actual, expected, label, errors) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const unexpected = [...actualSet].filter((value) => !expectedSet.has(value));
  const missing = [...expectedSet].filter((value) => !actualSet.has(value));
  if (unexpected.length) errors.push(`${label}: unexpected ${unexpected.join(', ')}`);
  if (missing.length) errors.push(`${label}: missing ${missing.join(', ')}`);
}

function findDuplicates(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function expectedRemoteForState(state) {
  if (state === 'before') return EXPECTED_OLD_REMOTE;
  if (state === 'intermediate') return [...EXPECTED_OLD_REMOTE, ...EXPECTED_LOCAL_VERSIONS];
  return EXPECTED_LOCAL_VERSIONS;
}

function validateTimestampTopology(rows, state, errors) {
  const paired = rows.filter((row) => row.remote && row.local);
  const remoteOnly = rows.filter((row) => row.remote && !row.local);
  const localOnly = rows.filter((row) => !row.remote && row.local);
  const expectedCounts = {
    before: { paired: 0, remoteOnly: 20, localOnly: 21 },
    intermediate: { paired: 21, remoteOnly: 20, localOnly: 0 },
    after: { paired: 21, remoteOnly: 0, localOnly: 0 },
  }[state];

  if (
    paired.length !== expectedCounts.paired
    || remoteOnly.length !== expectedCounts.remoteOnly
    || localOnly.length !== expectedCounts.localOnly
  ) {
    errors.push(
      `row topology: expected ${expectedCounts.paired} paired, ${expectedCounts.remoteOnly} remote-only, `
      + `${expectedCounts.localOnly} local-only; found ${paired.length} paired, ${remoteOnly.length} remote-only, `
      + `${localOnly.length} local-only`,
    );
  }

  const mismatchedPairs = paired
    .filter((row) => row.remote !== row.local.split('_')[0])
    .map((row) => `${row.local.split('_')[0]}→${row.remote}`);
  if (mismatchedPairs.length) {
    errors.push(`row topology: paired LOCAL and REMOTE versions differ (${mismatchedPairs.join(', ')})`);
  }

  if (state === 'intermediate') {
    compareSets(
      remoteOnly.map((row) => row.remote),
      EXPECTED_OLD_REMOTE,
      'intermediate remote-only history',
      errors,
    );
  }
}

export function verifyMigrationSnapshot(snapshot, localFilenames, state = 'before') {
  if (!REPAIR_STATES.has(state)) throw new Error(`Unknown repair state "${state}".`);
  const { rows, strength } = parseMigrationSnapshot(snapshot);
  const errors = [];
  const remoteValues = rows.map((row) => row.remote).filter(Boolean);
  const snapshotLocal = rows.map((row) => row.local).filter(Boolean);
  const localFiles = localFilenames.map((filename) => {
    const rawFilename = String(filename ?? '');
    if (!rawFilename.endsWith('.sql')) {
      throw new Error(`Invalid migration filename "${rawFilename}"; expected an exact lowercase .sql basename.`);
    }
    return parseLocal(rawFilename.slice(0, -4), { requireStem: true });
  });

  const duplicateRemote = findDuplicates(remoteValues);
  const duplicateSnapshotLocal = findDuplicates(snapshotLocal);
  const duplicateLocalFiles = findDuplicates(localFiles);
  if (duplicateRemote.length) errors.push(`remote history: duplicate ${duplicateRemote.join(', ')}`);
  if (duplicateSnapshotLocal.length) errors.push(`snapshot local history: duplicate ${duplicateSnapshotLocal.join(', ')}`);
  if (duplicateLocalFiles.length) errors.push(`local migration files: duplicate ${duplicateLocalFiles.join(', ')}`);

  compareSets(remoteValues, expectedRemoteForState(state), 'remote history', errors);
  compareSets(localFiles, EXPECTED_LOCAL_STEMS, 'local migration files', errors);

  if (strength === 'mapping') {
    if (state !== 'before') errors.push('explicit remote_to_local mappings are valid only for the before state');
    compareSets(snapshotLocal, Object.values(EXPECTED_REMOTE_TO_LOCAL), 'mapped local history', errors);
    const actualMapping = new Map(rows.map((row) => [row.remote, row.local]));
    for (const [remote, expectedLocalName] of Object.entries(EXPECTED_REMOTE_TO_LOCAL)) {
      if (actualMapping.get(remote) !== expectedLocalName) {
        errors.push(`mapping: ${remote} must map to ${expectedLocalName}`);
      }
    }
  } else {
    compareSets(snapshotLocal, EXPECTED_LOCAL_STEMS, 'snapshot local history', errors);
    validateTimestampTopology(rows, state, errors);
  }

  if (errors.length) throw new Error(`Migration ${state} fingerprint does not match:\n- ${errors.join('\n- ')}`);
  return {
    state,
    remoteCount: expectedRemoteForState(state).length,
    localCount: localFiles.length,
    localOnlyMigration: REQUIRED_LOCAL_ONLY_MIGRATION,
  };
}

function cli() {
  const args = process.argv.slice(2);
  const stateFlag = args.indexOf('--state');
  let state = 'before';
  if (stateFlag >= 0) {
    state = args[stateFlag + 1];
    args.splice(stateFlag, 2);
  }
  const [snapshotPath, migrationsDirectory = 'supabase/migrations'] = args;
  if (!snapshotPath) {
    process.stderr.write(
      'Usage: node scripts/verify-supabase-migration-drift.mjs [--state before|intermediate|after] '
      + '<snapshot.json|snapshot.txt> [migrations-directory]\n',
    );
    process.exitCode = 2;
    return;
  }
  const snapshot = fs.readFileSync(snapshotPath, 'utf8');
  const migrationEntries = fs.readdirSync(migrationsDirectory, { withFileTypes: true })
    .filter((entry) => entry.name.toLowerCase().endsWith('.sql'));
  const nonFiles = migrationEntries.filter((entry) => !entry.isFile()).map((entry) => entry.name);
  if (nonFiles.length) throw new Error(`Migration directory contains non-file SQL entries: ${nonFiles.join(', ')}`);
  const localFilenames = migrationEntries.map((entry) => entry.name);
  const report = verifyMigrationSnapshot(snapshot, localFilenames, state);
  process.stdout.write(
    `Verified ${report.state} migration-history state: ${report.remoteCount} remote, `
    + `${report.localCount} local; local-only ${report.localOnlyMigration}.\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) cli();
