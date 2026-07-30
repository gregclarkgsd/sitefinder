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
- Raw snapshots and outputs can only be written below the explicitly configured
  `RESEARCH_PRIVATE_DATA_DIRECTORY`.
- Pipedrive credentials are sent only to credential-free HTTPS origins on
  `pipedrive.com`, and authenticated requests refuse redirects.
- The private-data root must be an absolute local path outside every Git
  repository, the workspace, iCloud, macOS `Library/CloudStorage`, common
  cloud-drive folders and `/Volumes` network/removable mounts. Relative paths,
  path traversal and symlink escapes are rejected before a run starts.
- Run directories use mode `0700`; output files use mode `0600` and are created
  without following symlinks or overwriting existing files. The root and run
  directory identities are rechecked before every file creation, and each
  opened file is identity-checked before sensitive bytes are written.
- These checks prevent accidental disclosure and ordinary path/symlink swaps.
  They cannot make storage formally race-free against a malicious process
  running as the same OS account: such a process can already read, move or
  relink that account's files. Run the worker under a dedicated OS account or
  inside a separately permissioned service if that threat is in scope.
- Each output fact retains a source URL, capture date and confidence.

## Setup

Requires Node.js 22.3 or newer.

```bash
npm install
cp .env.example .env
npm run check
```

Create a dedicated local directory that is not synced by iCloud, Dropbox or
another cloud-drive client. For example, after replacing `your-name`:

```bash
mkdir -p "/Users/your-name/Library/Application Support/GSD/Leadfinder Research"
chmod 700 "/Users/your-name/Library/Application Support/GSD/Leadfinder Research"
```

Set the same absolute path in `.env`:

```dotenv
RESEARCH_PRIVATE_DATA_DIRECTORY="/Users/your-name/Library/Application Support/GSD/Leadfinder Research"
```

Do not point this setting at the Leadfinder workspace, another Git repository,
an iCloud/cloud-drive directory, `Library/CloudStorage`, `/Volumes`, or a shared
network folder. The CLI refuses those locations.

Add only the credentials needed for the command you intend to run. Rotate the
Attio key that was previously pasted into chat before using this service.

## 1. Capture read-only CRM snapshots

```bash
npm run snapshot:attio -- --output snapshots/attio
npm run snapshot:pipedrive -- --output snapshots/pipedrive
```

`--output` is always a relative subdirectory below
`RESEARCH_PRIVATE_DATA_DIRECTORY`; an absolute `--output` is rejected. If the
flag is omitted, the CLI creates a timestamped directory below `snapshots/`.

Pipedrive organisations do not expose a standard domain field in every account.
If GSD's website/domain is a custom field, pass its field key:

```bash
npm run snapshot:pipedrive -- \
  --domain-field-key YOUR_FIELD_KEY \
  --output snapshots/pipedrive
```

Credentials are read from `ATTIO_API_TOKEN` and `PIPEDRIVE_API_TOKEN`.
Company snapshots retain named organisations even when no domain is present;
those rows enter the company-universe review queue instead of disappearing.
Pipedrive note text is not persisted: the people snapshot records only a
boolean departed/stale match when the bounded reconciliation vocabulary is
found.

## 2. Reconcile Pipedrive with Attio

```bash
research_private_data="/Users/your-name/Library/Application Support/GSD/Leadfinder Research"
npm run reconcile -- \
  --attio-people "$research_private_data/snapshots/attio/people.json" \
  --attio-companies "$research_private_data/snapshots/attio/companies.json" \
  --pipedrive-people "$research_private_data/snapshots/pipedrive/people.json"
```

The report separates recoverable titles, Pipedrive-only people, company
conflicts, duplicate emails, departed/stale contacts and unusable records. It
does not update Attio.

Each successful snapshot ends with `completion-manifest.json`, which hashes
every snapshot artifact and records its counts. The Attio marker is explicitly
labelled `operational_read_only_snapshot` and
`not_a_complete_deletion_safe_attio_backup`: this API extract is useful for
research and reconciliation, but it is **not** a substitute for the complete
backup required before permanent Attio deletion. A failed or interrupted
snapshot has no completion marker.

## 3. Compile the company universe

Research runs cover the whole portfolio, not only companies linked to a
SiteFinder project. The universe compiler accepts any combination of cleaned
Attio companies, read-only Pipedrive organisations, SiteFinder projects and
reviewed company files.

It auto-merges only exact normalized domains, company numbers or duplicate
source IDs. Name-only matches, missing domains and contradictory identities are
sent to review instead of being guessed.

