# GSD SiteFinder

Private construction-lead identification tool for GSD Decorating. It reads the public Considerate Constructors Scheme marker feed, exposes the full London and selected Home Counties result set, and retrieves an individual public CCS record when a user opens a project.

## Local development

```bash
npm install
npm run dev
```

The frontend runs at `http://127.0.0.1:5173`; the local API runs at `http://127.0.0.1:8787`.

Without Supabase environment variables the application operates in local-preview mode. For the hosted team workspace, configure:

```text
VITE_SUPABASE_URL
VITE_SUPABASE_PUBLISHABLE_KEY
```

Never expose a Supabase secret/service-role key to the frontend.

All `/api/*` routes require either a valid Supabase session belonging to an
`@gsdecorating.com` user or the server-only MCP bearer token. The browser
automatically attaches the current Supabase access token. Unauthenticated
production requests return `401`.

## Team repository workflow

GitHub is the shared source of truth:
`https://github.com/gregclarkgsd/sitefinder`. Give each laptop its own local
clone and use branches and pull requests to exchange work.

Do not let multiple laptops work from one iCloud-synchronised `.git` directory.
iCloud can sync files while Git is updating its internal database, which risks
conflicts or repository corruption. Keep working clones outside iCloud (for
example `~/Coding/sitefinder`) and use iCloud only for exported reports,
screenshots or other non-repository files.

At the start of work on each laptop:

```bash
cd ~/Coding/sitefinder
git switch main
git pull --ff-only
git status
```

Create a separate branch for each coherent change. Commit and push that branch,
then merge it through GitHub only after tests pass. Never copy a `.git`
directory between laptops, and do not delete an old laptop's clone until all of
its unpushed branches and stashes have been recovered.

## Production

The included `render.yaml` builds and serves the React application and Express API as one Render web service. Apply the SQL migration in `supabase/migrations` to a dedicated Supabase project before deploying.

The production Supabase project runs `sync-ccs-projects` nightly through Supabase Cron. The sync:

- records new and archived marker records;
- refreshes every eligible CCS detail record with bounded concurrency;
- pages through the complete existing project table, rather than treating rows
  after Supabase's 1,000-row response limit as new;
- fingerprints contact, address, date, closure and description fields for change detection;
- records per-run marker totals, detail totals and detail errors;
- preserves the last successful sync time for the application freshness warning.

Set the Edge Function secret `CCS_SYNC_TOKEN` to the same value stored in the
Supabase Vault secret `ccs_sync_token`; do not commit that value.

The nightly job updates SiteFinder and its outreach review queue only. Automatic
CCS-to-Attio mirroring is disabled by default so an unreviewed project cannot
enter the CRM accidentally. Keep `CCS_ATTIO_AUTO_SYNC_ENABLED` unset or set to
anything other than the exact value `true` for the approved-lead-only workflow.
Setting it to `true` is an explicit operational decision to mirror every new or
changed CCS project and should be used only after reconciling that broader CRM
model with the approved-lead handoff.

## Data source

- Marker feed: `https://ccsfilestore.blob.core.windows.net/constructionmap/live/json/sitemarkers.json`
- Detail record: `https://portal.ccscheme.org.uk/api/searchwebapi/getsiteposterdetails/{SITE_ID}/null`

Use is intended for authorised GSD Decorating employees and remains subject to CCS terms and applicable data-protection requirements.

## MCP access for Codex and Claude Code

The production service exposes a read-only Streamable HTTP MCP endpoint at:

```text
https://gsd-sitefinder.onrender.com/mcp
```

The repository also includes a local stdio transport at `mcp/stdio.js`. Both
transports provide five direct SiteFinder tools:

- `search_projects`
- `get_project`
- `list_contractors`
- `list_locations`
- `sitefinder_status`

The MCP server reads through the authenticated SiteFinder API and never receives
a Supabase secret key. The hosted server stores only the SHA-256 hash of its
long random bearer credential. Do not use the bearer token in frontend code or
commit it to Git.

The hosted endpoint also publishes OAuth protected-resource metadata and uses
the Supabase OAuth 2.1 server. Claude.ai custom connectors can therefore connect
to the `/mcp` URL, sign in with an authorised `@gsdecorating.com` account and
approve the read-only connection on `/oauth/consent`. Claude Code can continue
to use the static server-only bearer token shown below.

Run its end-to-end smoke test:

```bash
npm run mcp:test
SITEFINDER_MCP_TOKEN=... npm run mcp:http:test
```

Register the hosted endpoint with Claude Code:

```bash
claude mcp add --transport http --scope user gsd-sitefinder \
  https://gsd-sitefinder.onrender.com/mcp \
  --header "Authorization: Bearer YOUR_SITEFINDER_MCP_TOKEN"
```

Then verify it with:

```bash
claude mcp get gsd-sitefinder
```

Alternatively, register the local stdio process with Codex:

