import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {AlertTriangle, Bookmark, CheckCircle2, ExternalLink, Info, Landmark, RefreshCw, Rocket, RotateCcw, Search, X, XCircle} from 'lucide-react';
import './tenders.css';
import {supabase} from './supabase';
import {canEditTenantData} from './tenantContext';
import {
  applyLeadChanges,
  EMPTY_TENDER_FILTERS,
  filterLeads,
  formatDeadline,
  formatTenderValue,
  LEAD_STATUSES,
  leadActionChanges,
  matchedTerms,
  OGL_NOTICE,
  regionOptions,
  scoreReasons,
  sourceHealth,
  STAGE_LABELS,
  statusLabel,
  TENDER_SOURCE_LABELS,
} from './tendersState';

const LEAD_PAGE = 1000;
const MAX_LEADS = 5000;
export const NOTICE_COLUMNS = 'ocid,source,stage,tender_status,title,description,buyer_name,cpv_codes,regions,postcodes,value_amount,value_currency,tender_deadline,contract_start,contract_end,award_suppliers,notice_url,is_framework_or_dps,published_at';
const LEAD_COLUMNS = `ocid,score,score_breakdown,status,dismiss_reason,assigned_to,urgent,scored_at,updated_at,notice:tender_notices(${NOTICE_COLUMNS})`;

async function loadTenderLeads(tenantId) {
  const rows = [];
  for (let from = 0; from < MAX_LEADS; from += LEAD_PAGE) {
    const {data, error} = await supabase
      .from('tender_leads')
      .select(LEAD_COLUMNS)
      .eq('tenant_id', tenantId)
      .order('score', {ascending: false})
      .order('ocid')
      .range(from, from + LEAD_PAGE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < LEAD_PAGE) break;
  }
  return rows;
}

async function loadTenderPage(tenantId) {
  const [leads, settings, runs] = await Promise.all([
    loadTenderLeads(tenantId),
    supabase.from('tender_tenant_settings').select('*').eq('tenant_id', tenantId).maybeSingle(),
    supabase.from('tender_pull_runs').select('source,status,started_at,finished_at,error').order('started_at', {ascending: false}).limit(200),
  ]);
  if (settings.error) throw settings.error;
  if (runs.error) throw runs.error;
  return {leads, settings: settings.data, runs: runs.data || []};
}

function HealthBanner({health}) {
  return <div className="tender-health" aria-label="Feed status">
    {health.map(item => {
      const Icon = item.state === 'broken' ? AlertTriangle : item.state === 'empty' ? Info : CheckCircle2;
      return <div key={item.source} className={`tender-health-item ${item.state}`} role={item.state === 'broken' ? 'alert' : undefined} title={item.error || undefined}>
        <Icon size={15}/><span>{item.message}</span>
      </div>;
    })}
  </div>;
}

