// Pure helpers for pulling and normalising UK public procurement notices from
// Find a Tender (fts) and Contracts Finder (cf). Both publish OCDS release
// packages. Runs unchanged in Node (tests, dry run) and Deno (edge function).
// Read-only: these helpers only ever issue GET requests.

export const TENDER_SOURCES = Object.freeze({
  fts: Object.freeze({
    code: 'fts',
    label: 'Find a Tender',
    publicBaseUrl: 'https://www.find-tender.service.gov.uk',
    searchPath: '/api/1.0/ocdsReleasePackages',
    fromParam: 'updatedFrom',
    toParam: 'updatedTo',
  }),
  cf: Object.freeze({
    code: 'cf',
    label: 'Contracts Finder',
    publicBaseUrl: 'https://www.contractsfinder.service.gov.uk',
    searchPath: '/Published/Notices/OCDS/Search',
    fromParam: 'publishedFrom',
    toParam: 'publishedTo',
  }),
});

export const MAX_PAGE_LIMIT = 100;
export const MIN_REQUEST_INTERVAL_MS = 6000;
export const MAX_RETRIES = 3;
export const MAX_RETRY_AFTER_MS = 120000;
// The feeds' firewall returns 403 to the default Deno user agent, so every
// request names itself explicitly.
export const FEED_USER_AGENT = 'SiteFinder-TenderPull/1.0 (public OCDS reader)';

function sourceConfig(source) {
  const config = TENDER_SOURCES[source];
  if (!config) throw new Error(`Unknown tender source: ${source}`);
  return config;
}

function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Both feeds reject milliseconds and offsets: they want YYYY-MM-DDTHH:MM:SS (UTC).
export function formatFeedTimestamp(value) {
  const date = toDate(value);
  if (!date) throw new Error(`Invalid feed timestamp: ${value}`);
  return date.toISOString().slice(0, 19);
}

export function buildFeedUrl(source, { baseUrl, from, to, cursor, limit = MAX_PAGE_LIMIT, stages } = {}) {
  const config = sourceConfig(source);
  if (from == null || to == null) {
    throw new Error(`${config.label} requests need both a from and a to timestamp`);
  }
  const url = new URL(config.searchPath, baseUrl || config.publicBaseUrl);
  url.searchParams.set(config.fromParam, formatFeedTimestamp(from));
  url.searchParams.set(config.toParam, formatFeedTimestamp(to));
  url.searchParams.set('limit', String(Math.min(Math.max(1, Math.trunc(Number(limit) || MAX_PAGE_LIMIT)), MAX_PAGE_LIMIT)));
  if (source === 'fts' && Array.isArray(stages) && stages.length) {
    url.searchParams.set('stages', stages.join(','));
  }
  if (cursor) url.searchParams.set('cursor', cursor);
  return url.toString();
}

// Retry-After is either delay-seconds or an HTTP date.
export function parseRetryAfter(value, { now = Date.now(), fallbackMs = MIN_REQUEST_INTERVAL_MS } = {}) {
  const text = String(value ?? '').trim();
  let ms = fallbackMs;
  if (/^\d+(\.\d+)?$/.test(text)) {
    ms = Math.round(Number(text) * 1000);
  } else if (text) {
    const at = Date.parse(text);
    if (!Number.isNaN(at)) ms = at - now;
  }
  return Math.min(Math.max(0, ms), MAX_RETRY_AFTER_MS);
}

export function extractNextCursor(pkg) {
  const next = pkg?.links?.next;
  if (typeof next !== 'string' || !next) return null;
  try {
    return new URL(next).searchParams.get('cursor') || null;
  } catch {
    return null;
  }
}

