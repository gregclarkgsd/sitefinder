# Supabase migration-history repair (SiteFinder)

## Purpose and boundary

This runbook repairs **only** the Supabase migration-history ledger. It does not
run schema SQL, alter application data, change RLS, deploy Edge Functions, or
run `supabase db push`.

The live schema objects were semantically checked against these local
migrations. The problem is solely that the remote ledger recorded the first 20
migrations using the timestamps shown in the first column below, while the
repository uses the local filename timestamps in the second column.

**Do not run `supabase db push`, `supabase db reset`, `supabase migration up`,
or any schema-changing command before this repair is reviewed and complete.**
Those commands can misinterpret history drift as unapplied schema work.

## Verified remote-to-local mapping

| Remote history version | Local migration filename (without `.sql`) |
| --- | --- |
| `20260716151011` | `202607160001_initial_team_workspace` |
| `20260716151126` | `202607160002_harden_team_workspace` |
| `20260716155210` | `20260716155113_add_ccs_history_and_pipeline` |
| `20260716155509` | `20260716155451_enable_nightly_ccs_sync` |
| `20260717050143` | `20260717050119_add_project_tasks` |
| `20260727091404` | `20260727091353_expand_ccs_project_details` |
| `20260727100418` | `20260727100331_add_outreach_queue_and_history` |
| `20260727100917` | `20260727104500_queue_new_ccs_projects_for_outreach` |
| `20260727101025` | `20260727105800_harden_outreach_policies_and_indexes` |
| _missing remotely_ | `20260727110105_add_public_ccs_schedule` |
| `20260727111614` | `20260727111332_add_attio_sync_tracking` |
| `20260727111857` | `20260727111827_optimise_sitefinder_rls_and_foreign_keys` |
| `20260727210802` | `20260727203557_add_attio_project_links_and_enrichment` |
| `20260728202441` | `20260728185448_add_research_agent_control_room` |
| `20260729115834` | `20260729122000_attio_contacts_and_gmail_outreach` |
| `20260729120830` | `20260729123000_multi_gsd_mailboxes` |
| `20260729213605` | `20260729185344_preserve_outreach_compliance_history` |
| `20260729213622` | `20260729185749_add_outreach_send_claim_state` |
| `20260729213633` | `20260729191614_scope_gmail_message_ids_to_mailboxes` |
| `20260729213700` | `20260729203556_enforce_research_candidate_approval` |
| `20260730112908` | `20260730103000_add_licensed_research_email_status` |

The expected final state is 21 local and remote history entries: the 20 mapped
entries above plus `20260727110105_add_public_ccs_schedule` marked as applied.

## Preflight and backup

1. Freeze database/schema deployments and tell the team that the ledger is
   being repaired.
2. Confirm that a restorable Supabase platform backup exists, then create a
   separate timestamped CLI database dump for this repair. Store the dump and
   relevant project-configuration record outside the repository. Do not commit
   exports, access tokens, connection strings, or snapshots containing
   secrets.

   ```sh
   npx --no-install supabase db dump --linked --file /secure/path/sitefinder-schema-before.sql
   npx --no-install supabase db dump --linked --data-only --use-copy --file /secure/path/sitefinder-data-before.sql
   npx --no-install supabase db dump --linked --role-only --file /secure/path/sitefinder-roles-before.sql
   ```

   Let the CLI prompt for the database password; never supply it as a command
   argument or place it in shell history.
3. Record the deployed application commit and a timestamped, access-controlled
   snapshot. Capture both the CLI's JSON output and a separately reviewed
   **name/version mapping**. The CLI output proves the exact local and remote
   timestamp sets; the mapping proves the semantic association in the table
   above.

   ```sh
   npx --no-install supabase migration list --linked --output-format json \
     > /secure/path/migration-list-before.json
   ```

   Also export `version`, `name`, and `statements` from
   `supabase_migrations.schema_migrations` using the Supabase SQL editor and
   store that export with the backup. Those values are required for a
   separately reviewed restoration after a fully completed repair because the
   old remote timestamps do not have corresponding local migration files.
4. Confirm the repository is clean and at the reviewed commit. Confirm that
   `supabase/migrations` contains exactly the 21 expected SQL filenames.
5. Run the repository guard against the saved snapshot. It is read-only and
   must pass before any human enters a repair command:

   ```sh
   node scripts/verify-supabase-migration-drift.mjs \
     --state before /secure/path/migration-list-before.json
   ```

   A JSON snapshot may use the explicit, audit-friendly shape:

   ```json
   {
     "remote_to_local": [
       ["20260716151011", "202607160001_initial_team_workspace"]
     ]
   }
   ```

   The tool accepts the CLI's JSON output and ANSI/backtick-decorated
   `LOCAL │ REMOTE │ TIME` tables. It requires the real before-state shape:
   20 remote-only rows and 21 local-only rows. A JSON mapping is the stronger
   semantic audit record. The guard rejects missing, added, malformed,
   truncated, or duplicate versions; missing local columns; changed filenames;
   and changed mappings. It never connects to Supabase or performs a repair.

## Human-only repair procedure

