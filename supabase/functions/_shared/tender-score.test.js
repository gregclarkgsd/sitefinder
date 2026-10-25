import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { normaliseRelease } from './tender-ingest.js';
import {
  buildTenderLeads,
  containsTerm,
  cpvPrefix,
  DEFAULT_TENDER_WEIGHTS,
  isUrgent,
  matchesTenantCriteria,
  resolveWeights,
  scoreNotice,
} from './tender-score.js';

const now = Date.parse('2026-10-25T12:00:00Z');
const base = {
  ocid: 'ocds-test-1',
  stage: 'award',
  tender_status: 'complete',
  title: 'Supply of widgets',
  description: 'A framework for widgets and gadgets.',
  buyer_name: 'Example Trust',
  buyer_id: 'GB-TEST-1',
  cpv_codes: ['30192000'],
  regions: ['UKD37'],
  postcodes: ['OL1 1UT'],
  value_amount: 50000,
  tender_deadline: null,
  raw: {},
};
const notice = (overrides) => ({ ...base, ...overrides });
const signalsOf = (result) => result.breakdown.signals.map((s) => s.signal);

test('scores nothing when settings are empty', () => {
  const result = scoreNotice(base, {}, { now });
  assert.equal(result.score, 0);
  assert.deepEqual(result.breakdown.signals, []);
  assert.equal(result.breakdown.blocked, false);
});

test('primary CPV match, including parent codes', () => {
  assert.equal(cpvPrefix('45000000'), '45');
  assert.equal(cpvPrefix('45442100-8'), '454421');
  assert.equal(cpvPrefix('x'), null);
  const result = scoreNotice(notice({ cpv_codes: ['45442100'] }), { cpv_primary: ['45440000'] }, { now });
  assert.equal(result.score, 40);
  assert.deepEqual(result.breakdown.signals, [{ signal: 'cpv_primary', weight: 40, matched: ['45440000'] }]);
  assert.equal(scoreNotice(notice({ cpv_codes: ['45210000'] }), { cpv_primary: ['45440000'] }, { now }).score, 0);
});

test('secondary CPV counts only when no primary code matched', () => {
  const settings = { cpv_primary: ['45440000'], cpv_secondary: ['45000000'] };
  assert.deepEqual(signalsOf(scoreNotice(notice({ cpv_codes: ['45210000'] }), settings, { now })), ['cpv_secondary']);
  assert.equal(scoreNotice(notice({ cpv_codes: ['45210000'] }), settings, { now }).score, 15);
  assert.deepEqual(signalsOf(scoreNotice(notice({ cpv_codes: ['45442100'] }), settings, { now })), ['cpv_primary']);
});

test('keyword in title beats keyword in description', () => {
  assert.equal(containsTerm('Widget supply', 'widget'), true);
  assert.equal(containsTerm('Widgetry supply', 'widget'), false);
  assert.equal(containsTerm('Planned  maintenance works', 'planned maintenance'), true);
  assert.equal(scoreNotice(base, { keywords: ['widgets'] }, { now }).score, 25);
  assert.deepEqual(scoreNotice(base, { keywords: ['gadgets'] }, { now }).breakdown.signals, [
    { signal: 'keyword_description', weight: 10, matched: ['gadgets'] },
  ]);
});

test('region prefixes, postcode areas and districts, and buyer allow-list share one signal', () => {
  assert.equal(scoreNotice(base, { regions: ['UKD'] }, { now }).score, 20);
  assert.equal(scoreNotice(base, { regions: ['UKI'] }, { now }).score, 0);
  assert.equal(scoreNotice(base, { regions: ['OL'] }, { now }).score, 20);
  assert.equal(scoreNotice(base, { regions: ['O'] }, { now }).score, 0, 'an area must match all its letters');
  assert.equal(scoreNotice(base, { regions: ['OL1'] }, { now }).score, 20);
  assert.equal(scoreNotice(base, { regions: ['OL12'] }, { now }).score, 0);
  const both = scoreNotice(base, { regions: ['UKD3'], buyer_allow: ['example trust'] }, { now });
  assert.equal(both.score, 20);
  assert.deepEqual(both.breakdown.signals[0].matched, ['UKD3', 'example trust']);
  assert.equal(scoreNotice(base, { buyer_allow: ['GB-TEST-1'] }, { now }).score, 20);
});

test('council or social housing buyers get the buyer type signal', () => {
  assert.equal(scoreNotice(notice({ buyer_name: 'Oldham Council' }), {}, { now }).score, 10);
  assert.equal(scoreNotice(notice({ buyer_name: 'Riverside Housing Association' }), {}, { now }).score, 10);
  const classified = notice({
    buyer_name: 'Somewhere Authority',
    raw: { parties: [{ roles: ['buyer'], details: { classifications: [{ id: 'publicAuthoritySubCentralGovernment' }] } }] },
  });
  assert.equal(scoreNotice(classified, {}, { now }).score, 10);
  assert.equal(scoreNotice(notice({ buyer_name: 'Councillor Supplies Ltd' }), {}, { now }).score, 0);
});

test('open tenders and planning notices get stage signals; closed tenders do not', () => {
  assert.equal(scoreNotice(notice({ stage: 'tender', tender_status: 'active' }), {}, { now }).score, 10);
  assert.equal(scoreNotice(notice({ stage: 'tender', tender_status: 'cancelled' }), {}, { now }).score, 0);
  assert.equal(scoreNotice(notice({ stage: 'planning', tender_status: 'planning' }), {}, { now }).score, 5);
  assert.equal(scoreNotice(notice({ stage: 'contract' }), {}, { now }).score, 0);
});

