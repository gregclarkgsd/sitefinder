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

## Licensed LiveSites enrichment

SiteFinder can accept an authorised LiveSites export through the
`import-livesites-projects` Edge Function. The integration does not store or
reuse browser cookies and does not attempt to bypass the LiveSites account.
Use an official API/export when LiveSites provides one, or supply the equivalent
licensed JSON payload.

The import is source-preserving:

- LiveSites records and contacts are stored separately from CCS records;
- projects are auto-matched only when postcode, project name, contractor and
  programme evidence produce a strong, unambiguous match;
- uncertain matches are held for review rather than merged;
- match-review candidates are shown in SiteFinder and require an explicit
  confirm or reject action;
- conflicting source fields remain visible;
- sector, work type, fit-out and new-build housing stay `unknown` unless the
  supplied source provides explicit evidence;
- LiveSites contacts enrich the Project record but do not mutate the separate
  Attio People migration.

Validate a pilot payload without changing data:

```json
{
  "action": "validate",
  "mode": "pilot",
  "projects": [
    {
      "livesites_site_id": "12345",
      "project_name": "Example Project",
      "address": "1 Example Street, London, SW1A 1AA",
      "contract_value": "£5m",
      "project_type": "Office Refurbishment",
      "trades_required": ["Painting & Decorating"],
      "contacts": [
        {
          "full_name": "Example Contact",
          "job_title": "Site Manager",
          "email": "contact@example.com",
          "email_verified": true
        }
      ]
    }
  ]
}
```

Pilot imports are capped at 50 projects. After reviewing the validation result,
repeat with `"action": "import"` and
`"confirm": "IMPORT-LIVESITES-PILOT"`. Bulk batches are capped at 250 and use
`"mode": "bulk"` with `"confirm": "IMPORT-LIVESITES-BULK"`.

Once a project is confirmed, the normal SiteFinder-to-Attio sync populates the
commercial value, project type, units, trades, Painting & Decorating flag,
LiveSites link, source-backed classifications and verified Project contact
fields in Attio. CCS and LiveSites descriptions remain separate. If a match is
rejected or later becomes uncertain, its LiveSites enrichment is removed from
the canonical project and cleared on the next Attio project sync. Attio and
SiteFinder retain direct links to the same confirmed project.