The repository pins Supabase CLI `2.110.0`. On the authorised operator's
machine, link the repository explicitly to the verified SiteFinder project;
the command may prompt for the database password, which must never be added to
shell history, a snapshot, or the repository:

```sh
npx --no-install supabase link --project-ref oihmehqrwdvajzyxvuhz
npx --no-install supabase migration list --linked --output-format json
```

After the read-only guard passes and a human confirms the output is the exact
verified fingerprint, use this two-phase **history-only** repair. Each batch is
transactional, but the two commands together are not. Applying the 21 local
versions first preserves the original remote entries until the intermediate
state has been proved.

`migration repair` executes supplied versions without a confirmation prompt.
Re-check the project ref and every version before pressing Enter.

### Phase 1: add all reviewed local versions

```sh
npx --no-install supabase migration repair --linked --status applied 202607160001 202607160002 20260716155113 20260716155451 20260717050119 20260727091353 20260727100331 20260727104500 20260727105800 20260727110105 20260727111332 20260727111827 20260727203557 20260728185448 20260729122000 20260729123000 20260729185344 20260729185749 20260729191614 20260729203556 20260730103000
```

Capture and verify the intermediate state before removing anything. It must
contain 21 paired local/remote versions plus the original 20 remote-only
versions:

```sh
npx --no-install supabase migration list --linked --output-format json \
  > /secure/path/migration-list-intermediate.json
node scripts/verify-supabase-migration-drift.mjs \
  --state intermediate /secure/path/migration-list-intermediate.json
```

If phase 1 or this guard fails, do not assume the CLI exit status proves whether
the server committed. Capture a fresh migration-list snapshot immediately:

- If the `before` guard passes, the original ledger is intact.
- If the `intermediate` guard passes, either continue after review or restore
  the original state with the exact recovery command below.
- If neither guard passes, stop all ledger commands and begin incident review.
  Do not guess which rows committed.

The recovery command is allowed only from a proved intermediate state:

```sh
npx --no-install supabase migration repair --linked --status reverted 202607160001 202607160002 20260716155113 20260716155451 20260717050119 20260727091353 20260727100331 20260727104500 20260727105800 20260727110105 20260727111332 20260727111827 20260727203557 20260728185448 20260729122000 20260729123000 20260729185344 20260729185749 20260729191614 20260729203556 20260730103000
```

After recovery, capture a new snapshot and prove the `before` state. A
non-zero recovery exit also requires a fresh snapshot; never infer remote state
from the client response alone.

### Phase 2: remove the superseded remote timestamps

Only after the intermediate guard passes:

```sh
npx --no-install supabase migration repair --linked --status reverted 20260716151011 20260716151126 20260716155210 20260716155509 20260717050143 20260727091404 20260727100418 20260727100917 20260727101025 20260727111614 20260727111857 20260727210802 20260728202441 20260729115834 20260729120830 20260729213605 20260729213622 20260729213633 20260729213700 20260730112908
```

These commands change only the history ledger. If the CLI proposes executing
schema SQL, stop. That is outside this repair.

If the phase-2 command returns an error or loses its connection, recapture the
ledger before doing anything else. If the `after` guard passes, the server
committed and the repair is complete despite the client-side failure. If the
`intermediate` guard passes, use the exact 21-version recovery command above
and prove the `before` state. If neither passes, stop and begin incident
review. Never infer server state from the CLI exit alone.

Never try to recreate an old remote entry with `--status applied`: CLI 2.110.0
requires a corresponding local migration file, and those 20 old filenames do
not exist.

## Postflight checks

1. Save and verify the final JSON snapshot. It must show all 21 local version
   timestamps applied remotely and no superseded remote timestamps:

   ```sh
   npx --no-install supabase migration list --linked --output-format json \
     > /secure/path/migration-list-after.json
   node scripts/verify-supabase-migration-drift.mjs \
     --state after /secure/path/migration-list-after.json
   ```
2. Compare the schema/app health checks captured before repair with the same
   checks afterwards. The repair must not change table counts, policies,
   functions, storage, Edge Functions, or application behaviour.
3. Run the project's unit/integration checks and a short safe application smoke
   test. Keep the before/after snapshots and operator log with the deployment
   record.
4. Run the non-mutating schema-history proof:

   ```sh
   npx --no-install supabase db push --linked --dry-run
   ```

   It must report no pending migrations. If it proposes SQL, stop and restore
   the ledger from the before-snapshot; do not allow it to push.
5. Only then may a separately reviewed schema migration be planned. Never use a
   non-dry-run `db push` as a shortcut to test this repair.

## Rollback / stop conditions

Stop immediately if the guard fails, the schema does not match the verified
baseline, a remote version is not in the table, or the CLI proposes SQL/schema
execution.

Before phase 2 completes, use the phase-specific recovery above.

After a successful phase 2, there is no safe generic CLI rollback because the
20 old timestamps have no corresponding local files. Any restoration must be a
separately reviewed incident procedure that uses the secure pre-repair export
of `version`, `name`, and `statements` in a single database transaction, then
re-runs the before-state guard and schema health checks. Do not improvise that
transaction during the repair, and never restore a full database backup merely
to change migration history unless incident response establishes a genuine
schema or data problem.
