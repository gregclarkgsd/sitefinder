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
