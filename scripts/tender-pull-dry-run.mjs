#!/usr/bin/env node
// Dry run of the tender pull: reads the public Find a Tender and Contracts
// Finder feeds for a window and prints what would be ingested. Writes nothing
// to any database; --out only writes a local JSON file.
//
//   node scripts/tender-pull-dry-run.mjs [--days 1] [--from ISO --to ISO]
//     [--sources fts,cf] [--max-pages 2] [--out /tmp/tender-dry-run.json]
//
// TENDER_FTS_BASE_URL / TENDER_CF_BASE_URL override the feed hosts.

import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pullFeedWindow, TENDER_SOURCES } from '../supabase/functions/_shared/tender-ingest.js';

const { values } = parseArgs({
  options: {
    days: { type: 'string', default: '1' },
    from: { type: 'string' },
    to: { type: 'string' },
    sources: { type: 'string', default: 'fts,cf' },
    'max-pages': { type: 'string', default: '2' },
    out: { type: 'string' },
  },
});

const to = values.to ? new Date(values.to) : new Date();
const from = values.from ? new Date(values.from) : new Date(to.getTime() - Number(values.days) * 86400000);
if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
  console.error('Invalid window: --from must be before --to');
  process.exit(2);
}
const sources = values.sources.split(',').map((s) => s.trim()).filter(Boolean);
for (const source of sources) {
  if (!TENDER_SOURCES[source]) {
    console.error(`Unknown source ${source}; use fts and/or cf`);
    process.exit(2);
  }
}
const maxPages = Math.max(1, Number(values['max-pages']) || 1);
const baseUrls = { fts: process.env.TENDER_FTS_BASE_URL, cf: process.env.TENDER_CF_BASE_URL };

console.log(`Dry run (writes nothing): ${from.toISOString()} -> ${to.toISOString()}, up to ${maxPages} page(s) per source`);

const results = [];
for (const source of sources) {
  const result = await pullFeedWindow({ source, from, to, baseUrl: baseUrls[source], maxPages });
  results.push(result);
  const stages = {};
  for (const notice of result.notices) stages[notice.stage ?? 'unknown'] = (stages[notice.stage ?? 'unknown'] || 0) + 1;
  console.log(`\n${TENDER_SOURCES[source].label} (${source})`);
  console.log(`  status:        ${result.status}`);
  console.log(`  pages:         ${result.pages}`);
  console.log(`  http statuses: ${result.httpStatuses.join(', ') || 'none'}`);
  console.log(`  releases:      ${result.fetched} (${result.skipped} skipped without ocid/id)`);
  console.log(`  stages:        ${Object.entries(stages).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  if (result.nextCursor) console.log(`  next cursor:   ${result.nextCursor}`);
  if (result.error) console.log(`  error:         ${result.error}`);
}

const notices = results.flatMap((r) => r.notices);
const uniqueOcids = new Set(notices.map((n) => n.ocid));
console.log(`\nTotal: ${notices.length} releases, ${uniqueOcids.size} distinct notices after ocid dedupe`);

if (values.out) {
  writeFileSync(values.out, `${JSON.stringify({ from, to, results }, null, 2)}\n`);
  console.log(`Wrote ${values.out}`);
}

process.exit(results.some((r) => r.status === 'failed') ? 1 : 0);
