import React, {useEffect, useMemo, useState} from 'react';
import {
  Bot,
  Check,
  ChevronRight,
  CircleStop,
  ExternalLink,
  FileSearch,
  Globe2,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  SearchCheck,
  ShieldCheck,
  X,
} from 'lucide-react';
import {
  advancePreviewRun,
  createPreviewResearchRun,
  pendingReviewCount,
  requestStopAfterCurrent,
  researchEventSteps,
  reviewCandidate,
  setRunStatus,
} from './researchAgentState';
import './research-agent.css';

const taskStatus = {
  running: 'Researching',
  review: 'Ready for review',
  waiting: 'Waiting',
  completed: 'Completed',
  failed: 'Needs attention',
};

function runStatusLabel(status) {
  return {
    running: 'Research running',
    paused: 'Research paused',
    stopping: 'Stopping after current company',
    completed: 'Research completed',
  }[status] || 'Research status unknown';
}

function formatTime(value) {
  return new Intl.DateTimeFormat('en-GB', {hour: '2-digit', minute: '2-digit'}).format(new Date(value));
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

function BrowserPreview({task, runStatus}) {
  const visibleSteps = researchEventSteps.slice(0, Math.max(1, task.currentStep + 1));
  return <section className="research-pane research-live" aria-label="Live research activity">
    <div className="research-pane-heading">
      <div><span>Current task</span><h2>Live research view</h2></div>
      <b><Globe2 size={13}/> Official website</b>
    </div>
    <div className="research-browser">
      <div className="research-browser-bar">
        <span className="browser-dots" aria-hidden="true"><i/><i/><i/></span>
        <a href={task.currentUrl} target="_blank" rel="noreferrer">{task.currentUrl}<ExternalLink size={12}/></a>
      </div>
      <div className="research-page-preview">
        <div className="research-page-brand">
          <strong>{task.companyName}</strong>
          <span>About&nbsp;&nbsp; Projects&nbsp;&nbsp; People&nbsp;&nbsp; Contact</span>
        </div>
        <h3>{task.pageTitle}</h3>
        <p>The research agent is examining this approved public source and retaining the exact URL as evidence.</p>
        <div className="research-detection">
          <SearchCheck size={18}/>
          <div><b>Relevant role detected</b><span>Illustrative result · {task.currentRole}</span></div>
        </div>
      </div>
    </div>
    <div className="research-events" aria-live="polite">
      {visibleSteps.map((event, index) => <div className={`research-event ${index === visibleSteps.length - 1 ? 'current' : ''}`} key={event}>
        <span>{formatTime(Date.now() - (visibleSteps.length - index) * 7000)}</span>
        <i/>
        <p>{runStatus === 'paused' && index === visibleSteps.length - 1 ? 'Paused safely. The current task and page position are saved.' : event}</p>
      </div>)}
    </div>
  </section>;
}

function CandidateInspector({candidate, companyName, onReview}) {
  if (!candidate) return <section className="research-pane research-inspector" aria-label="Candidate inspector">
    <div className="research-pane-heading"><div><span>Evidence</span><h2>Candidate inspector</h2></div></div>
    <div className="research-empty"><FileSearch/><b>No candidate selected</b><p>Choose a company with discovered people to review its evidence.</p></div>
  </section>;
  const decided = candidate.reviewStatus !== 'pending';
  return <section className="research-pane research-inspector" aria-label="Candidate inspector">
    <div className="research-pane-heading">
      <div><span>Evidence</span><h2>Candidate inspector</h2></div>
      <b className="confidence-label">High confidence</b>
    </div>
    <div className="candidate-heading">
      <small>Illustrative candidate</small>
      <h3>{candidate.name}</h3>
      <p>{candidate.jobTitle}</p>
    </div>
    <dl className="candidate-facts">
      <div><dt>Company</dt><dd>{companyName}</dd></div>
      <div><dt>Source</dt><dd><a href={candidate.sourceUrl} target="_blank" rel="noreferrer">{candidate.sourceKind}<ExternalLink size={12}/></a></dd></div>
      <div><dt>Attio comparison</dt><dd>{candidate.crmComparison}</dd></div>
      <div><dt>Personal email</dt><dd>{candidate.emailStatus}</dd></div>
      <div><dt>Evidence</dt><dd>{candidate.evidence}</dd></div>
      <div><dt>Confidence</dt><dd className="confidence"><i><em style={{width: `${candidate.confidence * 100}%`}}/></i><b>{Math.round(candidate.confidence * 100)}%</b></dd></div>
    </dl>
    {decided
      ? <div className={`review-decision decision-${candidate.reviewStatus}`}><Check size={17}/><span>Marked {candidate.reviewStatus}. This preview has not changed Attio.</span><button type="button" onClick={() => onReview('investigate')}>Change decision</button></div>
      : <div className="candidate-actions">
        <button type="button" className="reject" onClick={() => onReview('rejected')}><X size={15}/> Reject</button>
        <button type="button" className="approve" onClick={() => onReview('approved')}><Check size={15}/> Approve for Attio queue</button>
      </div>}
    <p className="research-boundary"><ShieldCheck size={15}/> Approval creates a review decision only. It does not write to Attio or send an email.</p>
  </section>;
}

export function ResearchAgentPage() {
  const [run, setRun] = useState(createPreviewResearchRun);
  const [selectedTaskId, setSelectedTaskId] = useState(run.tasks[0].id);
  const selectedTask = useMemo(() => run.tasks.find(task => task.id === selectedTaskId) || run.tasks[0], [run.tasks, selectedTaskId]);
  const candidate = run.candidates.find(item => item.taskId === selectedTask.id) || null;
  const reviewCount = pendingReviewCount(run);

  useEffect(() => {
    if (run.mode !== 'preview' || run.status !== 'running') return undefined;
    const timer = window.setInterval(() => setRun(current => advancePreviewRun(current)), 4500);
    return () => window.clearInterval(timer);
  }, [run.mode, run.status]);

  const togglePause = () => setRun(current => setRunStatus(current, current.status === 'paused' ? 'running' : 'paused'));
  const reset = () => {
    const next = createPreviewResearchRun();
    setRun(next);
    setSelectedTaskId(next.tasks[0].id);
  };
  const decide = decision => {
    if (!candidate) return;
    setRun(current => reviewCandidate(current, candidate.id, decision));
  };

  return <div className="research-agent-page">
    <section className="research-command">
      <div className="research-run-title">
        <span className={`research-live-dot status-${run.status}`}/>
        <div>
          <div><strong>{runStatusLabel(run.status)} · {run.name}</strong><span className="preview-label">Preview mode</span></div>
          <p>Started {formatTime(run.startedAt)} · stops after {run.companyLimit} companies · no automatic Attio changes</p>
        </div>
      </div>
      <div className="research-command-actions">
        <button type="button" onClick={togglePause} disabled={run.status === 'stopping' || run.status === 'completed'}>
          {run.status === 'paused' ? <Play size={15}/> : <Pause size={15}/>}
          {run.status === 'paused' ? 'Resume' : 'Pause'}
        </button>
        <button type="button" onClick={() => setRun(current => requestStopAfterCurrent(current))} disabled={run.stopAfterCurrent || run.status === 'completed'}>
          <CircleStop size={15}/> {run.stopAfterCurrent ? 'Stop requested' : 'Stop after current company'}
        </button>
        <button type="button" className="primary" onClick={reset}><RotateCcw size={15}/> New preview run</button>
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
      <BrowserPreview task={selectedTask} runStatus={run.status}/>
      <CandidateInspector candidate={candidate} companyName={selectedTask.companyName} onReview={decide}/>
    </div>
    <div className="research-preview-notice"><Bot size={15}/><span>This working page uses illustrative activity while the live research runner is connected. All controls are safely contained in preview mode.</span><button type="button" onClick={reset}><RefreshCw size={14}/> Reset preview</button></div>
  </div>;
}