function snippet(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

// Classifies one HTTP response. A page is only 'ok' when the body is an OCDS
// package with a releases array; anything else is a failure, never "empty".
export function classifyFeedResponse({ status, headers, bodyText, now } = {}) {
  const getHeader = (name) => (typeof headers?.get === 'function' ? headers.get(name) : headers?.[name]);
  if (status === 429 || status === 503) {
    return {
      kind: 'retry',
      status,
      retryAfterMs: parseRetryAfter(getHeader('retry-after'), { now }),
      error: `HTTP ${status}${status === 429 ? ' (rate limited)' : ' (unavailable)'}`,
    };
  }
  if (!(status >= 200 && status < 300)) {
    return { kind: 'failed', status, error: `HTTP ${status}: ${snippet(bodyText) || 'no body'}` };
  }
  let pkg;
  try {
    pkg = JSON.parse(bodyText);
  } catch {
    return { kind: 'failed', status, error: `Response was not JSON: ${snippet(bodyText) || 'empty body'}` };
  }
  if (!pkg || !Array.isArray(pkg.releases)) {
    return { kind: 'failed', status, error: 'Response JSON had no releases array' };
  }
  return { kind: 'ok', status, releases: pkg.releases, nextCursor: extractNextCursor(pkg) };
}

const STAGE_BY_TAG = [
  ['contract', ['contract', 'contractUpdate', 'contractAmendment', 'implementation', 'implementationUpdate', 'contractTermination']],
  ['award', ['award', 'awardUpdate', 'awardCancellation']],
  ['tender', ['tender', 'tenderUpdate', 'tenderAmendment', 'tenderCancellation']],
  ['planning', ['planning', 'planningUpdate']],
];

export function stageFromTags(tags) {
  const list = Array.isArray(tags) ? tags : [];
  for (const [stage, stageTags] of STAGE_BY_TAG) {
    if (list.some((tag) => stageTags.includes(tag))) return stage;
  }
  return null;
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function cpvCode(classification) {
  if (!classification || String(classification.scheme || '').toUpperCase() !== 'CPV') return null;
  const match = String(classification.id ?? '').match(/^\d{8}/);
  return match ? match[0] : null;
}

function itemCpvCodes(items) {
  return arr(items).flatMap((item) => [
    cpvCode(item?.classification),
    ...arr(item?.additionalClassifications).map(cpvCode),
  ]);
}

function isoTimestamp(value) {
  const date = toDate(value);
  return date ? date.toISOString() : null;
}

// Dates are kept as published (the calendar date in the notice's own offset).
function isoDate(value) {
  const match = typeof value === 'string' ? value.match(/^(\d{4}-\d{2}-\d{2})/) : null;
  return match && toDate(match[1]) ? match[1] : null;
}

function normalisePostcode(value) {
  const compact = String(value ?? '').toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(compact)) return null;
  return `${compact.slice(0, -3)} ${compact.slice(-3)}`;
}

function amount(value) {
  const n = Number(value?.amount);
  return Number.isFinite(n) && n >= 0 ? { amount: n, currency: value?.currency || null } : null;
}

function noticeValue(release) {
  const tender = release.tender || {};
  const direct = amount(tender.value);
  if (direct) return direct;
  const lots = arr(tender.lots).map((lot) => amount(lot?.value)).filter(Boolean);
  if (lots.length) {
    return { amount: lots.reduce((sum, lot) => sum + lot.amount, 0), currency: lots[0].currency };
  }
  // Contracts Finder publishes 0 on awards whose value is undisclosed.
  const awards = arr(release.awards).map((award) => amount(award?.value)).filter((v) => v && v.amount > 0);
  if (awards.length) {
    return { amount: awards.reduce((sum, award) => sum + award.amount, 0), currency: awards[0].currency };
  }
  return null;
}

function contractPeriod(release) {
  const tender = release.tender || {};
  const candidates = [
    tender.contractPeriod,
    ...arr(tender.lots).map((lot) => lot?.contractPeriod),
    ...arr(release.awards).map((award) => award?.contractPeriod),
    ...arr(release.contracts).map((contract) => contract?.period),
  ].filter(Boolean);
  const starts = candidates.map((p) => isoDate(p.startDate)).filter(Boolean).sort();
  const ends = candidates.map((p) => isoDate(p.endDate)).filter(Boolean).sort();
  return { start: starts[0] || null, end: ends.at(-1) || null };
}

function buyerParty(release) {
  const buyerId = release.buyer?.id;
  const parties = arr(release.parties);
  return parties.find((p) => buyerId && p?.id === buyerId)
    || parties.find((p) => arr(p?.roles).includes('buyer'))
    || null;
}

function isFrameworkOrDps(tender) {
  const techniques = [tender.techniques, ...arr(tender.lots).map((lot) => lot?.techniques)].filter(Boolean);
  if (techniques.some((t) => t.hasFrameworkAgreement || t.hasDynamicPurchasingSystem)) return true;
  return /framework|dynamic purchasing/i.test(String(tender.procurementMethodDetails || ''));
}

function noticeUrl(source, release) {
  const config = sourceConfig(source);
  if (source === 'fts') {
    return release.id ? `${config.publicBaseUrl}/Notice/${encodeURIComponent(release.id)}` : null;
  }
  const docs = [
    ...arr(release.tender?.documents),
    ...arr(release.awards).flatMap((award) => arr(award?.documents)),
    ...arr(release.planning?.documents),
  ];
  const published = docs.find((doc) => typeof doc?.url === 'string' && doc.url.startsWith(`${config.publicBaseUrl}/Notice/`));
  if (published) return published.url;
  const noticeId = String(release.id || '').match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(-\d+)?$/i);
  return noticeId ? `${config.publicBaseUrl}/Notice/${noticeId[1]}` : null;
}