```bash
codex mcp add gsd-sitefinder -- node "/absolute/path/to/gsd-sitefinder/mcp/stdio.js"
```

Or register the local stdio process with Claude Code:

```bash
claude mcp add --scope user \
  --env SITEFINDER_MCP_TOKEN=YOUR_SITEFINDER_MCP_TOKEN \
  gsd-sitefinder -- node "/absolute/path/to/gsd-sitefinder/mcp/stdio.js"
```

This first version is intentionally read-only. Saved leads, notes, lead stages
and tasks remain protected by Supabase authentication and cannot be modified
through MCP. Search results include the CCS site ID plus stable
`MainContractorId` and `ClientId` join keys. `get_project` returns the public CCS
detail record with address, dates and published contact fields.

Project search accepts start and completion date windows. SiteFinder's
completion filter includes a dedicated 3–9 month decorating window.

## Research Agent control room

The **Research Agent** tab is an operator-facing control room for the isolated
worker in `services/research-worker`. **New research run** lets an authenticated
operator select one or more contractors already present in SiteFinder, confirm
the official domain, choose approved sources and queue the reviewed request.
The browser never receives provider credentials and never starts a crawler
itself: a queued request waits for the approved local worker.

Without a signed-in cloud connection the page remains an explicitly labelled
preview. It demonstrates the company queue, live page activity, Pause/Resume,
orderly stop requests, evidence inspection and human candidate decisions
without writing to Attio.

The end-to-end company, CRM, research and Woodpecker relationship is mapped in
[`RESEARCH-AGENT-WORKFLOW.md`](./RESEARCH-AGENT-WORKFLOW.md).

The worker compiles a company-wide universe from Attio, Pipedrive, SiteFinder
contractor/client IDs and reviewed files. Cleanup decisions are mandatory:
quarantined or excluded identities are withheld before they can become normal
review candidates. Raw CRM inputs and outputs are rejected unless they live in
an explicitly configured local directory outside Git and iCloud.

Official company websites remain the evidence source. When explicitly enabled,
Apollo can add licensed business contact data for the confirmed company
hostname. Licensed email results are labelled separately and remain in human
review; they do not satisfy the stricter public-email approval gate. Companies
House and procurement are represented as reviewed source choices for the queue
but remain inactive until their worker adapters are implemented.

The production connection must preserve the same boundary:

- research runs, company tasks, source events and candidate decisions are saved;
- official source URLs and evidence remain visible to the reviewer;
- candidates require a human decision;
- approval records a review decision only. It does not authorise an Attio
  write, create a Woodpecker audience or send email.

Migration `20260728185448_add_research_agent_control_room.sql` provides the
saved read-only run, task, event and candidate-review records. All four tables
use row-level security for authenticated `@gsdecorating.com` users and publish
authorised changes through Supabase Realtime. When a saved run exists, the
control room loads it automatically; otherwise it remains visibly in preview
mode.

Migration `20260729203556_enforce_research_candidate_approval.sql` keeps the
approval gate consistent in the browser, server and database. Approval requires
an exact public work-email result that is either Pipedrive-only or absent from
both CRM snapshots, plus at least 65% evidence confidence. Unknown, conflicting,
Attio-existing and no-email states fail closed. If a later worker retry makes an
approved comparison unsafe, the database returns it to pending review.

Migration `20260730103000_add_licensed_research_email_status.sql` adds the
separate `licensed_business_email_found` evidence status without weakening that
public-email approval rule.

Research-candidate approval is not connected to the existing project Outreach
queue. The approved-lead handoff described below is a separate,
project-by-project workflow; it must not be treated as a Research Agent
writeback route.

Pause, Resume, Stop and candidate-review decisions go through authenticated
SiteFinder server routes. The browser has read-only table grants and cannot
call a privileged database function or update a research record directly.

The server-only `POST /api/research/ingest` endpoint accepts the narrow,
validated progress contract used by the enrichment worker. It requires both
the Supabase server credential and a Research Agent credential. The Research
Agent credential can be supplied as the raw token or as its SHA-256 hash:

```text
SUPABASE_SECRET_KEY
RESEARCH_AGENT_INGEST_TOKEN or RESEARCH_AGENT_INGEST_TOKEN_SHA256
```

The ingestion route accepts only bounded run/task progress, HTTPS source
events and candidate evidence. Unknown fields are rejected. These settings
must never be added to frontend variables or browser code.

Machine-generated progress rows deliberately have no human creator. Signed-in
Pause, Resume, Stop and candidate-review actions record the GSD user who made
the decision.

## Project intelligence and Attio links

SiteFinder's richer project listing is built only from data GSD already holds:
the CCS marker and detail records, SiteFinder workflow data, and the canonical
Attio record URL. Other construction products may be used as interface
references, but they are not treated as data sources and no third-party feed,
export, cookies or licence is required.

The CCS project synchronisation derives source-honest programme and sales
timing from the published start and finish dates. It classifies sector, work
type, fit-out and new-build housing only when the CCS project name or summary
contains explicit evidence; otherwise the value remains unknown.

