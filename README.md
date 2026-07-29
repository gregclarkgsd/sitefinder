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

The **Research Agent** tab is an operator-facing control room for the separate
GSD Sales enrichment service. Its first release is an explicitly labelled
preview: it demonstrates the company queue, live page activity, Pause/Resume,
orderly stop requests, evidence inspection and human candidate decisions
without starting a crawler or writing to Attio.

The production connection must preserve the same boundary:

- research runs, company tasks, source events and candidate decisions are saved;
- official source URLs and evidence remain visible to the reviewer;
- candidates require a human decision;
- approval may queue a candidate for a separately governed Attio write, but
  never sends email and never writes to Attio from the preview interface.

Migration `20260728185448_add_research_agent_control_room.sql` provides the
saved read-only run, task, event and candidate-review records. All four tables
use row-level security for authenticated `@gsdecorating.com` users and publish
authorised changes through Supabase Realtime. When a saved run exists, the
control room loads it automatically; otherwise it remains visibly in preview
mode.

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

The outreach screen presents the Project history from Attio alongside the
draft. Approving a draft first completes the Attio Project handoff, then sends
only when the GSD Gmail connection is active. A failed send leaves the approved
draft available to retry. Woodpecker remains separate and is used for planned
bulk campaigns, not this project-by-project workflow.

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
4. Invoke `connect-gmail-watch` daily for every active mailbox so its watch
   cannot expire.
5. Schedule `process-outreach-followups` hourly with
   `Authorization: Bearer OUTREACH_CRON_SECRET`.
6. Send one internal test project to a GSD-owned address before enabling live
   recipients.

Initial messages and chasers are stored against the SiteFinder lead with Gmail
message/thread IDs. Replies, bounces and opt-outs are written to the
communication history and immediately cancel future chasers. Opt-outs also
enter the suppression list. The default sequence waits five days between
messages and stops after two follow-ups. A project's first selected sender is
retained for its complete thread and cannot be changed after the initial email.
