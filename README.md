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