// Maps one OCDS release to a tender_notices row (keys match the column names
// read by public.ingest_tender_notices). Returns null for releases that lack
// the identifiers needed to dedupe.
export function normaliseRelease(release, source) {
  sourceConfig(source);
  if (!release || typeof release !== 'object') return null;
  const ocid = typeof release.ocid === 'string' ? release.ocid.trim() : '';
  const releaseId = release.id == null ? '' : String(release.id).trim();
  if (!ocid || !releaseId) return null;

  const tender = release.tender || {};
  const items = arr(tender.items);
  const awards = arr(release.awards);
  const buyer = buyerParty(release);
  const deliveryAddresses = items.flatMap((item) => arr(item?.deliveryAddresses));

  const deliveryRegions = deliveryAddresses.map((a) => a?.region).filter((r) => typeof r === 'string' && r.trim());
  const regions = uniq((deliveryRegions.length ? deliveryRegions : [buyer?.address?.region]).map((r) => r && String(r).trim().toUpperCase()));
  const postcodes = uniq([
    ...deliveryAddresses.map((a) => normalisePostcode(a?.postalCode)),
    normalisePostcode(buyer?.address?.postalCode),
  ]);

  const value = noticeValue(release);
  const period = contractPeriod(release);
  const suppliers = [];
  const seenSuppliers = new Set();
  for (const supplier of awards.flatMap((award) => arr(award?.suppliers))) {
    const key = supplier?.id || supplier?.name;
    if (!key || seenSuppliers.has(key)) continue;
    seenSuppliers.add(key);
    suppliers.push({ id: supplier.id ?? null, name: supplier.name ?? null });
  }

  return {
    ocid,
    source,
    release_id: releaseId,
    stage: stageFromTags(release.tag),
    tender_status: tender.status || null,
    title: tender.title || release.planning?.project?.title || null,
    description: tender.description || null,
    buyer_name: release.buyer?.name || buyer?.name || null,
    buyer_id: release.buyer?.id || buyer?.id || null,
    cpv_codes: uniq([
      cpvCode(tender.classification),
      ...itemCpvCodes(items),
      ...awards.flatMap((award) => itemCpvCodes(award?.items)),
    ]),
    regions,
    postcodes,
    value_amount: value?.amount ?? null,
    value_currency: value?.currency ?? null,
    tender_deadline: isoTimestamp(tender.tenderPeriod?.endDate),
    contract_start: period.start,
    contract_end: period.end,
    award_suppliers: suppliers,
    notice_url: noticeUrl(source, release),
    is_framework_or_dps: isFrameworkOrDps(tender),
    published_at: isoTimestamp(tender.datePublished || release.date),
    source_updated_at: isoTimestamp(release.date),
    raw: release,
  };
}

