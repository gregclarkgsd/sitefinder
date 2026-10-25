// Orchestrates one pull-tender-notices invocation: decides the window per
// source, pulls the feed, stores notices through public.ingest_tender_notices,
// logs a tender_pull_runs row per source and re-scores touched notices for
// every tenant with settings. All database access goes through the `db`
// adapter (see tender-pull-db.js) so this file stays testable without Supabase.

import { pullFeedWindow, TENDER_SOURCES } from './tender-ingest.js';
import { buildTenderLeads, matchesTenantCriteria } from './tender-score.js';

export const SCHEDULED_LONDON_HOUR = 5;
export const WINDOW_OVERLAP_MS = 60 * 60 * 1000;
export const FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60 * 1000;
export const MAX_BACKFILL_WINDOW_MS = 8 * 24 * 60 * 60 * 1000;
// A guess at what fits the edge function wall clock at 6s per request.
export const DEFAULT_MAX_PAGES = 10;
export const MAX_PAGES_LIMIT = 20;
export const RESCORE_BATCH = 200;

export function londonHour(date) {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', hour: 'numeric', hourCycle: 'h23',
  }).format(date));
}

// Constant-time comparison so the secret cannot be guessed byte by byte.
export function secretMatches(expected, provided) {
  if (!expected || typeof provided !== 'string') return false;
  const a = new TextEncoder().encode(expected);
  const b = new TextEncoder().encode(provided);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

function parseInstant(value, name) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new RequestError(`${name} is not a valid timestamp`);
  return date;
}

export class RequestError extends Error {}

// Query parameters:
//   (none)                 scheduled: runs only at 05:00 Europe/London
//   mode=manual            run now, same window rules as scheduled
//   from=&to=[&cursor=]    backfill one explicit window (at most 8 days)
//   sources=fts,cf         limit sources; max_pages=N caps pages per source
export function parsePullRequest(url, now = new Date()) {
  const params = new URL(url).searchParams;
  const sources = (params.get('sources') || 'fts,cf').split(',').map((s) => s.trim()).filter(Boolean);
  for (const source of sources) {
    if (!TENDER_SOURCES[source]) throw new RequestError(`Unknown source: ${source}`);
  }
  const requestedPages = params.get('max_pages');
  const maxPages = requestedPages == null
    ? DEFAULT_MAX_PAGES
    : Math.trunc(Number(requestedPages));
  if (!Number.isFinite(maxPages) || maxPages < 1 || maxPages > MAX_PAGES_LIMIT) {
    throw new RequestError(`max_pages must be between 1 and ${MAX_PAGES_LIMIT}`);
  }

  const from = params.get('from');
  const to = params.get('to');
  if (from || to) {
    if (!from || !to) throw new RequestError('Backfill needs both from and to');
    const window = { from: parseInstant(from, 'from'), to: parseInstant(to, 'to') };
    if (window.from >= window.to) throw new RequestError('from must be before to');
    if (window.to > now) throw new RequestError('to cannot be in the future');
    if (window.to - window.from > MAX_BACKFILL_WINDOW_MS) throw new RequestError('Backfill windows are at most 8 days; use 7-day slices');
    return { mode: 'backfill', sources: [...new Set(sources)], maxPages, window, cursor: params.get('cursor') || null };
  }
  const mode = params.get('mode') === 'manual' ? 'manual' : 'scheduled';
  return { mode, sources: [...new Set(sources)], maxPages, window: null, cursor: null };
}

// Where a scheduled or manual pull starts: resume an unfinished partial run,
// else from the last successful (ok or empty) run's end minus an hour of
// overlap, else the last 24 hours.
export function planSourceWindow(recentRuns, now) {
  const runs = [...(recentRuns || [])]
    .filter((run) => run.mode !== 'backfill')
    .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
  const latest = runs.find((run) => run.status !== 'skipped' && run.status !== 'running');
  if (latest?.status === 'partial' && latest.next_cursor && latest.window_from && latest.window_to) {
    return { from: new Date(latest.window_from), to: new Date(latest.window_to), cursor: latest.next_cursor, resumed: true };
  }
  const lastGood = runs.find((run) => (run.status === 'ok' || run.status === 'empty') && run.window_to);
  const from = lastGood
    ? new Date(new Date(lastGood.window_to).getTime() - WINDOW_OVERLAP_MS)
    : new Date(now.getTime() - FIRST_RUN_LOOKBACK_MS);
  return { from: from > now ? new Date(now.getTime() - WINDOW_OVERLAP_MS) : from, to: now, cursor: null, resumed: false };
}

