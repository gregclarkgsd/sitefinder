# Lemlist review-only prototype

This version produces a local review record and a proposed request. It never calls
Lemlist, starts/reviews a campaign, writes to Supabase, or changes Gmail behavior.
There is no API key setting, network client, automatic-send switch, or live adapter.
`automaticSending: false` is enforced in the store. A review record is not an
enrollment and must never be used as permission to send later without fresh checks.

## Why direct lead mapping

Dan requested an agent that feeds a dedicated campaign. The agent's first stage
here is a deterministic review tool. The documented direct lead API accepts
`projectName` as an additional body field, used in copy as `{{projectName}}`:
https://developer.lemlist.com/api-reference/endpoints/leads/create-lead-in-campaign

The preview uses `deduplicate=true&updateStrategy=fillEmptyOnly`. Default API
duplicate handling does not provide the same cross-campaign check. Existing
contact/company fields may be retained; a future adapter must inspect warnings
and read back the variable values before allowing a test. The API documentation
supports this mapping; this repository has not verified it against a live account.
External signal `customFields` are a different interface: no automatic mapping
from those fields to the lead's `projectName` has been established.

## Local use

Run `node --test lemlist-review.test.js` (no dependencies required). Tests only use
synthetic projects and reserved `example.invalid` addresses, never an external
submission. The CLI takes an explicit local state file and JSON input:

```
node scripts/lemlist-review.mjs init .lemlist-review/state.json config.json
node scripts/lemlist-review.mjs review .lemlist-review/state.json review-input.json
```

For config/input shapes see `config` and `fixture()` in `lemlist-review.test.js`.
Choose a future timestamp when using the CLI; fixed test dates are synthetic.
`evidenceMode: "mock"` stays visible in every candidate. The CLI accepts operator
evidence; it does not independently verify checked booleans against live services.
Do not label handwritten events as database evidence. `database` mode is reserved
for an independently verified export after capture installation, not proof itself.

Keep all review data outside Git; `.lemlist-review/` is ignored. Use one state
file for this integration across campaign iterations: separate files would bypass
local duplicate reservations. Protect and back up the file as contact data. The
single-host writer lock fails closed, including after an interrupted process. A
stale lock requires inspecting the store/temp file before manual recovery. Do not
delete the store to rerun outreach. This is not a distributed or adversary-resistant
database; the boundary hash detects accidental changes, not malicious rewrites.

## Boundary and genuine inserts

SiteFinder's first database sync baseline is unrelated to campaign launch. Require
both `discovered_after_baseline === true` and `first_seen_at > goLiveAt` (strictly
after), and exclude all IDs present when capture is initialized. An updated row,
new queue timestamp or recent `last_changed_at` is never proof of insertion.

`docs/lemlist-insert-capture.sql` is an **unapplied**, operator-reviewed SQL design,
deliberately outside automatic migrations. It creates private append-only capture
tables and an AFTER INSERT trigger, then exposes a one-time initializer which
locks the project table, saves the future boundary and snapshots excluded IDs in
one transaction. It does not enroll anything. It preserves IDs across project
deletion/reimport and does not capture UPDATE events. Do not deploy or execute this
script as part of reviewing this branch. It still needs local PostgreSQL/Supabase
execution tests before promotion to an approved migration.

The future export adapter must map its `id`, `capture_id`, `captured_at`, `project`
to the module's `id`, `captureId`, `capturedAt`, `project`, adding literal INSERT and
the verified evidence mode. It must prove which successfully completed CCS sync
created the row. The current sync does not store that run ID on each project:
**add and test durable insert-to-sync-run linkage before claiming automated
eligibility**; do not infer completion from an unrelated successful later run.
Partial/failed runs must remain held. Trigger rollback follows the source insert
transaction, but the sync itself uses multiple batches and is not one transaction.

## Required review evidence

The module requires checks no older than 15 minutes, bound to the exact insert and
project. Review the current project's active/closure state, validated recipient
and tender relevance, and verified company identity (Attio ID or verified domain).
Never use a display-name-only company match. Choose one canonical company key;
aliases/domains must resolve to it so alternate keys cannot evade deduplication.

Complete history must include SiteFinder communications, queued/approved/sending/
uncertain Gmail work, active follow-ups, Attio relationships and existing Lemlist/
Woodpecker campaigns where used. Suppression checks must include all those systems,
not merely absence from the local table. Unknown, stale or failed checks hold.
Replies, bounces and opt-outs hold. Resolve actual Sam/Greg ownership and get the
owner's review; default email signatures are not ownership evidence.

The approved contact supplies firstName/lastName/companyName/jobTitle/phone. Do not
attach CCS manager identity to an unrelated email. `projectName` comes from the
immutable project snapshot; later renames require manual reconciliation, not
silently changing a sequence. Missing project names and ID placeholders hold.

The local ledger reserves project ID, normalized email and canonical company key
for accepted review candidates, independent of campaign ID. Reopening/replaying
does not create another candidate. Holds can be reevaluated with fresh evidence
for the same immutable insert event. Duplicate companies/contacts require human
consolidation into one conversation; this prototype intentionally has no override.

## Before any separately authorized live test

1. Verify this branch and database script locally; confirm deployed schema/version.
2. Agree the future cutoff, dedicated paused campaign, Sam/Greg ownership rules,
   canonical company matching and approved copy requesting decorating tenders.
3. Approve and implement the capture/export adapter and durable sync-run linkage.
   Prove complete snapshot pagination, initialization races, rollback and reimports.
4. Replace operator attestations with authenticated, fail-closed reads and audit
   references for each evidence source. Keep secrets server-side via an approved
   connection; do not paste keys into files or chat.
5. Add an explicit provider selection and atomic cross-provider claim respected
   by both Gmail and Lemlist before any external submission. This branch has no
   production mutual-exclusion guard because it cannot submit. Do not simply wire
   its output into the existing Gmail "Approve and send" handler.
6. Use a database-backed unique enrollment ledger for multiple workers, retain
   rejected/excluded IDs, and add reconciliation for unknown API outcomes. Never
   blindly retry a timed-out enrollment. Import existing cross-provider history.
7. Implement authenticated, idempotent reply/bounce/unsubscribe event handling and
   shared suppression updates; recheck immediately before enrollment/send.
8. With separate permission, use only an owned test address in a paused campaign
   with automatic launch disabled. Read back `projectName`, preview rendered copy,
   and test duplicate rejection. Do not call campaign launch/review endpoints.

No production or live Lemlist verification is claimed by these tests.
