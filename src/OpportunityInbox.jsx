import React, {useEffect, useMemo, useState} from 'react';
import {
  ArrowRight,
  Building2,
  CalendarClock,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  History,
  Search,
  Sparkles,
} from 'lucide-react';
import {
  buildOpportunityItems,
  correctManualContactChanges,
  countOpportunityBuckets,
  isInOpportunityScope,
  manualContactChanges,
  markReviewedChanges,
  nextTriageChanges,
} from './opportunityState';
import './opportunity-inbox.css';

const PAGE_SIZE = 50;
const BUCKETS = [
  {id: 'new', label: 'New'},
  {id: 'unreviewed', label: 'Backlog'},
  {id: 'changed', label: 'Changed'},
  {id: 'research', label: 'Research'},
  {id: 'ready', label: 'Ready'},
  {id: 'needs_contact', label: 'Needs contact'},
  {id: 'contacted', label: 'Contacted'},
  {id: 'deferred', label: 'Deferred'},
  {id: 'not_fit', label: 'Not fit'},
  {id: 'all', label: 'All'},
];

const TRIAGE_OPTIONS = [
  {value: 'unreviewed', label: 'No team decision'},
  {value: 'research', label: 'Needs research'},
  {value: 'ready', label: 'Ready to contact'},
  {value: 'contacted', label: 'Contact recorded', disabled: true},
  {value: 'deferred', label: 'Defer 30 days'},
  {value: 'not_fit', label: 'Not a fit'},
];

const STATE_COPY = {
  new: ['New', 'Added after the SiteFinder baseline and not reviewed yet.'],
  unreviewed: ['Unreviewed backlog', 'A baseline project with no team decision yet.'],
  changed: ['Changed since review', 'CCS changed the record after its last review.'],
  research: ['Needs research', 'The team decided more company or contact research is needed.'],
  ready: ['Ready to contact', 'Research is complete and the opportunity is ready for outreach.'],
  needs_contact: ['Needs a decision', 'Reviewed, but no next workflow decision has been recorded.'],
  contacted: ['Contacted', 'Contact evidence or a historical manual contact is recorded.'],
  deferred: ['Deferred', 'Snoozed temporarily without losing the opportunity.'],
  not_fit: ['Not a fit', 'The team has deliberately excluded this opportunity.'],
};

const CONTACT_COPY = {
  replied: 'Replied',
  contacted: 'Contacted',
  attempted: 'Attempted',
  queued: 'Queued only',
  not_contacted: 'Not contacted',
};

const formatDate = value => value
  ? new Intl.DateTimeFormat('en-GB', {day: '2-digit', month: 'short', year: 'numeric'})
    .format(new Date(value))
  : 'Not recorded';

const projectSearchText = item => [
  item.project.Name,
  item.project.MainContractor,
  item.project.Client,
  item.project.LaId,
  item.project.Id,
  item.history.address,
].filter(Boolean).join(' ').toLowerCase();

function StatCard({label, value, tone, icon: Icon, onClick}) {
  return <button type="button" className={`opportunity-stat ${tone}`} onClick={onClick}>
    <span><Icon size={17}/>{label}</span>
    <strong>{typeof value === 'number' ? value.toLocaleString() : value}</strong>
  </button>;
}

