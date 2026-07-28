# GSD Sales Enrichment — Phase 1

## Scope

Build a standalone, read-only service that:

1. snapshots Attio and Pipedrive without changing either system;
2. reconciles people by normalised business email and company domain;
3. crawls official company websites and public PDFs;
4. extracts target construction roles with source evidence;
5. adds optional Companies House and public-procurement signals;
6. writes private review files, never CRM updates.

## Hard boundaries

- Do not edit or run code in `/Users/gregclark/sitefinder`.
- Do not edit or execute `/Users/gregclark/gsd_attio_migration`.
- Do not deploy functions, migrations, websites or scheduled jobs.
- Do not implement Attio or Pipedrive write methods in Phase 1.
- Do not scrape logged-in LinkedIn pages or bypass access controls.
- Do not treat inferred email addresses as verified.
- Keep personal data and credentials outside Git.

## Pilot

The first live run should cover the approved main-contractor subset only. It
must generate a review pack before any separate write-back phase is proposed.
