# GSD Sales Enrichment

A read-only enrichment service for GSD London's Attio and Pipedrive data.

It recovers existing CRM facts, crawls official company websites and PDFs,
extracts target construction roles, optionally adds Companies House and UK
procurement signals, and produces a private evidence pack for human review.

Phase 1 cannot write to either CRM.

## What it finds

The role taxonomy prioritises:

- quantity surveyors, including assistant, project and senior QS;
- commercial managers, directors and heads of commercial;
- procurement managers, purchasing leads and buyers;
- supply-chain managers and directors;
- project managers and project directors;
- contracts managers and contract surveyors;
- site surveyors;
- estimators, preconstruction managers and site managers as adjacent roles.

The website crawler checks high-value pages first: team, leadership, commercial,
procurement, contact, projects, news and careers. It also reads a small,
configurable number of public PDFs.

## Safety model

- No Attio or Pipedrive create/update/delete methods exist.
- `--write`, `--write-attio`, `--sync` and `--apply` are rejected.
- LinkedIn pages are never crawled. A LinkedIn URL linked from an official
  company page may be recorded as evidence only.
- `robots.txt` is respected.
- Private, loopback and link-local network targets are blocked.
- Crawl size, concurrency, response size, redirects and PDFs are capped.
- Inferred emails are never described as verified. Phase 1 does not generate
  inferred emails.
- Output files use private filesystem permissions and live in Git-ignored
  directories.
- Each output fact retains a source URL, capture date and confidence.

## Setup

Requires Node.js 22.3 or newer.

```bash
npm install
cp .env.example .env
npm run check
```

Add only the credentials needed for the command you intend to run. Rotate the
Attio key that was previously pasted into chat before using this service.

## 1. Capture read-only CRM snapshots

```bash
npm run snapshot:attio -- --output .private/snapshots/attio
npm run snapshot:pipedrive -- --output .private/snapshots/pipedrive
```

Pipedrive organisations do not expose a standard domain field in every account.
If GSD's website/domain is a custom field, pass its field key:

```bash
npm run snapshot:pipedrive -- \
  --domain-field-key YOUR_FIELD_KEY \
  --output .private/snapshots/pipedrive
```

Credentials are read from `ATTIO_API_TOKEN` and `PIPEDRIVE_API_TOKEN`.

## 2. Reconcile Pipedrive with Attio

```bash
npm run reconcile -- \
  --attio-people .private/snapshots/attio/people.json \
  --attio-companies .private/snapshots/attio/companies.json \
  --pipedrive-people .private/snapshots/pipedrive/people.json
```

The report separates recoverable titles, Pipedrive-only people, company
conflicts, duplicate emails, departed/stale contacts and unusable records. It
does not update Attio.

## 3. Run a website-enrichment pilot

The default cap is 50 companies:

```bash
npm run enrich -- \
  --input .private/snapshots/attio/companies.json \
  --limit 50 \
  --max-pages 12 \
  --max-pdfs 3 \
  --concurrency 2
```

To include Companies House, set `COMPANIES_HOUSE_API_KEY` and add:

```bash
--with-companies-house
```

To inspect recent public procurement notices, add a bounded window:

```bash
--procurement-days 30
```

### Watch a run in SiteFinder

The crawler can send safe progress events to the Research Agent control room
while keeping the full private output in this workspace:

```bash
npm run enrich -- \
  --input .private/snapshots/attio/companies.json \
  --limit 50 \
  --publish-progress \
  --run-name "Daily company research"
```

Set `RESEARCH_AGENT_INGEST_URL` and `RESEARCH_AGENT_INGEST_TOKEN` first. The
progress feed contains company names, public source URLs, job titles and
email-availability status. It never sends the bearer token in the payload,
evidence sentences, or personal email or telephone values.

This updates only the SiteFinder run viewer. It does not create or update
Attio or Pipedrive records, and discovered candidates still require a person
to approve or reject them.

Visible control-room runs process one company at a time so Pause and
Stop-after-current have exact, predictable meaning.

Runs over 250 companies require the explicit safety flag
`--confirm-large-run=YES`.

## Outputs

Each run creates:

- `summary.json` — non-sensitive counts and run metadata;
- `companies.jsonl` — company-level enrichment;
- `contacts.jsonl` — target-role candidates;
- `evidence.jsonl` — source URLs, excerpts, dates and confidence;
- `projects.jsonl` — matched public-procurement activity;
- `review.json` — uncertain, former or email-missing contacts.

`output/` and `.private/` are excluded from Git.

## Boundary with other active work

This service is intentionally independent of:

- `/Users/gregclark/sitefinder`, where the Attio/SiteFinder link is being built;
- `/Users/gregclark/gsd_attio_migration`, where the Pipedrive-to-Attio
  reconciliation is running.

It does not import those scripts, modify their files, deploy their functions or
share their run-state directories.
