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

Only a lead explicitly approved in SiteFinder is asserted into Attio's standard
Deals object, matched by the unique `CCS Site ID` attribute. Unreviewed CCS
projects remain in SiteFinder and are never bulk-loaded into the CRM. The Edge
Function `sync-approved-leads-to-attio` requires a signed-in GSD user and stores
its API token only in Supabase Edge Function secrets:

```text
ATTIO_ACCESS_TOKEN
ATTIO_DEFAULT_OWNER_ID
```

Approval does not send email. It creates or updates the Attio deal and records
the Attio record ID, sync time and any error against the outreach lead. Email
sending remains locked until Sam's mailbox is deliberately connected.