SiteFinder contractor/client IDs can be linked to cleaned Attio or Pipedrive
company IDs with an optional, strictly reviewed identity-resolution manifest.
Every mapping names one exact SiteFinder source ID and one exact CRM source ID,
has a unique approval key and a reason, and is signed off with a reviewer and
timestamp. Both referenced records must exist in the captured inputs. The
worker never turns a similar company name into a mapping. Contradictory domains
or company numbers remain blocking review items even when a mapping was
approved. See `examples/identity-resolutions.example.json`.

An append-only cleanup decision ledger and its signed-off approval manifest are
both mandatory. Copy the cleanup task's `decisions.jsonl` and
`approval-manifest.json` into the private-data directory together. The manifest
binds the exact ledger SHA-256 and decision count; empty, changed or unapproved
ledgers are rejected before any company selection or crawling. Redacted,
mutually consistent examples are available at
`examples/cleanup-decisions.example.jsonl` and
`examples/cleanup-approval-manifest.example.json`.

```bash
npm run universe -- \
  --attio-companies snapshots/attio/companies.json \
  --pipedrive-companies snapshots/pipedrive/companies.json \
  --sitefinder-projects snapshots/sitefinder/projects.json \
  --identity-resolutions reviews/sitefinder-crm-identities.json \
  --cleanup-decisions cleanup/decisions.jsonl \
  --cleanup-manifest cleanup/approval-manifest.json \
  --output universe/current
```

The compiler creates researchable `companies.json`, the full source-linked
`universe.jsonl`, identity review output, held companies and a SHA-256 input
manifest. SiteFinder-only companies without a confirmed domain remain in review
and are never crawled by guessed name. `summary.json` records approved mapping,
mapped SiteFinder identity, unmapped SiteFinder identity and resolution-conflict
counts. The identity-resolution file's SHA-256, reviewer and approval timestamp
are also preserved in the input and completion manifests.

## 4. Create a reviewed pilot manifest

Multi-company runs do not take an alphabetical `--limit`. Choose the pilot
companies deliberately and save a strict manifest based on
`examples/reviewed-pilot-manifest.example.json`. It binds:

- the exact `universe/current/companies.json` SHA-256;
- the exact post-cleanup Attio people snapshot SHA-256;
- the exact current Pipedrive people snapshot SHA-256;
- the reviewed company IDs and their order;
- the reviewer, timestamp and purpose.

The CLI rejects stale hashes, duplicate/missing companies and lists over 250
companies. A one-company diagnostic can use `--company-id` instead.
The hashes and company ID in the example file are placeholders and must be
replaced with the captured values being reviewed.

## 5. Run the read-only website-enrichment pilot

```bash
npm run enrich -- \
  --input universe/current/companies.json \
  --cleanup-decisions cleanup/decisions.jsonl \
  --cleanup-manifest cleanup/approval-manifest.json \
  --attio-people snapshots/attio-post-cleanup/people.json \
  --attio-snapshot-manifest snapshots/attio-post-cleanup/completion-manifest.json \
  --pipedrive-people snapshots/pipedrive/people.json \
  --pipedrive-snapshot-manifest snapshots/pipedrive/completion-manifest.json \
  --pilot-manifest pilots/reviewed-50.json \
  --max-pages 12 \
  --max-pdfs 3 \
  --concurrency 2
```

To include Companies House, set `COMPANIES_HOUSE_API_KEY` and add:

```bash
--with-companies-house
```

To add a bounded Apollo people search, supply `APOLLO_API_KEY` through the
local process environment or a local secret manager (not this iCloud-backed
workspace) and add:

```bash
--with-apollo --apollo-max-people 10
```

Apollo is opt-in because person enrichment can consume Apollo credits. The
worker searches the exact company domain for target construction roles, asks
only for verified business emails, and explicitly disables personal-email,
phone, and waterfall enrichment. Results are labelled
`licensed_business_email_found`; they can be reviewed and compared with the
CRM snapshots but cannot be approved until the email is independently verified
on a public source.

If Apollo indexes a business under a different current official hostname, add
an `apolloSearchDomain` to that reviewed company input row. The exact hostname
is used for search, while an enrichment result is accepted only when Apollo's
organisation domain has the same registrable parent. For example, BAM's
reviewed input can retain `domain: "bam.co.uk"` and specify
`apolloSearchDomain: "ukandireland.bam.com"`; Apollo may then return the
verified parent organisation and email domain `bam.com`. Because the reviewed
pilot manifest is bound to the exact company-input hash, this alias is an
explicit reviewed input rather than an automatic fuzzy match.