The Attio Project record receives the native project address, postcode, map,
dates, contractor, client, site contact, CCS metrics, data-completeness score
and the exact SiteFinder project URL. SiteFinder stores Attio's canonical
record URL so users can move between the same project in either system.

## Approved lead handoff to Attio

Only a lead explicitly approved in SiteFinder is asserted into Attio's custom
Projects object, matched by the unique `CCS Site ID` attribute. SiteFinder does
not create an Attio Deal. A Deal is created later, through the normal sales
process, only when the customer sends an enquiry or invitation to price.

Before creating CRM records, `sync-approved-leads-to-attio` searches Attio for:

- an existing company by exact trustworthy email domain, falling back to an
  exact company-name check for generic email domains;
- an existing person by exact email address; and
- an existing Project by `CCS Site ID`.

Existing records are reused and linked. A company or person is created only
when no safe existing match is found; ambiguous matches are held for review.
Unreviewed CCS projects remain in SiteFinder and are never bulk-loaded into the
CRM. The function requires a signed-in GSD user and stores its API token only in
Supabase Edge Function secrets:

```text
ATTIO_ACCESS_TOKEN
ATTIO_DEFAULT_OWNER_ID
ATTIO_PROJECT_COMPANY_ATTRIBUTE    # optional relationship slug override
ATTIO_PROJECT_PEOPLE_ATTRIBUTE     # optional relationship slug override
```

The outreach screen presents SiteFinder's Gmail communication history alongside
the draft. Approving a draft first completes the Attio Project handoff, then
sends only when the GSD Gmail connection is active. A failed send leaves the
approved draft available to retry only when Gmail definitively rejected the
request. SiteFinder atomically moves initial and follow-up sends into `sending`
before calling Gmail. If Gmail accepted the email but SiteFinder could not
persist the result, or a network failure makes the Gmail outcome unknowable,
the lead moves to `reconciliation_required`; the function returns
`reconciliation_required: true` and keeps it non-retryable to prevent a
duplicate. Woodpecker remains separate and is used for planned bulk campaigns,
not this project-by-project workflow.

## GSD Gmail outreach activation

The Gmail functions are deployed but remain unable to send until an authorised
GSD mailbox is deliberately connected. Configure these server-only Supabase
Edge Function secrets:

```text
GMAIL_CLIENT_ID
GMAIL_CLIENT_SECRET
GMAIL_PUBSUB_TOPIC
GMAIL_WEBHOOK_SECRET
OUTREACH_CRON_SECRET
MAILBOX_ENCRYPTION_KEY
SITEFINDER_URL
```

Then:

1. Add the Supabase function callback URL
   `https://oihmehqrwdvajzyxvuhz.supabase.co/functions/v1/gmail-mailboxes`
   to the Google OAuth application's authorised redirect URIs.
2. Create a Google Cloud Pub/Sub push subscription for the Gmail topic. Point
   it to
   `https://oihmehqrwdvajzyxvuhz.supabase.co/functions/v1/gmail-outreach-webhook?token=GMAIL_WEBHOOK_SECRET`,
   replacing the placeholder with the configured secret.
3. Open Outreach and select **Add** under Connected GSD mailboxes. Repeat this
   OAuth flow for each authorised `@gsdecorating.com` mailbox. Each refresh
   token is encrypted independently at rest using `MAILBOX_ENCRYPTION_KEY`.
4. Schedule one daily `connect-gmail-watch` request with
   `x-sitefinder-cron-secret: OUTREACH_CRON_SECRET` and a valid Supabase gateway
   authorisation header. Cron mode renews every active mailbox; a signed-in GSD
   user can still renew one selected mailbox manually. Renewal updates the
   watch expiration and health only—it never moves the reply-processing history
   cursor.
5. Schedule `process-outreach-followups` hourly with the
   `x-sitefinder-cron-secret: OUTREACH_CRON_SECRET` header.
6. Send one internal test project to a GSD-owned address before enabling live
   recipients.

Initial messages and chasers are stored against the SiteFinder lead with Gmail
message/thread IDs. Replies, bounces and opt-outs are written to the
communication history and immediately cancel future chasers. Opt-outs also
enter the suppression list. The default sequence waits five days between
messages and stops after two follow-ups. A project's first selected sender is
retained for its complete thread and cannot be changed after the initial email.

The Gmail webhook drains every returned history page before advancing a
mailbox cursor. Each inbound Gmail message is protected by its provider message
ID, so a database failure leaves the cursor unchanged and Pub/Sub replay can
complete the work without adding duplicate communication rows. Missing or
expired Gmail history cursors are treated as reconciliation errors rather than
being silently reset. Scheduled watch and follow-up responses return
`ok: false` with per-mailbox or per-lead results when work is partial; operators
should investigate those non-success responses instead of assuming the batch
completed.
