// Scores one normalised tender notice (a tender_notices row) against one
// tenant's tender_tenant_settings row. Pure and deterministic given `now`.
// Every list the score depends on comes from the tenant's settings; the only
// built-in rule is the generic "council or social housing buyer" signal, whose
// weight each tenant controls.

export const DEFAULT_TENDER_WEIGHTS = Object.freeze({
  cpv_primary: 40,
  cpv_secondary: 15,
  keyword_title: 25,
  keyword_description: 10,
  region_or_buyer_allow: 20,
  buyer_type: 10,
  stage_tender: 10,
  stage_planning: 5,
  negative_keyword: -50,
  value_outside_band: -20,
});

export const SIGNAL_ORDER = Object.freeze(Object.keys(DEFAULT_TENDER_WEIGHTS));
export const URGENT_WITHIN_MS = 7 * 24 * 60 * 60 * 1000;
export const SCORE_BREAKDOWN_VERSION = 1;

const CLOSED_TENDER_STATUSES = new Set(['cancelled', 'unsuccessful', 'complete', 'withdrawn']);
const BUYER_TYPE_PATTERN = /\b(council|borough|county|unitary authority|combined authority|housing|homes|registered provider)\b/i;
const LOCAL_AUTHORITY_CLASSIFICATIONS = new Set(['publicAuthoritySubCentralGovernment']);

function list(value) {
  return Array.isArray(value) ? value.map((v) => String(v ?? '').trim()).filter(Boolean) : [];
}

export function resolveWeights(weights) {
  const resolved = { ...DEFAULT_TENDER_WEIGHTS };
  if (weights && typeof weights === 'object') {
    for (const key of SIGNAL_ORDER) {
      const n = Number(weights[key]);
      if (weights[key] !== null && weights[key] !== '' && Number.isFinite(n)) resolved[key] = n;
    }
  }
  return resolved;
}

// "45000000" is the whole construction division, "45440000" a group within it:
// trailing zeros widen the match, so a tenant can list parent codes.
export function cpvPrefix(code) {
  const digits = String(code ?? '').replace(/\D/g, '').slice(0, 8);
  if (digits.length < 2) return null;
  const trimmed = digits.replace(/0+$/, '');
  return trimmed.length >= 2 ? trimmed : digits.slice(0, 2);
}

