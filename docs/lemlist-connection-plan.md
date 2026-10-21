# SiteFinder connection and deployment plan

Local implementation update: see [offline implementation checkpoint](lemlist-offline-implementation.md).
It supersedes the missing-offline-code items below with disabled injected ports,
transaction/dispatch code, verified event intake and a durable stop queue. The
production requirements below remain outstanding; this new batch is unpublished.

Prepared from PR #10, head `73d79d597d36c46651dc52955ab7d5206b8f259f`.
The PR remains draft and unmerged. CI run 39513961954 passed all jobs, including
full-schema concurrent-reservation tests; both dependency audits were clear at
that run. This is an offline preparation document, not deployment authorization.
Earlier checkpoints in lemlist-review.md contain superseded test/audit counts.

The owner reports that both email variants and their signature are finished,
open/click tracking is off and reply tracking remains on. Do not ask them to redo
that work. Those are reported settings, not a fresh API readback. The target is
kept in ignored private configuration; no real campaign/team/sender identifiers
belong in this document, example files, GitHub commits or CI output.

## What exists and what is still missing

| Area | Tested implementation | Remaining production connection |
| --- | --- | --- |
| New projects | Immutable INSERT capture design, historical exclusion snapshot and original sync ID | Approved SQL installation; sync-link flag; durable dispatcher scans captured events only after the matching sync completes, with replay/cursor recovery |
| SiteFinder reads | Injected paginated Supabase read port | Approved server-side access to private capture tables; consistent snapshot/export across pages; deployed-schema verification |
| Other sources | Normalized provider snapshot contract | Actual Lemlist, Woodpecker and Attio readers, authenticated privately, with complete pagination, retries, rate limits and explicit coverage evidence |
| Owner/contact approval | Fresh recipient/company/owner-bound review input | Operator review surface/export and a controlled writer of fresh checks; canonical company alias resolution; resolve Sam/Greg ownership for each project |
| Atomic reservations | Shared RPC and unique project/email/company claims | Production transaction adapter on a dedicated connection; least-privilege grants reviewed explicitly; all writers use this boundary |
| Enrollment | Disabled synthetic worker and persistent uncertain attempts | Production mode and transport implementation, exact API contract tests, campaign lock/allowlist, scoped authorization and private configuration |
| Readback | Exact match for campaign/email/project/firstName before confirmation | Provider-specific lookup including duplicates, partial pages, eventual consistency and ambiguous outcomes; no automatic re-enrollment after uncertainty |
| Events | Local authenticated-normalized event handler and replay checks | Actual documented authentication verifier, durable ingress/retry/quarantine, provider identity validation, reconciliation and provider-side stop/suppression operations |
| Operations | Test harness and design documentation | Dedicated runtime/queue ownership, health alerts, stop control, secret storage, retention/access rules and recovery runbook |

Evidence: `lemlist-adapters.js`, `lemlist-worker.js`, `lemlist-review.js`,
`docs/lemlist-insert-capture.sql`, `docs/outreach-provider-guard.sql`,
`docs/lemlist-worker.sql`, `scripts/test-lemlist-full-schema.mjs`.

The current worker rejects production mode and non-mock evidence. Setting an
environment flag alone cannot make it a live integration. Its `launch: false`
argument is an internal mock transport contract, not verified Lemlist API behavior.
No live adapter may assume that this property prevents sending. Verify actual
documented API behavior and paused/manual campaign state before an owned-contact
test. This plan does not prescribe unverified authentication headers or endpoints.

Current event handling stops local follow-ups and persists suppressions. It does
not cancel an already scheduled Lemlist message. A production implementation needs
authenticated provider stop handling, durable retries, readback and escalation
for failures. Local database locks cannot make a remote API call atomic. Unknown
recipient/campaign events currently reject; production ingress must retain them
for reconciliation, rather than lose or silently acknowledge them.

## Data and history requirements

Campaign go-live is a new, explicit future timestamp. It is separate from the
first SiteFinder database sync baseline. Initialization snapshots all existing
project IDs under a table lock; they remain excluded even after deletion/reimport.
Require INSERT evidence, discovered_after_baseline=true, first_seen_at strictly
after go-live, a matching completed original sync, an active/open project and a
fresh manual owner approval. Updates, renamed projects, recent queue timestamps,
and old records backfilled with a run ID must never qualify as new projects.

Read all SiteFinder lead statuses, queued/approved/sending/uncertain work,
communications, Gmail claims and follow-up schedules, shared suppressions and
replies/bounces/opt-outs. Combine those with complete relevant historical and
active outreach in Lemlist/Woodpecker and Attio relationships. An unused source
needs an explicitly verified empty snapshot; unavailable is not empty. Do not
import contacts or write historical claims during this preparation stage.

Use one canonical company identity (the existing worker uses `attio:<record-id>`),
with verified domain/alias resolution. Normalize recipient emails. Never dedupe
only on company display name or only within the new campaign. Treat missing,
incomplete or stale evidence as a hold. Current freshness limit is 15 minutes;
recheck immediately before any separately approved submission. Resume existing
uncertain attempts through reconciliation, not through a new-candidate scan that
would encounter their own permanent claims. Capture snapshot stability under
concurrent updates/deletes needs dedicated production-adapter tests.

