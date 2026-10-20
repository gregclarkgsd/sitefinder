# Lemlist review-only prototype

The offline review path produces a local record and a proposed request. It never
calls Lemlist, starts/reviews a campaign or writes to Supabase. The optional sync
linkage and Gmail guard hooks described below are disabled by default and have not
been deployed; existing Gmail behavior is unchanged with those flags unset.
There is no API key setting, Lemlist network client or automatic-send switch.
Read-only adapters accept injected source clients; no live clients are connected.
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

The actual target was supplied privately and is retained only in the ignored
local `.lemlist-review/target.private.json`. It was not read or changed remotely.
`docs/lemlist-target.example.json` uses a fictitious campaign, team and sender;
it is not an export of account settings. It intentionally has no go-live date or
capture ID and fails initialization until the independent boundary/snapshot
prerequisites are satisfied. It cannot enable sending. Blank variable previews
with no selected lead do not verify or disprove mapping: test `{{firstName}}` and
`{{projectName}}` against an approved fixture before any separately authorized
live enrollment. Actual sender, signature and manual/draft settings need review.

Run `node --test lemlist-review.test.js lemlist-adapters.test.js` (no dependencies required). Tests only use
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
script against a live database as part of reviewing this branch. Focused SQL tests
use an in-memory PostgreSQL engine with synthetic schema/data (see below); the full
Supabase migration/RLS suite remains a separate prerequisite.

`LEMLIST_INSERT_CAPTURE_ENABLED` is unset by default. Only an exact `true` adds the
current run ID to sync upserts. The proposed SQL preserves the original ID on all
updates, including NULL for historical records, and captures that ID on insertion.
`buildDatabaseReview` checks that the event, current project and original snapshot
all point to the same completed sync, with valid start/insert/completion times.
Missing/running/failed/unrelated runs hold. Do not enable this flag before the
separately approved SQL is installed. No flags are enabled by this branch.

The trigger rolls back with the source insert, but sync batches are separate
transactions. The completion check is therefore necessary even with capture.

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

## Read adapters and provider guard

`lemlist-adapters.js` provides a read-only Supabase port with ordered pagination
and an injected provider pagination contract. `buildDatabaseReview` combines the
captured event, boundary/exclusions, original sync, current project, tracking,
outreach leads/history/suppressions and provider reservations with complete
Lemlist/Woodpecker/Attio snapshots and a fresh owner-approved contact review.
Provider snapshots must normalize each record into `email`, canonical `companyKey`,
optional `projectId`/`ownerEmail`, and explicit `active`, `contacted`, `suppressed`,
`bounced`, `replied` booleans. Missing flags, missing sources, stale checks, invalid
pagination or read errors hold. An unused provider still needs an explicitly
verified empty snapshot, not a silent fallback. No real provider API or campaign
is read during tests. Provider-specific GET transports and private-schema read
access must be reviewed/configured separately; no permissions are changed here.
The `database` label describes the adapter contract, not proof that tests used a
live database. All committed fixtures are mocked.

`docs/outreach-provider-guard.sql` is also outside automatic migrations. It defines
fresh identity-bound checks and permanent unique project/email/company claims.
Gmail's initial and follow-up paths call its RPC only when the unconfigured
`OUTREACH_PROVIDER_GUARD_ENABLED` equals `true`; otherwise behavior is unchanged.
When enabled, missing schema/checks, owner/sender conflicts, suppressions, replies,
stale history or another provider's reservation block Gmail before token retrieval
and before its existing per-message claim. Existing Gmail message claims continue
to prevent concurrent sends for the same lead. Matching provider reservations can
be reused for follow-ups but identities/providers cannot silently switch. Failed
or uncertain sends retain reservations. There is no automatic release operation.

The RPC is restricted to service-role execution in the proposed SQL. A future
authorized orchestrator must write identity-bound checks from complete source
reads; this version only reads evidence, previews requests and tests claims locally.
It cannot write checks or enroll Lemlist leads. Enabling a guard is a deployment
decision, not a way to enable Lemlist sending. Import existing cross-provider
history and resolve company aliases before any activation. The local file queue
is a review artifact; the SQL uniqueness constraints are the multi-worker boundary.

`npm test` runs all Node tests plus these focused SQL checks using pinned PGlite
0.5.10. Run the focused SQL test alone with:

```
node scripts/test-lemlist-sql.mjs
```

This creates an in-memory PostgreSQL database only and executes both proposed SQL
scripts against synthetic tables. It checks capture, rollback, immutable run
linkage, reimports, initialization, provider conflict, suppression, freshness,
unique contact/company constraints and execution grants. It does not substitute
for full production-shaped Supabase/RLS or multi-connection race tests.

Example mocked preview (never submitted):

```json
{"status":"review_only","submitted":false,"body":{"email":"test@example.invalid","projectName":"Mock school","sitefinderProjectId":"site-new"}}
```

## Before any separately authorized live test

The accountable owner and sending mailbox are separate fields: Sam/Greg ownership
must not be replaced with `sender@example.invalid`. The proposed guard binds fresh
checks to both `owner_email` and `sender_email`, permitting a reviewed shared
mailbox while rejecting a mailbox changed after review.

Validation on Northy (2026-10-20): 149 Node tests and 22 focused in-memory
PostgreSQL checks passed; Vite production build passed. A fresh locked offline
install also succeeded. The dependency audit reports the same 12 advisories on
the reviewed base and this branch (3 critical, 5 high, 4 moderate), with no newly
affected packages. Existing dependency remediation remains separate work. Docker
and Deno are unavailable locally, so full Supabase migration/RLS and Deno suite
results must be checked in CI. The focused tests do not prove multi-connection
race handling or production deployment parity. Daniel's campaign link is now
recorded; actual variable readback, sender ownership, signature and draft/manual
campaign settings remain unverified.

CI run 39506400288 at commit 9750aff709476db62c25341f6ed3758f8771238b passed
the complete existing Supabase migration/RLS job, Deno tests, Node tests/build
and research-worker tests/build. Both dependency-audit steps failed. That run
preceded the final fictitious target/shared-sender fixture update; subsequent
head checks are shown on the draft PR.

1. Verify this branch and database script locally; confirm deployed schema/version.
2. Agree the future cutoff, dedicated paused campaign, Sam/Greg ownership rules,
   canonical company matching and approved copy requesting decorating tenders.
3. Validate both proposed SQL scripts on the complete local Supabase schema and
   test initialization/concurrent-claim races with multiple connections. Review
   consistent snapshot/export behavior under concurrent deletes and updates.
4. Connect the read-only ports to authenticated, complete source reads and audit
   references. Keep secrets server-side via an approved connection; do not paste
   keys into files or chat. Configure canonical company identity and owner review.
5. Separately approve SQL deployment and flag activation; populate fresh checks
   only from verified reads. Every future Lemlist writer must use the same claim
   RPC before submission and must retain reservations on unknown API outcomes.
   Do not wire previews into the Gmail "Approve and send" handler.
6. Implement an explicitly authorized Lemlist enrollment worker, including unknown
   outcome reconciliation/readback. No such worker is present or enabled here.
7. Implement authenticated, idempotent reply/bounce/unsubscribe event handling and
   shared suppression updates; recheck immediately before enrollment/send.
8. With separate permission, use only an owned test address in a paused campaign
   with automatic launch disabled. Read back `projectName`, preview rendered copy,
   and test duplicate rejection. Do not call campaign launch/review endpoints.

No production or live Lemlist verification is claimed by these tests.
