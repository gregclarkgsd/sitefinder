# GSD Sales Enrichment — Phase 1

## Scope

Build a standalone, read-only service that:

1. snapshots Attio and Pipedrive without changing either system;
2. compiles a source-linked company universe from Attio, Pipedrive,
   SiteFinder contractors/clients and reviewed files;
3. enforces the approved Attio cleanup ledger before and after research;
4. reconciles people by normalised business email and company domain;
5. crawls official company websites and public PDFs;
6. extracts target construction roles with source evidence;
7. adds optional Companies House and public-procurement signals;
8. writes private review files, never CRM updates.

## Hard boundaries

- Do not deploy functions, migrations, websites or scheduled jobs.
- Do not implement Attio or Pipedrive write methods in Phase 1.
- Do not scrape logged-in LinkedIn pages or bypass access controls.
- Do not treat inferred email addresses as verified.
- Keep personal data and credentials outside Git and iCloud.
- Require every private input/output to remain under the configured local
  private-data boundary.
- Never auto-merge companies by name alone or when known legal identifiers
  conflict.
- Never publish a quarantined or excluded identity as an ordinary candidate.

## Pilot

The first shadow run should cover 50 reviewed companies across active
SiteFinder signals, curated CRM companies, ambiguous identities and cleanup
quarantine cases. It must generate a review pack and dry-run differences only.
No write-back or outreach phase may be proposed until identical reruns produce
no duplicates and no protected, quarantined or suppressed identity is promoted.