To inspect recent public procurement notices, add a bounded window:

```bash
--procurement-days 30
```

### Watch a run in SiteFinder

The crawler can send safe progress events to the Research Agent control room
while keeping the full private output outside the shared workspace:

```bash
npm run enrich -- \
  --input universe/current/companies.json \
  --cleanup-decisions cleanup/decisions.jsonl \
  --cleanup-manifest cleanup/approval-manifest.json \
  --attio-people snapshots/attio-post-cleanup/people.json \
  --attio-snapshot-manifest snapshots/attio-post-cleanup/completion-manifest.json \
  --pipedrive-people snapshots/pipedrive/people.json \
  --pipedrive-snapshot-manifest snapshots/pipedrive/completion-manifest.json \
  --pilot-manifest pilots/reviewed-50.json \
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

### Run one reviewed SiteFinder queue request

Set `RESEARCH_AGENT_INGEST_URL`, `RESEARCH_AGENT_INGEST_TOKEN`, and
`RESEARCH_QUEUE_INPUT_MANIFEST` in the local worker environment. The queue
manifest itself must be private and may use relative paths beneath
`RESEARCH_PRIVATE_DATA_DIRECTORY`:

```json
{
  "schemaVersion": 1,
  "cleanupDecisions": "cleanup/decisions.jsonl",
  "cleanupManifest": "cleanup/approval-manifest.json",
  "attioPeople": "snapshots/attio-post-cleanup/people.json",
  "attioSnapshotManifest": "snapshots/attio-post-cleanup/completion-manifest.json",
  "pipedrivePeople": "snapshots/pipedrive/people.json",
  "pipedriveSnapshotManifest": "snapshots/pipedrive/completion-manifest.json"
}
```

Then run:

```bash
npm run queue:run
```

The command fully verifies those cleanup and CRM inputs before asking
SiteFinder for work. It atomically claims at most one oldest queued request,
uses the company IDs and sources reviewed in SiteFinder, saves the private
evidence pack under `queue-runs/<run-id>`, and exits. Apollo is contacted only
when that reviewed request includes Apollo, so an empty queue and failed
preflight consume no Apollo credits.

Every retained discovery is compared by exact normalized business email with
the two verified CRM snapshots. Results are one of: already in Attio,
Pipedrive-only, missing from both, conflicting matches, or unverifiable.
SiteFinder receives only that status. Email addresses and exact CRM record IDs
remain in the private local comparison output. The Attio snapshot must have
been captured after cleanup approval, so a pre-cleanup snapshot cannot be
mistaken for the current CRM.

Visible control-room runs process one company at a time so Pause and
Stop-after-current have exact, predictable meaning.

Cleanup policy is enforced before a company is queued and again after contact
extraction. Quarantined, opted-out, former, merged or excluded identities are
withheld before they can become ordinary review candidates. Invalid email
addresses are removed without suppressing another valid address for the same
person. Discoveries without a durable exact person identifier are held rather
than guessed. ID-only person/employment decisions are resolved through the
verified Attio email index. The control room receives only a non-identifying
comparison event for held results.

## Outputs

Each run creates:

- `summary.json` — non-sensitive counts and run metadata;
- `companies.jsonl` — company-level enrichment;
- `contacts.jsonl` — target-role candidates;
- `evidence.jsonl` — source URLs, excerpts, dates and confidence;
- `projects.jsonl` — matched public-procurement activity;
- `held-companies.jsonl` — companies stopped by cleanup policy;
- `held-matches.jsonl` — private details of discoveries withheld by policy;
- `crm-comparisons.jsonl` — private exact-email and CRM-record comparisons;
- `review.json` — uncertain, former, email-missing or CRM-conflicting contacts,
  including the exact local comparison reason;
- `input-manifest.json` — SHA-256 hashes and counts for reproducibility;
- `completion-manifest.json` — final marker with hashes and counts for every
  completed artifact; its absence means the output must be treated as partial.

All files are written under `RESEARCH_PRIVATE_DATA_DIRECTORY`. The summary
reports only the run-relative output path, not the private root's absolute
location. Existing or non-empty run directories are never reused.

All CLI inputs containing CRM, SiteFinder or cleanup data must also resolve
inside `RESEARCH_PRIVATE_DATA_DIRECTORY`. Symlink escapes are rejected.

## Boundary with other active work

This service does not write CRM data, modify cleanup scripts, deploy functions
or share private run-state through the Leadfinder Git/iCloud workspace.