async function pullSource({ db, source, request, now, fetchImpl, sleep, clock, baseUrls }) {
  const plan = request.mode === 'backfill'
    ? { ...request.window, cursor: request.cursor, resumed: false }
    : planSourceWindow(await db.recentRuns(source), now);
  const runId = await db.startRun({
    source, mode: request.mode, status: 'running', window_from: plan.from.toISOString(), window_to: plan.to.toISOString(),
  });
  const touched = new Set();
  let upserted = 0;
  let result;
  try {
    result = await pullFeedWindow({
      source,
      from: plan.from,
      to: plan.to,
      cursor: plan.cursor,
      baseUrl: baseUrls[source],
      maxPages: request.maxPages,
      fetchImpl,
      sleep,
      now: clock,
      onPage: async ({ notices }) => {
        if (!notices.length) return;
        const stored = await db.ingest(notices);
        upserted += (stored?.inserted ?? 0) + (stored?.updated ?? 0);
        for (const ocid of stored?.touched_ocids ?? []) touched.add(ocid);
      },
    });
  } catch (error) {
    result = { status: 'failed', pages: 0, fetched: 0, httpStatus: null, nextCursor: plan.cursor, error: String(error?.message || error) };
  }
  const run = {
    status: result.status,
    finished_at: new Date(clock()).toISOString(),
    pages: result.pages,
    fetched: result.fetched,
    upserted,
    http_status: result.httpStatus,
    next_cursor: result.nextCursor,
    error: result.error,
  };
  await db.finishRun(runId, run);
  return { source, runId, window: { from: plan.from.toISOString(), to: plan.to.toISOString() }, resumed: plan.resumed, ...run, touched: [...touched] };
}

// Re-scores notices for every tenant with settings (or just `tenantIds`).
// Inserts a lead for each notice that scores above 0 and matches one of the
// tenant's own criteria, and refreshes the score of existing leads, never
// touching their workflow fields. With ocids null it
// walks every stored notice.
export async function rescoreTenants({ db, ocids = null, tenantIds = null, now = Date.now() }) {
  const settingsRows = (await db.tenantSettings(tenantIds)) || [];
  const summary = { tenants: settingsRows.length, notices: 0, leads_written: 0 };
  if (!settingsRows.length) return summary;

  const batches = ocids === null
    ? db.allNoticeBatches(RESCORE_BATCH)
    : (async function* chunks() {
      const list = [...new Set(ocids)];
      for (let i = 0; i < list.length; i += RESCORE_BATCH) yield await db.noticesByOcid(list.slice(i, i + RESCORE_BATCH));
    })();

  for await (const notices of batches) {
    if (!notices.length) continue;
    summary.notices += notices.length;
    for (const settings of settingsRows) {
      const leads = buildTenderLeads(notices, settings, { now });
      const isNewLead = (lead) => lead.score > 0 && matchesTenantCriteria(lead.score_breakdown);
      const others = leads.filter((lead) => !isNewLead(lead)).map((lead) => lead.ocid);
      const existing = new Set(others.length ? await db.existingLeadOcids(settings.tenant_id, others) : []);
      const rows = leads.filter((lead) => isNewLead(lead) || existing.has(lead.ocid));
      if (rows.length) {
        await db.upsertLeadScores(rows);
        summary.leads_written += rows.length;
      }
    }
  }
  return summary;
}

export async function runTenderPull({
  db,
  request,
  now = new Date(),
  fetchImpl = globalThis.fetch,
  sleep,
  clock = () => Date.now(),
  baseUrls = {},
}) {
  if (request.mode === 'scheduled' && londonHour(now) !== SCHEDULED_LONDON_HOUR) {
    const finished = now.toISOString();
    for (const source of request.sources) {
      await db.startRun({ source, mode: 'scheduled', status: 'skipped', started_at: finished, finished_at: finished });
    }
    return { status: 'skipped', reason: `Europe/London hour is ${londonHour(now)}, not ${SCHEDULED_LONDON_HOUR}`, sources: [] };
  }

  const sources = await Promise.all(request.sources.map((source) => pullSource({
    db, source, request, now, fetchImpl, sleep, clock, baseUrls,
  })));

  const touched = [...new Set(sources.flatMap((s) => s.touched))];
  let rescore = { tenants: 0, notices: 0, leads_written: 0 };
  let rescoreError = null;
  if (touched.length) {
    try {
      rescore = await rescoreTenants({ db, ocids: touched, now: clock() });
    } catch (error) {
      rescoreError = String(error?.message || error);
      for (const source of sources.filter((s) => s.touched.length && (s.status === 'ok' || s.status === 'partial'))) {
        source.status = 'partial';
        source.error = [source.error, `Notices stored but re-score failed: ${rescoreError}`].filter(Boolean).join('; ');
        await db.finishRun(source.runId, { status: source.status, error: source.error });
      }
    }
  }

  const statuses = sources.map((s) => s.status);
  const status = statuses.every((s) => s === 'failed')
    ? 'failed'
    : statuses.some((s) => s === 'failed' || s === 'partial') ? 'partial'
      : statuses.every((s) => s === 'empty') ? 'empty' : 'ok';
  return {
    status,
    mode: request.mode,
    sources: sources.map(({ touched: t, ...rest }) => ({ ...rest, touched: t.length })),
    rescore,
    rescore_error: rescoreError,
  };
}