test('negative keywords subtract and the total clamps at 0', () => {
  const result = scoreNotice(base, { keywords: ['widgets'], negative_keywords: ['gadgets'] }, { now });
  assert.equal(result.breakdown.raw, -25);
  assert.equal(result.score, 0);
  assert.deepEqual(result.breakdown.signals.at(-1), { signal: 'negative_keyword', weight: -50, matched: ['gadgets'] });
});

test('value outside the band subtracts; unknown values are not penalised', () => {
  const settings = { keywords: ['widgets'], min_value: 100000 };
  assert.equal(scoreNotice(base, settings, { now }).score, 5);
  assert.equal(scoreNotice(base, { ...settings, min_value: 10000, max_value: 40000 }, { now }).score, 5);
  assert.equal(scoreNotice(base, { ...settings, min_value: 10000, max_value: 60000 }, { now }).score, 25);
  assert.equal(scoreNotice(notice({ value_amount: null }), settings, { now }).score, 25);
});

test('buyer block-list forces 0 whatever else matches', () => {
  const result = scoreNotice(notice({ stage: 'tender', tender_status: 'active' }), {
    keywords: ['widgets'], cpv_primary: ['30000000'], buyer_block: ['Example'],
  }, { now });
  assert.equal(result.score, 0);
  assert.equal(result.breakdown.blocked, true);
  assert.deepEqual(result.breakdown.blocked_by, ['Example']);
  assert.deepEqual(result.breakdown.signals, []);
});

test('the total clamps at 100', () => {
  const result = scoreNotice(notice({ stage: 'tender', tender_status: 'active', buyer_name: 'Example Council' }), {
    cpv_primary: ['30000000'], keywords: ['widgets'], regions: ['UKD'],
  }, { now });
  assert.equal(result.breakdown.raw, 105);
  assert.equal(result.score, 100);
});

test('tenant weights override the template; missing or invalid keys fall back', () => {
  assert.deepEqual(resolveWeights(undefined), DEFAULT_TENDER_WEIGHTS);
  const weights = resolveWeights({ keyword_title: 60, cpv_primary: 'x', stage_tender: null });
  assert.equal(weights.keyword_title, 60);
  assert.equal(weights.cpv_primary, 40);
  assert.equal(weights.stage_tender, 10);
  assert.equal(scoreNotice(base, { keywords: ['widgets'], weights: { keyword_title: 60 } }, { now }).score, 60);
  assert.equal(scoreNotice(base, { keywords: ['widgets'], weights: { keyword_title: 0 } }, { now }).score, 0);
});

test('urgent only when the deadline is in the future and under 7 days away', () => {
  assert.equal(isUrgent({ tender_deadline: '2026-10-31T12:00:00Z' }, now), true);
  assert.equal(isUrgent({ tender_deadline: '2026-11-01T12:00:00Z' }, now), false);
  assert.equal(isUrgent({ tender_deadline: '2026-10-24T12:00:00Z' }, now), false);
  assert.equal(isUrgent({ tender_deadline: null }, now), false);
  assert.equal(scoreNotice(notice({ tender_deadline: '2026-10-27T00:00:00Z' }), {}, { now }).urgent, true);
});

test('the breakdown is stable regardless of settings order', () => {
  const n = notice({ stage: 'tender', tender_status: 'active', buyer_name: 'Example Council' });
  const a = scoreNotice(n, { keywords: ['widgets', 'supply'], regions: ['UKD', 'OL'], cpv_primary: ['30192000'] }, { now });
  const b = scoreNotice(n, { cpv_primary: ['30192000'], regions: ['OL', 'UKD'], keywords: ['supply', 'widgets'] }, { now });
  assert.deepEqual(a, b);
  assert.deepEqual(a.breakdown.signals.map((s) => s.signal),
    ['cpv_primary', 'keyword_title', 'region_or_buyer_allow', 'buyer_type', 'stage_tender']);
});

test('scores a real Find a Tender fixture end to end', () => {
  const page = JSON.parse(readFileSync(new URL('./fixtures/tender-fts-page.json', import.meta.url), 'utf8'));
  const n = normaliseRelease(page.releases[2], 'fts');
  const result = scoreNotice(n, { cpv_primary: ['45000000'], keywords: ['landscaping'], regions: ['UKD'] }, { now });
  assert.deepEqual(result.breakdown.signals.map((s) => s.signal),
    ['cpv_primary', 'keyword_title', 'region_or_buyer_allow', 'buyer_type', 'stage_tender']);
  assert.equal(result.score, 100);
  assert.equal(result.urgent, false);
});

test('only tenant criteria, not generic signals, make a notice a lead candidate', () => {
  const council = notice({ buyer_name: 'Oldham Council', stage: 'tender', tender_status: 'active' });
  assert.equal(matchesTenantCriteria(scoreNotice(council, {}, { now }).breakdown), false);
  assert.equal(matchesTenantCriteria(scoreNotice(council, { regions: ['UKD'] }, { now }).breakdown), true);
  assert.equal(matchesTenantCriteria(scoreNotice(council, { regions: ['UKD'], buyer_block: ['Oldham'] }, { now }).breakdown), false);
  assert.equal(matchesTenantCriteria(undefined), false);
});

test('builds lead rows carrying the tenant and settings version', () => {
  const [lead] = buildTenderLeads([base], { tenant_id: 't1', settings_version: 3, keywords: ['widgets'] }, { now });
  assert.deepEqual(Object.keys(lead).sort(),
    ['ocid', 'score', 'score_breakdown', 'scored_at', 'settings_version', 'tenant_id', 'urgent']);
  assert.equal(lead.tenant_id, 't1');
  assert.equal(lead.settings_version, 3);
  assert.equal(lead.score, 25);
  assert.equal(lead.scored_at, '2026-10-25T12:00:00.000Z');
});