function TenderFilters({filters, setFilter, regions, clear}) {
  return <div className="tender-filters">
    <label className="search tender-search"><Search size={16}/><input value={filters.search} onChange={e => setFilter('search', e.target.value)} placeholder="Search title, buyer, matched terms…" aria-label="Search tenders"/></label>
    <label><span>Stage</span><select value={filters.stage} onChange={e => setFilter('stage', e.target.value)}>
      <option value="">All stages</option>{Object.entries(STAGE_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
    </select></label>
    <label><span>Region</span><select value={filters.region} onChange={e => setFilter('region', e.target.value)}>
      <option value="">All regions</option>{regions.map(code => <option key={code} value={code}>{code}</option>)}
    </select></label>
    <label><span>Score</span><span className="tender-range">
      <input type="number" min="0" max="100" value={filters.minScore} onChange={e => setFilter('minScore', e.target.value)} aria-label="Minimum score" placeholder="0"/>
      <input type="number" min="0" max="100" value={filters.maxScore} onChange={e => setFilter('maxScore', e.target.value)} aria-label="Maximum score" placeholder="100"/>
    </span></label>
    <label><span>Deadline</span><select value={filters.deadline} onChange={e => setFilter('deadline', e.target.value)}>
      <option value="">Any deadline</option><option value="7">Next 7 days</option><option value="30">Next 30 days</option><option value="90">Next 90 days</option><option value="past">Closed</option><option value="none">No deadline</option>
    </select></label>
    <label><span>Status</span><select value={filters.status} onChange={e => setFilter('status', e.target.value)}>
      <option value="active">Not dismissed</option><option value="new">New</option><option value="saved">Saved</option><option value="dismissed">Dismissed</option><option value="all">All</option>
    </select></label>
    <label className="tender-check"><input type="checkbox" checked={filters.frameworkOnly} onChange={e => setFilter('frameworkOnly', e.target.checked)}/><span>Framework / DPS only</span></label>
    <button type="button" className="tender-clear" onClick={clear}>Clear</button>
  </div>;
}

function LeadRow({lead, now, onOpen}) {
  const notice = lead.notice || {};
  const terms = matchedTerms(lead);
  return <tr className={lead.status === 'dismissed' ? 'dismissed' : ''} onClick={onOpen ? () => onOpen(lead) : undefined}>
    <td><b className={`tender-score ${lead.score >= 70 ? 'high' : lead.score >= 40 ? 'mid' : 'low'}`}>{lead.score}</b></td>
    <td className="tender-title-cell">
      <strong>{notice.title || 'Untitled notice'}</strong>
      {notice.notice_url && <a href={notice.notice_url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} aria-label={`Open notice on ${TENDER_SOURCE_LABELS[notice.source]}`}><ExternalLink size={13}/></a>}
    </td>
    <td>{notice.buyer_name || 'Unknown buyer'}</td>
    <td className="num">{formatTenderValue(notice.value_amount, notice.value_currency)}</td>
    <td>{formatDeadline(notice.tender_deadline, now)}{lead.urgent && <span className="tender-chip urgent">Closing soon</span>}</td>
    <td>{STAGE_LABELS[notice.stage] || 'Unknown'}{notice.is_framework_or_dps && <span className="tender-chip">Framework</span>}</td>
    <td>{TENDER_SOURCE_LABELS[notice.source] || notice.source}</td>
    <td className="tender-terms">{terms.length ? terms.map(term => <span key={term} className="tender-chip term">{term}</span>) : <span className="muted">None</span>}</td>
  </tr>;
}

const fmtDay = value => (value ? new Intl.DateTimeFormat('en-GB', {day: 'numeric', month: 'short', year: 'numeric'}).format(new Date(value)) : 'Not published');

function Field({label, children}) {
  return <div className="tender-field"><span>{label}</span><div>{children}</div></div>;
}

function TenderDrawer({lead, settings, now, canEdit, busy, act, close}) {
  const notice = lead.notice || {};
  const reasons = scoreReasons(lead.score_breakdown);
  const isAward = notice.stage === 'award' || notice.stage === 'contract';
  const dismiss = () => {
    const reason = window.prompt('Why dismiss this tender? (optional)', lead.dismiss_reason || '');
    if (reason !== null) act(lead, 'dismiss', {reason});
  };
  return <aside className="tender-drawer" aria-label="Tender detail">
    <div className="tender-drawer-head">
      <div><span className="tender-chip">{STAGE_LABELS[notice.stage] || 'Notice'}</span>{lead.urgent && <span className="tender-chip urgent">Closing soon</span>}</div>
      <button className="icon" onClick={close} aria-label="Close tender detail"><X size={17}/></button>
    </div>
    <h2>{notice.title || 'Untitled notice'}</h2>
    <p className="tender-buyer">{notice.buyer_name || 'Unknown buyer'}</p>
    {notice.notice_url && <a className="tender-source-link" href={notice.notice_url} target="_blank" rel="noreferrer"><ExternalLink size={14}/>View on {TENDER_SOURCE_LABELS[notice.source] || 'source'}</a>}

    <div className="tender-actions">
      <label><span>Status</span><select value={lead.status} disabled={!canEdit || busy} onChange={e => act(lead, 'status', {status: e.target.value})}>
        {LEAD_STATUSES.map(status => <option key={status} value={status}>{statusLabel(status, settings)}</option>)}
      </select></label>
      {lead.status === 'dismissed'
        ? <button disabled={!canEdit || busy} onClick={() => act(lead, 'restore')}><RotateCcw size={15}/>Restore</button>
        : <>
          <button disabled={!canEdit || busy || lead.status !== 'to_qualify'} onClick={() => act(lead, 'save')}><Bookmark size={15}/>Save</button>
          <button disabled={!canEdit || busy || lead.status === 'bidding'} onClick={() => act(lead, 'pursue')}><Rocket size={15}/>Pursue</button>
          <button disabled={!canEdit || busy} onClick={dismiss}><XCircle size={15}/>Dismiss</button>
        </>}
    </div>
    {!canEdit && <p className="muted">Viewers can read tenders but not change them.</p>}
    {lead.status === 'dismissed' && lead.dismiss_reason && <p className="tender-dismiss-reason">Dismissed: {lead.dismiss_reason}</p>}

    <section className="tender-why">
      <h3>Why this score: {lead.score}</h3>
      {reasons.length ? <ul>{reasons.map(reason => <li key={reason.label}>
        <span>{reason.label}{reason.matched.length ? `: ${reason.matched.join(', ')}` : ''}</span>
        <b>{reason.weight === null ? 'Score 0' : `${reason.weight > 0 ? '+' : ''}${reason.weight}`}</b>
      </li>)}</ul> : <p className="muted">Nothing in your settings matched this notice.</p>}
    </section>

    <section className="tender-fields">
      <Field label="Deadline">{formatDeadline(notice.tender_deadline, now)}</Field>
      <Field label="Value">{formatTenderValue(notice.value_amount, notice.value_currency)}</Field>
      <Field label="Notice status">{notice.tender_status || 'Not published'}</Field>
      <Field label="Contract">{notice.contract_start || notice.contract_end ? `${fmtDay(notice.contract_start)} to ${fmtDay(notice.contract_end)}` : 'Not published'}</Field>
      {isAward && <Field label="Winner">{(notice.award_suppliers || []).map(s => s.name).filter(Boolean).join(', ') || 'Not published'}</Field>}
      {isAward && <Field label="Contract ends">{fmtDay(notice.contract_end)}</Field>}
      <Field label="Framework / DPS">{notice.is_framework_or_dps ? 'Yes' : 'No'}</Field>
      <Field label="CPV codes">{(notice.cpv_codes || []).join(', ') || 'None'}</Field>
      <Field label="Regions">{(notice.regions || []).join(', ') || 'None'}</Field>
      <Field label="Postcodes">{(notice.postcodes || []).join(', ') || 'None'}</Field>
      <Field label="Published">{fmtDay(notice.published_at)}</Field>
      <Field label="Source">{TENDER_SOURCE_LABELS[notice.source] || notice.source}</Field>
    </section>
    {notice.description && <section className="tender-description"><h3>Description</h3><p>{notice.description}</p></section>}
    <small className="tender-ogl">{OGL_NOTICE}</small>
  </aside>;
}

export function TendersPage({cloudEnabled, tenant, session}) {
  const tenantId = tenant?.tenantId;
  const [data, setData] = useState({leads: [], settings: null, runs: []});
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [filters, setFilters] = useState(EMPTY_TENDER_FILTERS);
  const [now, setNow] = useState(() => Date.now());
  const [selectedOcid, setSelectedOcid] = useState(null), [busyOcid, setBusyOcid] = useState(null);
  const canEdit = canEditTenantData(tenant);

  const load = useCallback(() => {
    if (!cloudEnabled || !tenantId) return;
    setLoading(true);
    setError('');
    loadTenderPage(tenantId)
      .then(next => { setData(next); setNow(Date.now()); })
      .catch(err => setError(`Could not load tenders: ${err.message}`))
      .finally(() => setLoading(false));
  }, [cloudEnabled, tenantId]);
  useEffect(() => { setSelectedOcid(null); load(); }, [load]);

  // Optimistic, like updateOutreach: show the change now, roll back if the
  // update is rejected (including RLS silently matching no row).
  const act = async (lead, action, options) => {
    const changes = leadActionChanges(action, options);
    const before = {status: lead.status, dismiss_reason: lead.dismiss_reason};
    setData(current => ({...current, leads: applyLeadChanges(current.leads, lead.ocid, changes)}));
    setBusyOcid(lead.ocid);
    const {data: rows, error: updateError} = await supabase
      .from('tender_leads')
      .update({...changes, updated_by: session.user.id})
      .eq('tenant_id', tenantId)
      .eq('ocid', lead.ocid)
      .select('ocid');
    setBusyOcid(null);
    if (updateError || !rows?.length) {
      setData(current => ({...current, leads: applyLeadChanges(current.leads, lead.ocid, before)}));
      setError(`Could not update tender: ${updateError?.message || 'you do not have permission to change it'}`);
    }
  };

  const setFilter = (key, value) => setFilters(current => ({...current, [key]: value}));
  const minScoreToShow = data.settings?.min_score_to_show ?? 0;
  const health = useMemo(() => sourceHealth(data.runs, now), [data.runs, now]);
  const regions = useMemo(() => regionOptions(data.leads), [data.leads]);
  const {visible, hiddenBelowThreshold} = useMemo(
    () => filterLeads(data.leads, filters, {now, minScoreToShow}),
    [data.leads, filters, now, minScoreToShow],
  );

  const selectedLead = selectedOcid ? data.leads.find(lead => lead.ocid === selectedOcid) : null;

  if (!cloudEnabled) {
    return <section className="tenders-page"><div className="notice">Tenders need a signed-in Site Finder workspace.</div></section>;
  }
  if (!tenantId) return <section className="tenders-page"/>;

  return <section className="tenders-page">
    <div className="tenders-head">
      <div><Landmark size={18}/><strong>{visible.length.toLocaleString()} tenders</strong><button className="icon" onClick={load} disabled={loading} aria-label="Refresh tenders"><RefreshCw size={16}/></button></div>
    </div>
    <HealthBanner health={health}/>
    {error && <div className="notice" role="alert">{error}<button onClick={() => setError('')} aria-label="Dismiss message"><X size={15}/></button></div>}
    {!data.settings && !loading && <div className="notice">No tender settings for this workspace yet, so nothing is scored. A workspace admin can add keywords, CPV codes and regions.</div>}
    <TenderFilters filters={filters} setFilter={setFilter} regions={regions} clear={() => setFilters(EMPTY_TENDER_FILTERS)}/>
    <div className="tender-table-wrap">
      <table className="tender-table">
        <thead><tr><th>Score</th><th>Title</th><th>Buyer</th><th className="num">Value</th><th>Deadline</th><th>Stage</th><th>Source</th><th>Matched</th></tr></thead>
        <tbody>
          {visible.map(lead => <LeadRow key={lead.ocid} lead={lead} now={now} onOpen={next => setSelectedOcid(next.ocid)}/>)}
          {!visible.length && <tr><td colSpan="8" className="tender-empty">{loading ? 'Loading tenders…' : 'No tenders match these filters.'}</td></tr>}
        </tbody>
      </table>
    </div>
    <div className="tenders-foot">
      {hiddenBelowThreshold > 0 && <button type="button" onClick={() => setFilter('showBelowThreshold', true)}>Show {hiddenBelowThreshold} below score {minScoreToShow}</button>}
      {filters.showBelowThreshold && <button type="button" onClick={() => setFilter('showBelowThreshold', false)}>Hide leads below score {minScoreToShow}</button>}
      <small>{OGL_NOTICE}</small>
    </div>
    {selectedLead && <TenderDrawer lead={selectedLead} settings={data.settings} now={now} canEdit={canEdit} busy={busyOcid === selectedLead.ocid} act={act} close={() => setSelectedOcid(null)}/>}
  </section>;
}