| Lead variable | Source and rule |
| --- | --- |
| `email` | Owner-reviewed contact email matching the SiteFinder outreach lead; validated and suitable for decorating tenders |
| `firstName` | Reviewed recipient's first name, required by the worker; never borrow a site manager name for a different recipient |
| `projectName` | Trimmed `project_name` in the immutable captured INSERT snapshot; missing names/ID placeholders hold; later renames need review |
| `sitefinderProjectId` | Immutable `project_id`, retained for reconciliation |
| `projectFirstSeenAt` | Original `first_seen_at`, not campaign import time |
| `contactOwner` | Accountable Sam/Greg owner email, separate from the approved shared sender |
| `lastName`, `companyName`, `jobTitle`, `phone` | Only verified fields of the selected recipient; optional |
| `projectAddress` | Captured project address if available |

Read back the saved variables and render both approved variants. API warnings,
retained pre-existing variables, duplicate matches and mismatches require a hold.

## Access inventory and precise approval boundaries

No credentials were created, read from secret stores, or configured for this plan.
No live account permissions or deployed values have been verified. Never send keys
or passwords in chat, examples, PR bodies or logs.

First connection stage requires approved server-side read access to SiteFinder
projects/syncs/leads/history/suppressions/ownership, Attio companies/contacts and
relationships, and Lemlist/Woodpecker campaign/contact/activity/suppression data.
Where an API offers no read-only credential scope, use a reviewed read-only client
and assess the credential's broader authority explicitly; do not describe it as
a read-only credential. Private database tables should stay private; do not expose
the entire schema via public APIs merely to satisfy the current read-port shape.
Choose a restricted server-side export/RPC or database connection after access
review. Review explicit table/function grants; current design scripts do not by
themselves provide every production worker permission.

Precise next approval: authorize configuring the minimum server-side access for
the read-only connection stage through a secure setup flow, and read-only checks
of the named sources and target campaign. This does not authorize merge, deployment,
SQL execution, contact import/enrollment, campaign edits or sending. If access
already exists, inventory/reuse it only within that approved scope. Present any
new credential's provider, intended scope, storage and runtime before creation.

Information to settle before that setup: runtime owner/location; actual systems
in use (especially Woodpecker); complete history coverage; Sam/Greg routing rules.
Future go-live time and the owned test address can be settled after read-only
verification. Leave unknown values unset rather than choose operational defaults.

## Staged execution checklist (future approvals required)

1. Complete remaining adapters and production-mode guards offline with mocks:
   pagination failure/429/retry, stale evidence, concurrent updates/deletes,
   timeout accepted-before-response, exact variable readback, duplicate aliases,
   event replay/spoof/unknown identity and provider stop failure. Preserve existing
   green CI. No live read or write is needed for this development stage.
2. After read-only setup approval, verify source coverage, deployed schema,
   campaign manual/draft/auto-launch settings, approved sender, variables and
   completed signature. Produce a private diagnostic report without importing
   contacts. Never use production contact data in public CI fixtures.
3. Present the exact immutable commit, SQL, runtime/permission changes, stop and
   recovery procedure for separate deployment approval. `render.yaml` declares
   `autoDeployTrigger: commit`; do not assume merge is deploy-free or that the PR
   skip marker protects a later merge commit. Verify actual Render settings before
   merge. Supabase SQL/functions require their own reviewed deployment steps.
4. If approved, install capture SQL, provider-guard SQL, then worker-state SQL;
   verify schema/grants and backups. Deploy code disabled. Do not enable
   `OUTREACH_PROVIDER_GUARD_ENABLED` until complete history/checks are ready: missing
   checks intentionally block existing Gmail. A concurrent Gmail/Lemlist rollout
   requires all relevant sending paths to respect the same reservations.
5. Agree a future go-live timestamp. In an approved capture-only rollout, enable
   sync linkage only after the column exists, initialize capture/exclusions once,
   and verify the first completed post-boundary sync. Worker enrollment stays off.
   SQL initialization is immutable; do not reset it to replay history.
6. Produce a private review list (proposed first batch: at most three genuinely
   new projects), showing project, company, selected contact, owner, history checks
   and hold reasons. Daniel approves individual recipients before any real batch.
7. With separate owned-test-contact enrollment approval, add only that contact to
   the verified paused/manual campaign; no launch/review/send endpoint calls.
   Confirm both variants' variables, duplicate rejection and event/stop behavior
   using synthetic events where possible. A real email test needs separate consent.
8. Present a final launch decision covering real batch IDs, maximum volume, owner,
   schedule, stop policy and verified exclusions. Only explicit sending approval
   permits live outreach. Keep permanent claims on failure/unknown outcomes.

Stop/recovery: stop the worker/dispatcher and hold the provider campaign through
approved controls; retain event history, exclusions, attempts and claims. Never
drop audit tables or clear reservations to retry. Reconcile uncertain provider
outcomes before resuming. Do not disable the shared guard to bypass a hold.

## Current preparation result

This document and the adjacent example JSON are local planning artifacts only.
No runnable deployment command, live endpoint binding, secret or campaign ID is
included. The example is intentionally non-executable and keeps every action gate
off. No new test run is claimed: this document references the verified existing
green CI commit. Production connectivity and deployment parity remain unverified.