function matchCpv(noticeCodes, settingCodes) {
  const matched = [];
  for (const setting of settingCodes) {
    const prefix = cpvPrefix(setting);
    if (prefix && noticeCodes.some((code) => String(code).startsWith(prefix))) matched.push(setting);
  }
  return matched;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Case-insensitive whole-word (or whole-phrase) match.
export function containsTerm(text, term) {
  if (!text || !term) return false;
  const pattern = escapeRegExp(term.toLowerCase()).replace(/\s+/g, '\\s+');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${pattern}($|[^\\p{L}\\p{N}])`, 'iu').test(text);
}

function matchTerms(text, terms) {
  return terms.filter((term) => containsTerm(text, term));
}

function postcodeArea(postcode) {
  return (String(postcode).match(/^[A-Z]+/) || [''])[0];
}

// Settings regions are ITL/NUTS prefixes ("UKI", "UKD37") or postcode areas
// and districts ("M", "SW1A").
function matchRegions(notice, regions) {
  const noticeRegions = list(notice.regions).map((r) => r.toUpperCase());
  const postcodes = list(notice.postcodes).map((p) => p.toUpperCase().replace(/\s+/g, ''));
  const matched = [];
  for (const entry of regions) {
    const code = entry.toUpperCase().replace(/\s+/g, '');
    const hit = /^UK[A-Z0-9]*$/.test(code)
      ? noticeRegions.some((r) => r.startsWith(code))
      : /^[A-Z]+$/.test(code)
        ? postcodes.some((p) => postcodeArea(p) === code)
        : postcodes.some((p) => p.slice(0, -3) === code || p.startsWith(code));
    if (hit) matched.push(entry);
  }
  return matched;
}

function matchBuyers(notice, buyers) {
  const name = String(notice.buyer_name ?? '').toLowerCase();
  const id = String(notice.buyer_id ?? '').toLowerCase();
  return buyers.filter((buyer) => {
    const b = buyer.toLowerCase();
    return (id && id === b) || (name && name.includes(b));
  });
}

function isCouncilOrHousingBuyer(notice) {
  if (BUYER_TYPE_PATTERN.test(String(notice.buyer_name ?? ''))) return true;
  const parties = Array.isArray(notice.raw?.parties) ? notice.raw.parties : [];
  return parties.some((party) => Array.isArray(party?.roles) && party.roles.includes('buyer')
    && (party.details?.classifications || []).some((c) => LOCAL_AUTHORITY_CLASSIFICATIONS.has(c?.id)));
}

export function isUrgent(notice, now = Date.now()) {
  const deadline = Date.parse(notice?.tender_deadline ?? '');
  if (Number.isNaN(deadline)) return false;
  const remaining = deadline - now;
  return remaining > 0 && remaining < URGENT_WITHIN_MS;
}

const clamp = (n) => Math.min(100, Math.max(0, Math.round(n)));

// Returns { score, urgent, breakdown }. breakdown is stored as
// tender_leads.score_breakdown: signals in a fixed order, each with the weight
// applied and the tenant terms that matched, so the UI can explain the score.
export function scoreNotice(notice, settings = {}, { now = Date.now() } = {}) {
  const weights = resolveWeights(settings.weights);
  const signals = [];
  const add = (signal, matched = []) => {
    signals.push({ signal, weight: weights[signal], matched: [...matched].sort() });
  };

  const blockedBy = matchBuyers(notice, list(settings.buyer_block));
  const urgent = isUrgent(notice, now);
  if (blockedBy.length) {
    return {
      score: 0,
      urgent,
      breakdown: {
        version: SCORE_BREAKDOWN_VERSION,
        blocked: true,
        blocked_by: blockedBy.sort(),
        signals: [],
        raw: 0,
        score: 0,
      },
    };
  }

  const cpvCodes = list(notice.cpv_codes);
  const primary = matchCpv(cpvCodes, list(settings.cpv_primary));
  if (primary.length) add('cpv_primary', primary);
  else {
    const secondary = matchCpv(cpvCodes, list(settings.cpv_secondary));
    if (secondary.length) add('cpv_secondary', secondary);
  }

  const keywords = list(settings.keywords);
  const titleHits = matchTerms(notice.title, keywords);
  if (titleHits.length) add('keyword_title', titleHits);
  else {
    const descriptionHits = matchTerms(notice.description, keywords);
    if (descriptionHits.length) add('keyword_description', descriptionHits);
  }

  const placeOrBuyer = [...matchRegions(notice, list(settings.regions)), ...matchBuyers(notice, list(settings.buyer_allow))];
  if (placeOrBuyer.length) add('region_or_buyer_allow', placeOrBuyer);

  if (isCouncilOrHousingBuyer(notice)) add('buyer_type');

  if (notice.stage === 'tender' && !CLOSED_TENDER_STATUSES.has(String(notice.tender_status ?? '').toLowerCase())) {
    add('stage_tender');
  } else if (notice.stage === 'planning') {
    add('stage_planning');
  }

  const negatives = list(settings.negative_keywords).filter(
    (term) => containsTerm(notice.title, term) || containsTerm(notice.description, term),
  );
  if (negatives.length) add('negative_keyword', negatives);

  const value = notice.value_amount == null ? null : Number(notice.value_amount);
  const min = settings.min_value == null ? null : Number(settings.min_value);
  const max = settings.max_value == null ? null : Number(settings.max_value);
  if (value != null && Number.isFinite(value)
      && ((min != null && value < min) || (max != null && value > max))) {
    add('value_outside_band');
  }

  signals.sort((a, b) => SIGNAL_ORDER.indexOf(a.signal) - SIGNAL_ORDER.indexOf(b.signal));
  const raw = signals.reduce((sum, s) => sum + s.weight, 0);
  const score = clamp(raw);
  return {
    score,
    urgent,
    breakdown: { version: SCORE_BREAKDOWN_VERSION, blocked: false, signals, raw, score },
  };
}

// Builds tender_leads rows for one tenant. Notices scoring below the tenant's
// min_score_to_show are still returned; the UI hides them behind a toggle.
export function buildTenderLeads(notices, settings, { now = Date.now() } = {}) {
  const scoredAt = new Date(now).toISOString();
  return (Array.isArray(notices) ? notices : []).map((notice) => {
    const { score, urgent, breakdown } = scoreNotice(notice, settings, { now });
    return {
      tenant_id: settings.tenant_id,
      ocid: notice.ocid,
      score,
      score_breakdown: breakdown,
      urgent,
      scored_at: scoredAt,
      settings_version: settings.settings_version ?? null,
    };
  });
}