export function OpportunityInbox({
  projects,
  history,
  tracking,
  outreachLeads,
  communications,
  enrichment,
  attioLinks,
  loading,
  evidenceError,
  actionError,
  onClearError,
  syncIsStale,
  lastSyncedAt,
  checkpointAt,
  lastRefreshedAt,
  onSetCheckpoint,
  onRefresh,
  onUpdateTracking,
  onOpenProject,
}) {
  const [bucket, setBucket] = useState('new');
  const [scope, setScope] = useState('all');
  const [query, setQuery] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(1);
  const [workingProjectIds, setWorkingProjectIds] = useState(() => new Set());
  const [checkpointWorking, setCheckpointWorking] = useState(false);
  const [refreshWorking, setRefreshWorking] = useState(false);
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const items = useMemo(() => buildOpportunityItems({
    projects,
    history,
    tracking,
    outreachLeads,
    communications,
    enrichment,
    attioLinks,
    now: clock,
  }), [
    projects,
    history,
    tracking,
    outreachLeads,
    communications,
    enrichment,
    attioLinks,
    clock,
  ]);
  const scopedItems = useMemo(() => includeInactive ? items : items.filter(item => (
    item.history.is_active !== false
    && item.history.site_closed !== true
  )), [includeInactive, items]);
  const eligibleItems = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return scopedItems.filter(item => (
      isInOpportunityScope(item, scope, {checkpointAt, now: clock})
      && (!needle || projectSearchText(item).includes(needle))
    ));
  }, [checkpointAt, clock, query, scope, scopedItems]);
  const counts = useMemo(() => countOpportunityBuckets(eligibleItems), [eligibleItems]);
  const visible = useMemo(() => eligibleItems.filter(item => (
    bucket === 'all' || item.inboxState === bucket
  )), [bucket, eligibleItems]);
  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const shown = visible.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  useEffect(() => setPage(1), [bucket, includeInactive, query, scope]);
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);
  const evidenceReady = !loading && !evidenceError;

  const updateProject = async (item, changes) => {
    setWorkingProjectIds(current => new Set(current).add(item.project.Id));
    try {
      await onUpdateTracking(item.project, changes);
    } finally {
      setWorkingProjectIds(current => {
        const next = new Set(current);
        next.delete(item.project.Id);
        return next;
      });
    }
  };
  const changeDecision = (item, status) => updateProject(
    item,
    nextTriageChanges(status, {current: item.tracking}),
  );
  const markManualContact = item => {
    const contactDate = window.prompt(
      `Date ${item.project.Name} was contacted outside SiteFinder (YYYY-MM-DD)`,
      '',
    );
    if (contactDate === null) return;
    const trimmedDate = contactDate.trim();
    const parsedDate = new Date(`${trimmedDate}T00:00:00Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(trimmedDate)
      || Number.isNaN(parsedDate.getTime())
      || parsedDate.toISOString().slice(0, 10) !== trimmedDate
    ) {
      window.alert('Enter a valid historical date in YYYY-MM-DD format.');
      return;
    }
    let changes;
    try {
      changes = manualContactChanges(
        item.tracking,
        parsedDate,
      );
    } catch {
      window.alert('Enter a valid historical date in YYYY-MM-DD format. Future dates are not allowed.');
      return;
    }
    if (!window.confirm(`Record ${trimmedDate} as the historical contact date for ${item.project.Name}? This creates an audited manual contact mark.`)) return;
    updateProject(item, changes);
  };
  const correctManualContact = item => {
    if (!window.confirm(`Correct the manual contact mark for ${item.project.Name}? Provider communication evidence will not be removed.`)) return;
    updateProject(item, correctManualContactChanges(item.tracking));
  };
  const setCheckpoint = async () => {
    setCheckpointWorking(true);
    await onSetCheckpoint();
    setCheckpointWorking(false);
  };
  const refresh = async () => {
    setRefreshWorking(true);
    await onRefresh();
    setRefreshWorking(false);
  };

  return <section className="opportunity-inbox">
    <div className="opportunity-heading">
      <div>
        <span>Opportunity workflow</span>
        <h1>Opportunity Inbox</h1>
        <p>See what is new, what changed, what needs research and what SiteFinder has recorded as contacted.</p>
      </div>
      <div className="checkpoint-card">
        <History size={18}/>
        <div>
          <b>Personal checkpoint</b>
          <small>{checkpointAt ? `Set ${formatDate(checkpointAt)}` : 'Not set yet'}</small>
        </div>
        <button type="button" disabled={checkpointWorking || loading || Boolean(evidenceError) || syncIsStale} onClick={setCheckpoint}>
          {checkpointWorking ? 'Saving…' : 'Set to now'}
        </button>
        <button type="button" disabled={refreshWorking || loading} onClick={refresh}>
          {refreshWorking ? 'Refreshing…' : 'Refresh'}
        </button>
        <small>{lastRefreshedAt ? `Evidence refreshed ${new Date(lastRefreshedAt).toLocaleTimeString('en-GB')}` : 'Evidence not refreshed yet'}</small>
      </div>
    </div>

    {actionError ? <div className="notice opportunity-action-error" role="alert">{actionError}<button type="button" onClick={onClearError}>×</button></div> : null}
    {syncIsStale ? <div className="notice sync-warning opportunity-sync-warning" role="alert">
      CCS data may be out of date. The last successful nightly sync was {lastSyncedAt ? new Date(lastSyncedAt).toLocaleString('en-GB') : 'not recorded'}. Checkpoint creation is disabled until the feed is current.
    </div> : null}

    <div className="opportunity-stats">
      <StatCard label="New" value={evidenceReady ? counts.new || 0 : '—'} tone="orange" icon={Sparkles} onClick={() => setBucket('new')}/>
      <StatCard label="Changed" value={evidenceReady ? counts.changed || 0 : '—'} tone="blue" icon={History} onClick={() => setBucket('changed')}/>
      <StatCard label="Ready" value={evidenceReady ? counts.ready || 0 : '—'} tone="green" icon={Check} onClick={() => setBucket('ready')}/>
      <StatCard label="Needs contact" value={evidenceReady ? counts.needs_contact || 0 : '—'} tone="navy" icon={CalendarClock} onClick={() => setBucket('needs_contact')}/>
    </div>

    <div className="opportunity-controls">
      <label className="opportunity-search">
        <Search size={17}/>
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="Search project, contractor, client or location…"
          aria-label="Search Opportunity Inbox"
        />
      </label>
      <label className="date-scope-filter">
        <span>Date scope</span>
        <select value={scope} onChange={event => setScope(event.target.value)}>
          <option value="all">All time</option>
          <option value="checkpoint">Since my checkpoint</option>
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
        </select>
      </label>
      <label className="archive-toggle">
        <input type="checkbox" checked={includeInactive} onChange={event => setIncludeInactive(event.target.checked)}/>
        <span>Include inactive / closed</span>
      </label>
    </div>

    <nav className="opportunity-buckets" aria-label="Opportunity Inbox folders">
      {BUCKETS.map(item => <button
        key={item.id}
        type="button"
        className={bucket === item.id ? 'active' : ''}
        aria-current={bucket === item.id ? 'page' : undefined}
        onClick={() => setBucket(item.id)}
      >
        {item.label}<span>{evidenceReady ? counts[item.id] || 0 : '—'}</span>
      </button>)}
    </nav>

    <div className="opportunity-results-heading">
      <div>
        <b>{BUCKETS.find(item => item.id === bucket)?.label}</b>
        <span>{evidenceReady ? `${visible.length.toLocaleString()} project${visible.length === 1 ? '' : 's'}` : 'Evidence loading…'}</span>
      </div>
      {scope === 'checkpoint' && !checkpointAt
        ? <small>No checkpoint exists yet, so this scope currently includes all activity.</small>
        : null}
    </div>

    <div className="opportunity-table-shell">
      <table className="opportunity-table">
        <thead><tr>
          <th>Project</th>
          <th>Why it is here</th>
          <th>Company / client</th>
          <th>SiteFinder contact</th>
          <th>Dates</th>
          <th>Decision</th>
          <th aria-label="Open project"/>
        </tr></thead>
        <tbody>
          {evidenceError
            ? <tr><td colSpan="7" className="opportunity-empty opportunity-evidence-error" role="alert">
              <b>Opportunity evidence is unavailable</b>
              <span>{evidenceError}</span>
              <span>No decisions are shown until all contact and project history has loaded safely.</span>
            </td></tr>
            : loading
            ? <tr><td colSpan="7" className="opportunity-empty">Loading the Opportunity Inbox…</td></tr>
            : visible.length === 0
              ? <tr><td colSpan="7" className="opportunity-empty">
                <Check size={24}/><b>This folder is clear</b>
                <span>Try another folder or date scope.</span>
              </td></tr>
              : shown.map(item => {
                const [stateLabel, stateReason] = STATE_COPY[item.inboxState];
                const busy = workingProjectIds.has(item.project.Id);
                const manualContact = Boolean(
                  item.tracking.contacted_source === 'manual_history'
                  && item.tracking.contacted_at
                );
                const stateReasonWithEvidence = item.inboxState === 'changed'
                  && item.history.last_changed_fields?.length
                  ? `Changed: ${item.history.last_changed_fields.join(', ')}.`
                  : stateReason;
                return <tr key={item.project.Id}>
                  <td>
                    <button type="button" className="opportunity-project" onClick={() => onOpenProject(item.project)}>
                      {item.project.Name}
                    </button>
                    {item.history.site_closed === true
                      ? <span className="inactive-project">Closed project</span>
                      : item.history.is_active === false
                        ? <span className="inactive-project">Inactive in latest CCS feed</span>
                        : null}
                    <small>CCS {item.project.Id.replace('site', '')} · {item.project.LaId || 'Location not published'}</small>
                  </td>
                  <td>
                    <span className={`inbox-state state-${item.inboxState}`}>{stateLabel}</span>
                    <small>{stateReasonWithEvidence}</small>
                  </td>
                  <td>
                    <b>{item.project.MainContractor || 'Contractor not published'}</b>
                    <small>{item.project.Client || 'Client not published'}</small>
                    {item.attioLink.attio_web_url
                      ? <>
                        <a href={item.attioLink.attio_web_url} target="_blank" rel="noreferrer">Open Attio <ExternalLink size={12}/></a>
                        {item.attioLink.sync_status === 'error'
                          ? <small className="attio-missing">Latest Attio refresh failed</small>
                          : null}
                      </>
                      : <small className="attio-missing">Attio link pending</small>}
                  </td>
                  <td>
                    <span className={`contact-state contact-${item.contact.state}`}>
                      {CONTACT_COPY[item.contact.state]}
                    </span>
                    <small>{item.contact.lastContactAt ? formatDate(item.contact.lastContactAt) : 'No sent evidence'}</small>
                  </td>
                  <td>
                    <span>First seen {formatDate(item.history.first_seen_at)}</span>
                    <small>Changed {formatDate(item.history.last_changed_at)}</small>
                  </td>
                  <td>
                    {['new', 'unreviewed', 'changed'].includes(item.inboxState)
                      ? <button
                        type="button"
                        className="review-button"
                        disabled={busy}
                        onClick={() => updateProject(item, markReviewedChanges(item.tracking))}
                      ><Check size={14}/> Mark reviewed</button>
                      : null}
                    {manualContact
                      ? <button type="button" className="manual-contact-button correction" disabled={busy} onClick={() => correctManualContact(item)}>Correct manual mark</button>
                      : !['contacted', 'replied'].includes(item.contact.state)
                        ? <button type="button" className="manual-contact-button" disabled={busy} onClick={() => markManualContact(item)}>Mark historical contact…</button>
                        : null}
                    {item.inboxState === 'needs_contact'
                      && item.tracking.triage_status === 'deferred'
                      ? <button type="button" className="manual-contact-button" disabled={busy} onClick={() => changeDecision(item, 'deferred')}>Defer another 30 days</button>
                      : null}
                    <select
                      aria-label={`Decision for ${item.project.Name}`}
                      value={item.tracking.triage_status || 'unreviewed'}
                      disabled={busy}
                      onChange={event => changeDecision(item, event.target.value)}
                    >
                      {TRIAGE_OPTIONS.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
                    </select>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="opportunity-open"
                      onClick={() => onOpenProject(item.project)}
                      aria-label={`Open ${item.project.Name}`}
                    ><ArrowRight size={17}/></button>
                  </td>
                </tr>;
              })}
        </tbody>
      </table>
    </div>

    {evidenceReady ? <div className="opportunity-pagination">
      <span>Showing {shown.length ? (page - 1) * PAGE_SIZE + 1 : 0}–{Math.min(page * PAGE_SIZE, visible.length)} of {visible.length.toLocaleString()}</span>
      <div>
        <button type="button" disabled={page === 1} onClick={() => setPage(value => value - 1)} aria-label="Previous Opportunity Inbox page"><ChevronLeft size={16}/></button>
        <b>Page {page} of {totalPages}</b>
        <button type="button" disabled={page === totalPages} onClick={() => setPage(value => value + 1)} aria-label="Next Opportunity Inbox page"><ChevronRight size={16}/></button>
      </div>
    </div> : null}

    <div className="opportunity-footnote">
      <Building2 size={15}/>
      Queued outreach is never counted as contacted. Attio and Pipedrive interaction history is not included in this first inbox slice, so confirm the CRM before starting outreach.
    </div>
  </section>;
}