export function normaliseReleases(releases, source) {
  const notices = [];
  let skipped = 0;
  for (const release of arr(releases)) {
    const notice = normaliseRelease(release, source);
    if (notice) notices.push(notice);
    else skipped += 1;
  }
  return { notices, skipped };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Pulls every page of one source for a time window, throttled to one request
// per minIntervalMs and retrying 429/503 (honouring Retry-After) and network
// errors up to MAX_RETRIES times. Never throws for feed problems: the result's
// status says what happened so callers can log it.
//   ok      every page fetched, at least one notice
//   empty   every page fetched, the feed genuinely returned no releases
//   failed  the first page could not be fetched or parsed
//   partial some pages fetched, then a failure or the maxPages cap; nextCursor
//           says where to resume
export async function pullFeedWindow({
  source,
  from,
  to,
  baseUrl,
  cursor = null,
  limit = MAX_PAGE_LIMIT,
  stages,
  maxPages = Infinity,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  now = () => Date.now(),
  minIntervalMs = MIN_REQUEST_INTERVAL_MS,
  onPage,
} = {}) {
  sourceConfig(source);
  const result = {
    source,
    status: 'failed',
    pages: 0,
    fetched: 0,
    skipped: 0,
    httpStatuses: [],
    httpStatus: null,
    nextCursor: cursor,
    error: null,
    notices: [],
  };
  let lastRequestAt = null;
  let nextCursor = cursor;

  const request = async (url) => {
    for (let attempt = 0; ; attempt += 1) {
      if (lastRequestAt !== null) {
        const wait = lastRequestAt + minIntervalMs - now();
        if (wait > 0) await sleep(wait);
      }
      lastRequestAt = now();
      let outcome;
      try {
        const response = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': FEED_USER_AGENT } });
        const bodyText = await response.text();
        outcome = classifyFeedResponse({ status: response.status, headers: response.headers, bodyText, now: now() });
      } catch (error) {
        outcome = { kind: 'retry', status: null, retryAfterMs: minIntervalMs, error: `Network error: ${error?.message || error}` };
      }
      result.httpStatuses.push(outcome.status);
      result.httpStatus = outcome.status;
      if (outcome.kind !== 'retry' || attempt >= MAX_RETRIES) {
        return outcome.kind === 'retry' ? { ...outcome, kind: 'failed', error: `${outcome.error} after ${MAX_RETRIES} retries` } : outcome;
      }
      await sleep(outcome.retryAfterMs);
      lastRequestAt = null;
    }
  };

  while (result.pages < maxPages) {
    const url = buildFeedUrl(source, { baseUrl, from, to, cursor: nextCursor, limit, stages });
    const outcome = await request(url);
    if (outcome.kind !== 'ok') {
      result.error = outcome.error;
      result.status = result.pages === 0 ? 'failed' : 'partial';
      result.nextCursor = nextCursor;
      return result;
    }
    const { notices, skipped } = normaliseReleases(outcome.releases, source);
    if (onPage) {
      try {
        await onPage({ page: result.pages + 1, notices, releases: outcome.releases, cursor: nextCursor });
      } catch (error) {
        result.error = `Could not store page ${result.pages + 1}: ${error?.message || error}`;
        result.status = result.pages === 0 ? 'failed' : 'partial';
        result.nextCursor = nextCursor;
        return result;
      }
    } else {
      result.notices.push(...notices);
    }
    result.pages += 1;
    result.fetched += outcome.releases.length;
    result.skipped += skipped;
    nextCursor = outcome.nextCursor && outcome.nextCursor !== nextCursor ? outcome.nextCursor : null;
    if (!nextCursor || outcome.releases.length === 0) {
      result.nextCursor = null;
      result.status = result.fetched > 0 ? 'ok' : 'empty';
      return result;
    }
  }
  result.nextCursor = nextCursor;
  result.status = 'partial';
  result.error = `Stopped after ${maxPages} pages; resume from next_cursor`;
  return result;
}
