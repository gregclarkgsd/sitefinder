import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleStop,
  ExternalLink,
  FileSearch,
  Globe2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  SearchCheck,
  ShieldCheck,
  X,
} from 'lucide-react';
import {
  advancePreviewRun,
  createPreviewResearchRun,
  pendingReviewCount,
  primaryRunControl,
  researchCandidateApprovalBlockReason,
  researchCrmComparisonLabel,
  requestStopAfterCurrent,
  researchEventSteps,
  reviewCandidate,
  setRunStatus,
} from './researchAgentState';
import {
  loadLatestResearchRun,
  createResearchRun,
  subscribeToResearchRun,
  updateResearchCandidateReview,
  updateResearchRunStatus,
} from './researchAgentData';
import {
  buildResearchCompanyOptions,
  createQueuedPreviewRun,
} from './researchRunPlan';
import {supabase} from './supabase';
import {apiFetch} from './api';
import './research-agent.css';

const taskStatus = {
  running: 'Researching',
  review: 'Ready for review',
  waiting: 'Waiting',
  completed: 'Completed',
  failed: 'Needs attention',
  skipped: 'Skipped',
};
const emptyTask = {
  id: 'no-research-task',
  companyName: 'No company selected',
  domain: '',
  status: 'waiting',
  progress: 0,
  pageCount: 0,
  contactsFound: 0,
  pageTitle: 'Waiting for the research runner',
  currentUrl: '',
  currentRole: '',
  currentStep: 0,
};

const domainPattern = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u;

function defaultRunName() {
  return `Contractor research · ${new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
  }).format(new Date())}`;
}

