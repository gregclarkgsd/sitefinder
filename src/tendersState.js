export const TENDER_SOURCE_LABELS = Object.freeze({fts: 'Find a Tender', cf: 'Contracts Finder'});
export const BROKEN_AFTER_MS = 26 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const OGL_NOTICE = 'Contains public sector information licensed under the Open Government Licence v3.0';

// Lead statuses grouped for the list filter. "Saved" covers every stage a
// tenant is actively working; "new" is everything not yet looked at.
export const STATUS_GROUPS = Object.freeze({
  active: ['to_qualify', 'qualifying', 'bid_no_bid', 'bidding', 'submitted', 'won', 'lost'],
  new: ['to_qualify'],
  saved: ['qualifying', 'bid_no_bid', 'bidding', 'submitted', 'won', 'lost'],
  dismissed: ['dismissed'],
  all: null,
});

export const EMPTY_TENDER_FILTERS = Object.freeze({
  search: '',
  stage: '',
  region: '',
  minScore: '',
  maxScore: '',
  deadline: '',
  frameworkOnly: false,
  status: 'active',
  showBelowThreshold: false,
});

const time = value => {
  const ms = Date.parse(value ?? '');
  return Number.isNaN(ms) ? null : ms;
};

const formatTime = ms => new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London',
}).format(new Date(ms));

// One banner per source, worked out from recent tender_pull_runs rows.
// A source is broken when its latest attempt failed or it has had no ok or
// empty run in the last 26 hours, so stale data is never shown silently.
export function sourceHealth(runs, now = Date.now(), sources = Object.keys(TENDER_SOURCE_LABELS)) {
  return sources.map(source => {
    const label = TENDER_SOURCE_LABELS[source] || source;
    const attempts = (runs || [])
      .filter(run => run.source === source && run.status !== 'skipped' && run.status !== 'running')
      .map(run => ({...run, at: time(run.finished_at) ?? time(run.started_at)}))
      .filter(run => run.at !== null)
      .sort((a, b) => b.at - a.at);
    const lastGood = attempts.find(run => run.status === 'ok' || run.status === 'empty');
    const latest = attempts[0];

    if (!latest) {
      return {source, label, state: 'broken', lastGoodAt: null, brokenSince: null,
        message: `${label} has not been pulled yet: data may be out of date`};
    }
    const stale = !lastGood || now - lastGood.at > BROKEN_AFTER_MS;
    if (latest.status === 'failed' || latest.status === 'partial' || stale) {
      const failures = attempts.filter(run => !lastGood || run.at > lastGood.at);
      const brokenSince = failures.length
        ? failures.at(-1).at
        : lastGood.at + BROKEN_AFTER_MS;
      return {source, label, state: 'broken', lastGoodAt: lastGood?.at ?? null, brokenSince,
        error: latest.status === 'failed' || latest.status === 'partial' ? latest.error || null : null,
        message: `${label} feed broken since ${formatTime(brokenSince)}: data may be out of date`};
    }
    if (lastGood.status === 'empty') {
      const today = now - lastGood.at < DAY_MS;
      return {source, label, state: 'empty', lastGoodAt: lastGood.at, brokenSince: null,
        message: `${label}: ${today ? 'Nothing new today' : 'Nothing new'} (last good pull ${formatTime(lastGood.at)})`};
    }
    return {source, label, state: 'ok', lastGoodAt: lastGood.at, brokenSince: null,
      message: `${label}: Last good pull ${formatTime(lastGood.at)}`};
  });
}

export function matchedTerms(lead) {
  const signals = lead?.score_breakdown?.signals || [];
  return [...new Set(signals.flatMap(signal => signal.matched || []))];
}

export function compareLeads(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const da = time(a.notice?.tender_deadline), db = time(b.notice?.tender_deadline);
  if (da !== db) {
    if (da === null) return 1;
    if (db === null) return -1;
    return da - db;
  }
  return String(a.ocid).localeCompare(String(b.ocid));
}

function matchesDeadline(notice, window, now) {
  if (!window) return true;
  const deadline = time(notice?.tender_deadline);
  if (window === 'none') return deadline === null;
  if (deadline === null) return false;
  if (window === 'past') return deadline < now;
  const days = Number(window);
  return deadline >= now && deadline <= now + days * DAY_MS;
}

function numberOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Returns {visible, hiddenBelowThreshold}. Filters apply first; leads under
// the tenant's min score are then hidden unless the toggle is on.
export function filterLeads(leads, filters = EMPTY_TENDER_FILTERS, {now = Date.now(), minScoreToShow = 0} = {}) {
  const f = {...EMPTY_TENDER_FILTERS, ...filters};
  const statuses = Object.hasOwn(STATUS_GROUPS, f.status) ? STATUS_GROUPS[f.status] : STATUS_GROUPS.active;
  const search = f.search.trim().toLowerCase();
  const region = f.region.trim().toUpperCase();
  const minScore = numberOrNull(f.minScore), maxScore = numberOrNull(f.maxScore);

  const matching = (leads || []).filter(lead => {
    const notice = lead.notice || {};
    if (statuses && !statuses.includes(lead.status)) return false;
    if (f.stage && notice.stage !== f.stage) return false;
    if (region && !(notice.regions || []).some(code => String(code).toUpperCase().startsWith(region))) return false;
    if (minScore !== null && lead.score < minScore) return false;
    if (maxScore !== null && lead.score > maxScore) return false;
    if (f.frameworkOnly && !notice.is_framework_or_dps) return false;
    if (!matchesDeadline(notice, f.deadline, now)) return false;
    if (search) {
      const haystack = [notice.title, notice.buyer_name, notice.description, ...matchedTerms(lead)].join(' ').toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
  const above = matching.filter(lead => lead.score >= minScoreToShow);
  return {
    visible: (f.showBelowThreshold ? matching : above).sort(compareLeads),
    hiddenBelowThreshold: f.showBelowThreshold ? 0 : matching.length - above.length,
  };
}

export function regionOptions(leads) {
  const codes = new Set();
  for (const lead of leads || []) for (const code of lead.notice?.regions || []) codes.add(String(code).slice(0, 3).toUpperCase());
  return [...codes].filter(Boolean).sort();
}

export function formatTenderValue(amount, currency = 'GBP') {
  if (amount === null || amount === undefined || amount === '') return 'Not published';
  const n = Number(amount);
  if (!Number.isFinite(n)) return 'Not published';
  try {
    return new Intl.NumberFormat('en-GB', {style: 'currency', currency: currency || 'GBP', notation: n >= 100000 ? 'compact' : 'standard', maximumFractionDigits: n >= 100000 ? 1 : 0}).format(n);
  } catch {
    return `${n.toLocaleString('en-GB')} ${currency || ''}`.trim();
  }
}

export function formatDeadline(value, now = Date.now()) {
  const ms = time(value);
  if (ms === null) return 'No deadline';
  const date = new Intl.DateTimeFormat('en-GB', {day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London'}).format(new Date(ms));
  if (ms < now) return `Closed ${date}`;
  const days = Math.ceil((ms - now) / DAY_MS);
  return `${date} (${days} day${days === 1 ? '' : 's'})`;
}

export const STAGE_LABELS = Object.freeze({planning: 'Planning', tender: 'Tender', award: 'Award', contract: 'Contract'});