function ResearchRunLauncher({
  companies,
  onClose,
  onQueue,
  working,
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState([]);
  const [details, setDetails] = useState({});
  const [name, setName] = useState(defaultRunName);
  const [sources, setSources] = useState({
    website: true,
    apollo: true,
    companiesHouse: false,
    procurement: false,
  });
  const [apolloMaxPeople, setApolloMaxPeople] = useState(5);
  const [procurementDays, setProcurementDays] = useState(30);
  const [error, setError] = useState('');
  const visibleCompanies = companies
    .filter(company => company.name.toLowerCase().includes(query.trim().toLowerCase()))
    .slice(0, 80);

  const toggleCompany = company => {
    setSelected(current => current.includes(company.id)
      ? current.filter(id => id !== company.id)
      : [...current, company.id]);
    setDetails(current => current[company.id]
      ? current
      : {
          ...current,
          [company.id]: {
            domain: company.domain,
            apolloSearchDomain: company.apolloSearchDomain,
          },
        });
  };
  const updateCompany = (companyId, field, value) => {
    setDetails(current => ({
      ...current,
      [companyId]: {...current[companyId], [field]: value.toLowerCase().trim()},
    }));
  };
  const submit = async event => {
    event.preventDefault();
    const chosen = selected
      .map(id => companies.find(company => company.id === id))
      .filter(Boolean);
    if (chosen.length === 0) {
      setError('Choose at least one company.');
      return;
    }
    const companyRows = chosen.map(company => ({
      companyId: company.id,
      companyName: company.name,
      domain: details[company.id]?.domain || '',
      ...(sources.apollo && details[company.id]?.apolloSearchDomain
        ? {apolloSearchDomain: details[company.id].apolloSearchDomain}
        : {}),
    }));
    if (companyRows.some(company => !domainPattern.test(company.domain))) {
      setError('Enter each official company domain without https:// or a page path.');
      return;
    }
    if (
      companyRows.some(
        company =>
          company.apolloSearchDomain &&
          !domainPattern.test(company.apolloSearchDomain),
      )
    ) {
      setError('Apollo search hostnames must be domains without paths.');
      return;
    }
    setError('');
    try {
      await onQueue({
        name: name.trim(),
        companies: companyRows,
        sources,
        apolloMaxPeople: Number(apolloMaxPeople),
        procurementDays: sources.procurement ? Number(procurementDays) : 0,
      });
    } catch (queueError) {
      setError(
        queueError instanceof Error
          ? queueError.message
          : 'The research request could not be queued.',
      );
    }
  };

  return <div className="research-launcher-backdrop" role="presentation">
    <section className="research-launcher" role="dialog" aria-modal="true" aria-labelledby="research-launcher-title">
      <header>
        <div><span>New run</span><h2 id="research-launcher-title">Choose companies to research</h2><p>Create a reviewed queue for the local, read-only worker.</p></div>
        <button type="button" onClick={onClose} aria-label="Close research launcher"><X size={18}/></button>
      </header>
      <form onSubmit={submit}>
        <label className="research-launcher-name">
          <span>Run name</span>
          <input value={name} onChange={event => setName(event.target.value)} maxLength="120" required/>
        </label>
        <div className="research-launcher-grid">
          <section className="research-company-picker">
            <div className="research-launcher-section-title"><div><span>1</span><b>Select contractors</b></div><small>{selected.length} selected</small></div>
            <label className="research-company-search"><Search size={15}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search contractors…" aria-label="Search contractors"/></label>
            <div className="research-company-options">
              {visibleCompanies.length === 0 && <p>No contractors match this search.</p>}
              {visibleCompanies.map(company => <label key={company.id}>
                <input type="checkbox" checked={selected.includes(company.id)} onChange={() => toggleCompany(company)}/>
                <span>
                  <b>{company.name}</b>
                  <small>{company.projectCount} active project{company.projectCount === 1 ? '' : 's'}{company.projectNames.length ? ` · ${company.projectNames.join(' · ')}` : ''}</small>
                </span>
              </label>)}
            </div>
          </section>
          <section className="research-selected-companies">
            <div className="research-launcher-section-title"><div><span>2</span><b>Confirm company domains</b></div><small>Required</small></div>
            {selected.length === 0 && <div className="research-launcher-empty">Selected companies will appear here.</div>}
            {selected.map(id => {
              const company = companies.find(item => item.id === id);
              if (!company) return null;
              return <article key={id}>
                <div><b>{company.name}</b><button type="button" onClick={() => toggleCompany(company)} aria-label={`Remove ${company.name}`}><X size={13}/></button></div>
                <label><span>Official website domain</span><input value={details[id]?.domain || ''} onChange={event => updateCompany(id, 'domain', event.target.value)} placeholder="company.co.uk" required/></label>
                {sources.apollo && <label><span>Apollo search hostname <small>optional</small></span><input value={details[id]?.apolloSearchDomain || ''} onChange={event => updateCompany(id, 'apolloSearchDomain', event.target.value)} placeholder="people.company.com"/></label>}
              </article>;
            })}
          </section>
        </div>
        <section className="research-source-settings">
          <div className="research-launcher-section-title"><div><span>3</span><b>Choose research sources</b></div><small>Website always on</small></div>
          <div className="research-source-options">
            <label><input type="checkbox" checked disabled/><span><b>Official website</b><small>Public pages and PDFs</small></span></label>
            <label><input type="checkbox" checked={sources.apollo} onChange={event => setSources(current => ({...current, apollo: event.target.checked}))}/><span><b>Apollo</b><small>Licensed business data</small></span></label>
            <label><input type="checkbox" checked={sources.companiesHouse} onChange={event => setSources(current => ({...current, companiesHouse: event.target.checked}))}/><span><b>Companies House</b><small>Legal company facts</small></span></label>
            <label><input type="checkbox" checked={sources.procurement} onChange={event => setSources(current => ({...current, procurement: event.target.checked}))}/><span><b>Procurement</b><small>Recent public notices</small></span></label>
          </div>
          <div className="research-run-limits">
            <label><span>Apollo people per company</span><input type="number" min="1" max="25" value={apolloMaxPeople} onChange={event => setApolloMaxPeople(event.target.value)}/></label>
            {sources.procurement && <label><span>Procurement lookback days</span><input type="number" min="1" max="365" value={procurementDays} onChange={event => setProcurementDays(event.target.value)}/></label>}
          </div>
        </section>
        {error && <p className="research-launcher-error" role="alert">{error}</p>}
        <footer>
          <p><ShieldCheck size={15}/> This queues a read-only request. The browser never receives the Apollo key and nothing is written to Attio.</p>
          <div><button type="button" onClick={onClose}>Cancel</button><button type="submit" className="primary" disabled={working || selected.length === 0}><Play size={15}/> {working ? 'Queuing…' : selected.length ? `Queue ${selected.length} compan${selected.length === 1 ? 'y' : 'ies'}` : 'Queue research run'}</button></div>
        </footer>
      </form>
    </section>
  </div>;
}

function runStatusLabel(status) {
  return {
    running: 'Research running',
    paused: 'Research paused',
    stopping: 'Stopping after current company',
    completed: 'Research completed',
    queued: 'Research queued',
    failed: 'Research needs attention',
    cancelled: 'Research cancelled',
  }[status] || 'Research status unknown';
}

function formatTime(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-GB', {hour: '2-digit', minute: '2-digit'}).format(new Date(value));
}

function emailStatusLabel(value) {
  return {
    public_email_found: 'Public work email found',
    licensed_business_email_found: 'Licensed business email found',
    not_publicly_found: 'No public work email found',
  }[value] || value || 'Not checked';
}

function CompanyQueue({tasks, selectedTaskId, onSelect}) {
  return <section className="research-pane research-queue" aria-label="Company research queue">
    <div className="research-pane-heading">
      <div><span>Tasks</span><h2>Company queue</h2></div>
      <b>{tasks.filter(task => task.status === 'waiting').length} waiting</b>
    </div>
    <div className="research-task-list">
      {tasks.map(task => <button
        type="button"
        className={`research-task ${selectedTaskId === task.id ? 'selected' : ''}`}
        key={task.id}
        onClick={() => onSelect(task.id)}
      >
        <span className="research-task-top">
          <strong>{task.companyName}</strong>
          <small>{task.status === 'running' ? `${task.progress}/${task.pageCount}` : task.contactsFound ? `${task.contactsFound} found` : task.status === 'waiting' ? 'Queued' : task.progress}</small>
        </span>
        <span className={`research-task-status status-${task.status}`}><i/>{taskStatus[task.status] || task.status}</span>
      </button>)}
    </div>
  </section>;
}

function BrowserPreview({task, runStatus, events = [], preview = false}) {
  const liveEvents = events.filter(event => event.taskId === task.id).slice(-6);
  const previewEvents = researchEventSteps
    .slice(0, Math.max(1, (task.currentStep || 0) + 1))
    .map((message, index, rows) => ({
      id: message,
      message,
      createdAt: Date.now() - (rows.length - index) * 7000,
    }));
  const visibleEvents = liveEvents.length
    ? liveEvents
    : preview && runStatus !== 'queued'
      ? previewEvents
      : [];
  return <section className="research-pane research-live" aria-label="Live research activity">
    <div className="research-pane-heading">
      <div><span>Current task</span><h2>Live research view</h2></div>
      <b><Globe2 size={13}/> Official website</b>
    </div>
    <div className="research-browser">
      <div className="research-browser-bar">
        <span className="browser-dots" aria-hidden="true"><i/><i/><i/></span>
        {task.currentUrl
          ? <a href={task.currentUrl} target="_blank" rel="noreferrer">{task.currentUrl}<ExternalLink size={12}/></a>
          : <span className="research-address-empty">No public page open</span>}
      </div>
      <div className="research-page-preview">
        <div className="research-page-brand">
          <strong>{task.companyName}</strong>
          <span>About&nbsp;&nbsp; Projects&nbsp;&nbsp; People&nbsp;&nbsp; Contact</span>
        </div>
        <h3>{task.pageTitle}</h3>
        <p>{task.currentUrl
          ? 'The research agent is examining this approved public source and retaining the exact URL as evidence.'
          : 'The runner has not saved a public page for this task yet.'}</p>
        {task.currentRole
          ? <div className="research-detection">
              <SearchCheck size={18}/>
              <div><b>Relevant role detected</b><span>{preview ? 'Illustrative result' : 'Live saved result'} · {task.currentRole}</span></div>
            </div>
          : <div className="research-detection neutral">
              <FileSearch size={18}/>
              <div><b>No saved role yet</b><span>Waiting for evidence from an approved public source</span></div>
            </div>}
      </div>
    </div>
    <div className="research-events" aria-live="polite">
      {visibleEvents.length === 0 && <div className="research-event-empty">No saved activity for this task yet.</div>}
      {visibleEvents.map((event, index) => <div className={`research-event ${index === visibleEvents.length - 1 ? 'current' : ''}`} key={event.id}>
        <span>{formatTime(event.createdAt)}</span>
        <i/>
        <p>{runStatus === 'paused' && index === visibleEvents.length - 1 ? 'Paused safely. The current task and page position are saved.' : event.message}</p>
      </div>)}
    </div>
  </section>;
}

function CandidateInspector({
  candidate,
  candidates,
  companyName,
  onReview,
  onSelectCandidate,
  preview = false,
}) {
  if (!candidate) return <section className="research-pane research-inspector" aria-label="Candidate inspector">
    <div className="research-pane-heading"><div><span>Evidence</span><h2>Candidate inspector</h2></div></div>
    <div className="research-empty"><FileSearch/><b>No candidate selected</b><p>Choose a company with discovered people to review its evidence.</p></div>
  </section>;
  const decided = candidate.reviewStatus !== 'pending';
  const candidateIndex = candidates.findIndex(item => item.id === candidate.id);
  const confidenceLabel = candidate.confidence >= 0.85
    ? 'High confidence'
    : candidate.confidence >= 0.65
      ? 'Medium confidence'
      : 'Low confidence';
  const approvalBlockReason = researchCandidateApprovalBlockReason(candidate);
  const approvalBlocked = approvalBlockReason !== '';
  const selectCandidate = offset => {
    const next = (candidateIndex + offset + candidates.length) % candidates.length;
    onSelectCandidate(candidates[next].id);
  };
  return <section className="research-pane research-inspector" aria-label="Candidate inspector">
    <div className="research-pane-heading">
      <div><span>Evidence</span><h2>Candidate inspector</h2></div>
      <b className="confidence-label">{confidenceLabel}</b>
    </div>
    {candidates.length > 1 && <div className="candidate-switcher">
      <button type="button" onClick={() => selectCandidate(-1)} aria-label="Previous candidate"><ChevronLeft size={14}/></button>
      <label>
        <span>Candidate {candidateIndex + 1} of {candidates.length}</span>
        <select value={candidate.id} onChange={event => onSelectCandidate(event.target.value)}>
          {candidates.map(item => <option value={item.id} key={item.id}>{item.name} · {item.jobTitle}</option>)}
        </select>
      </label>
      <button type="button" onClick={() => selectCandidate(1)} aria-label="Next candidate"><ChevronRight size={14}/></button>
    </div>}
    <div className="candidate-heading">
      <small>{preview ? 'Illustrative candidate' : 'Saved research candidate'}</small>
      <h3>{candidate.name}</h3>
      <p>{candidate.jobTitle}</p>
    </div>
    <dl className="candidate-facts">
      <div><dt>Company</dt><dd>{companyName}</dd></div>
      <div><dt>Source</dt><dd><a href={candidate.sourceUrl} target="_blank" rel="noreferrer">{candidate.sourceKind}<ExternalLink size={12}/></a></dd></div>
      <div><dt>CRM comparison</dt><dd>{researchCrmComparisonLabel(candidate.crmComparison)}</dd></div>
      <div><dt>Email evidence</dt><dd>{emailStatusLabel(candidate.emailStatus)}</dd></div>
      <div><dt>Evidence</dt><dd>{candidate.evidence}</dd></div>
      <div><dt>Confidence</dt><dd className="confidence"><i><em style={{width: `${candidate.confidence * 100}%`}}/></i><b>{Math.round(candidate.confidence * 100)}%</b></dd></div>
    </dl>
    {decided && <div className={`review-decision decision-${candidate.reviewStatus}`}><Check size={17}/><span>Marked {candidate.reviewStatus}. This decision has not changed Attio.</span></div>}
    <div className="candidate-actions">
      <button type="button" className={`reject ${candidate.reviewStatus === 'rejected' ? 'selected' : ''}`} onClick={() => onReview('rejected')}><X size={15}/> Reject</button>
      <button type="button" className={`investigate ${candidate.reviewStatus === 'investigate' ? 'selected' : ''}`} onClick={() => onReview('investigate')}><SearchCheck size={15}/> Investigate</button>
      <button
        type="button"
        className={`approve ${candidate.reviewStatus === 'approved' ? 'selected' : ''}`}
        onClick={() => onReview('approved')}
        disabled={approvalBlocked}
        title={approvalBlocked ? approvalBlockReason : 'Approve this discovery for a later governed handoff'}
      ><Check size={15}/> Approve</button>
    </div>
    <p className="research-boundary"><ShieldCheck size={15}/> Approval creates a review decision only. It does not write to Attio or send an email.</p>
  </section>;
}

export function ResearchAgentPage({cloudEnabled = false, session = null, projects = []}) {
  const [run, setRun] = useState(createPreviewResearchRun);
  const [selectedTaskId, setSelectedTaskId] = useState(run.tasks[0].id);
  const [dataState, setDataState] = useState('preview');
  const [dataError, setDataError] = useState('');
  const [working, setWorking] = useState(false);
  const [selectedCandidateId, setSelectedCandidateId] = useState('');
  const [launcherOpen, setLauncherOpen] = useState(false);
  const selectedTask = useMemo(() => run.tasks.find(task => task.id === selectedTaskId) || run.tasks[0] || emptyTask, [run.tasks, selectedTaskId]);
  const taskCandidates = useMemo(() => run.candidates.filter(item => item.taskId === selectedTask.id), [run.candidates, selectedTask.id]);
  const candidate = taskCandidates.find(item => item.id === selectedCandidateId) || taskCandidates[0] || null;
  const reviewCount = pendingReviewCount(run);
  const primaryControl = primaryRunControl(run.status);
  const waitingForWorker = run.status === 'queued';
  const companyOptions = useMemo(
    () => buildResearchCompanyOptions(projects, run.tasks),
    [projects, run.tasks],
  );

  useEffect(() => {
    setSelectedCandidateId(current => taskCandidates.some(item => item.id === current)
      ? current
      : taskCandidates[0]?.id || '');
  }, [taskCandidates]);

  const loadSavedRun = useCallback(async () => {
    if (!cloudEnabled || !supabase) return null;
    try {
      const savedRun = await loadLatestResearchRun(supabase);
      if (!savedRun) {
        setDataState('preview');
        setDataError('');
        return null;
      }
      setRun(savedRun);
      setSelectedTaskId(current => savedRun.tasks.some(task => task.id === current) ? current : savedRun.tasks[0]?.id || '');
      setDataState('live');
      setDataError('');
      return savedRun;
    } catch (error) {
      setDataState('preview');
      setDataError(error instanceof Error ? error.message : 'Saved research runs are unavailable.');
      return null;
    }
  }, [cloudEnabled]);

  useEffect(() => {
    loadSavedRun();
  }, [loadSavedRun]);

  useEffect(() => {
    if (dataState !== 'live' || !supabase || !run.id) return undefined;
    return subscribeToResearchRun(supabase, run.id, loadSavedRun);
  }, [dataState, loadSavedRun, run.id]);

  useEffect(() => {
    if (run.mode !== 'preview' || run.status !== 'running') return undefined;
    const timer = window.setInterval(() => setRun(current => advancePreviewRun(current)), 4500);
    return () => window.clearInterval(timer);
  }, [run.mode, run.status]);

  const changeRunStatus = async status => {
    if (dataState !== 'live') {
      setRun(current => setRunStatus(current, status));
      return;
    }
    if (!session?.user?.id || !supabase) return;
    setWorking(true);
    try {
      await updateResearchRunStatus(apiFetch, run.id, status);
      setRun(current => ({...current, status}));
      setDataError('');
    } catch (error) {
      setDataError(error instanceof Error ? error.message : 'The run status could not be updated.');
    } finally {
      setWorking(false);
    }
  };
  const togglePause = () => {
    if (primaryControl) changeRunStatus(primaryControl.status);
  };
  const stopAfterCurrent = async () => {
    if (dataState !== 'live') {
      setRun(current => requestStopAfterCurrent(current));
      return;
    }
    await changeRunStatus('stopping');
  };
  const reset = () => {
    if (dataState === 'live') {
      loadSavedRun();
      return;
    }
    const next = createPreviewResearchRun();
    setRun(next);
    setSelectedTaskId(next.tasks[0].id);
  };
  const decide = async decision => {
    if (!candidate) return;
    if (dataState !== 'live') {
      setRun(current => reviewCandidate(current, candidate.id, decision));
      return;
    }
    if (!session?.user?.id || !supabase) return;
    setWorking(true);
    try {
      await updateResearchCandidateReview(apiFetch, candidate.id, decision);
      setRun(current => reviewCandidate(current, candidate.id, decision));
      setDataError('');
    } catch (error) {
      setDataError(error instanceof Error ? error.message : 'The candidate decision could not be saved.');
    } finally {
      setWorking(false);
    }
  };
  const queueRun = async request => {
    setWorking(true);
    try {
      if (cloudEnabled && session?.user?.id) {
        const created = await createResearchRun(apiFetch, request);
        const savedRun = await loadSavedRun();
        if (!savedRun || savedRun.id !== created.runId) {
          throw new Error('The queued run was saved but could not be reloaded.');
        }
      } else {
        const queued = createQueuedPreviewRun(request);
        setRun(queued);
        setSelectedTaskId(queued.tasks[0]?.id || '');
        setDataState('preview');
      }
      setDataError('');
      setLauncherOpen(false);
    } catch (error) {
      setDataError(error instanceof Error ? error.message : 'The research request could not be queued.');
      throw error;
    } finally {
      setWorking(false);
    }
  };

  return <div className="research-agent-page">
    {launcherOpen && <ResearchRunLauncher companies={companyOptions} onClose={() => setLauncherOpen(false)} onQueue={queueRun} working={working}/>}
    <section className="research-command">
      <div className="research-run-title">
        <span className={`research-live-dot status-${run.status}`}/>
        <div>
          <div><strong>{runStatusLabel(run.status)} · {run.name}</strong><span className={`preview-label ${dataState === 'live' ? 'live' : ''}`}>{dataState === 'live' ? 'Live read-only' : 'Preview mode'}</span></div>
          <p>Started {formatTime(run.startedAt)} · stops after {run.companyLimit} {run.companyLimit === 1 ? 'company' : 'companies'} · no automatic Attio changes</p>
        </div>
      </div>
      <div className="research-command-actions">
        <button type="button" onClick={togglePause} disabled={working || waitingForWorker || !primaryControl}>
          {waitingForWorker
            ? <Bot size={15}/>
            : primaryControl?.status === 'running'
              ? <Play size={15}/>
              : <Pause size={15}/>}
          {waitingForWorker ? 'Waiting for worker' : primaryControl?.label || 'No run control'}
        </button>
        <button type="button" onClick={stopAfterCurrent} disabled={working || waitingForWorker || run.stopAfterCurrent || run.status === 'stopping' || run.status === 'completed'}>
          <CircleStop size={15}/> {run.stopAfterCurrent || run.status === 'stopping' ? 'Stop requested' : 'Stop after current company'}
        </button>
        <button type="button" className="primary" onClick={() => setLauncherOpen(true)} disabled={working || companyOptions.length === 0}><Plus size={15}/> New research run</button>
      </div>
    </section>

    <section className="research-metrics" aria-label="Research run summary">
      <div><span>Companies checked</span><strong>{run.companiesChecked} / {run.companyLimit}</strong></div>
      <div><span>Pages inspected</span><strong>{run.pagesInspected}</strong></div>
      <div><span>People found</span><strong>{run.peopleFound}</strong></div>
      <div><span>Waiting for review</span><strong>{reviewCount}</strong></div>
    </section>

    <div className="research-workspace">
      <CompanyQueue tasks={run.tasks} selectedTaskId={selectedTask.id} onSelect={setSelectedTaskId}/>
      <BrowserPreview task={selectedTask} runStatus={run.status} events={run.events} preview={dataState !== 'live'}/>
      <CandidateInspector
        candidate={candidate}
        candidates={taskCandidates}
        companyName={selectedTask.companyName}
        onReview={decide}
        onSelectCandidate={setSelectedCandidateId}
        preview={dataState !== 'live'}
      />
    </div>
    <div className={`research-preview-notice ${dataState === 'live' ? 'live' : ''}`}><Bot size={15}/><span>{run.status === 'queued' ? 'This run is queued and waiting for the approved local worker on this laptop.' : dataState === 'live' ? 'Showing the latest saved read-only run. Task, event and candidate changes update automatically.' : 'This working page uses illustrative activity while the live research runner is connected. All controls are safely contained in preview mode.'}{dataError ? ` Live data note: ${dataError}` : ''}</span><button type="button" onClick={reset}><RefreshCw size={14}/> {dataState === 'live' ? 'Refresh' : 'Reset preview'}</button></div>
  </div>;
}
