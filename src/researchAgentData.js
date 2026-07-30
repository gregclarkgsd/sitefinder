const runColumns = 'id,name,mode,source,status,company_limit,companies_checked,pages_inspected,people_found,started_at,completed_at,created_at,updated_at';
const taskColumns = 'id,run_id,company_id,company_name,domain,status,progress,page_count,contacts_found,current_url,page_title,current_role,last_error,started_at,completed_at,created_at,updated_at';
const eventColumns = 'id,run_id,task_id,sequence,event_type,message,source_url,created_at';
const candidateColumns = 'id,run_id,task_id,external_candidate_id,company_id,name,job_title,role_category,source_kind,source_url,evidence_excerpt,crm_comparison,email_status,confidence,review_status,reviewed_at,created_at,updated_at';

export function buildResearchRun({run, tasks = [], events = [], candidates = []}) {
  if (!run) return null;
  return {
    id: run.id,
    name: run.name,
    mode: run.mode,
    source: run.source,
    status: run.status,
    startedAt: run.started_at || run.created_at,
    completedAt: run.completed_at,
    companyLimit: run.company_limit,
    companiesChecked: run.companies_checked,
    pagesInspected: run.pages_inspected,
    peopleFound: run.people_found,
    tasks: tasks.map(task => ({
      id: task.id,
      companyId: task.company_id,
      companyName: task.company_name,
      domain: task.domain,
      status: task.status,
      progress: task.progress,
      pageCount: task.page_count,
      contactsFound: task.contacts_found,
      currentUrl: task.current_url || null,
      pageTitle: task.page_title || (task.current_url ? 'Approved public source' : 'Waiting for saved page activity'),
      currentRole: task.current_role || null,
      lastError: task.last_error,
      startedAt: task.started_at,
      completedAt: task.completed_at,
    })),
    events: events.map(event => ({
      id: event.id,
      taskId: event.task_id,
      sequence: event.sequence,
      eventType: event.event_type,
      message: event.message,
      sourceUrl: event.source_url,
      createdAt: event.created_at,
    })),
    candidates: candidates.map(candidate => ({
      id: candidate.id,
      taskId: candidate.task_id,
      externalCandidateId: candidate.external_candidate_id,
      companyId: candidate.company_id,
      name: candidate.name,
      jobTitle: candidate.job_title,
      roleCategory: candidate.role_category,
      sourceKind: candidate.source_kind,
      sourceUrl: candidate.source_url,
      evidence: candidate.evidence_excerpt || 'Source retained for human review.',
      crmComparison: candidate.crm_comparison,
      emailStatus: candidate.email_status,
      confidence: Number(candidate.confidence),
      reviewStatus: candidate.review_status,
      reviewedAt: candidate.reviewed_at,
    })),
  };
}

export async function loadLatestResearchRun(client) {
  const {data: run, error: runError} = await client
    .from('research_runs')
    .select(runColumns)
    .order('created_at', {ascending: false})
    .limit(1)
    .maybeSingle();
  if (runError) throw runError;
  if (!run) return null;

  const [taskResult, eventResult, candidateResult] = await Promise.all([
    client.from('research_tasks').select(taskColumns).eq('run_id', run.id).order('created_at'),
    client.from('research_events').select(eventColumns).eq('run_id', run.id).order('sequence'),
    client.from('research_candidates').select(candidateColumns).eq('run_id', run.id).order('confidence', {ascending: false}),
  ]);
  const error = taskResult.error || eventResult.error || candidateResult.error;
  if (error) throw error;
  return buildResearchRun({
    run,
    tasks: taskResult.data || [],
    events: eventResult.data || [],
    candidates: candidateResult.data || [],
  });
}

async function sendResearchAction(request, path, body) {
  const response = await request(path, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body),
  });
  if (response.ok) return response.json();
  const payload = await response.json().catch(() => ({}));
  throw new Error(payload.error || `Research Agent action failed with HTTP ${response.status}`);
}

export function updateResearchRunStatus(request, runId, status) {
  return sendResearchAction(
    request,
    `/api/research/runs/${encodeURIComponent(runId)}/control`,
    {status},
  );
}

export function createResearchRun(request, input) {
  return sendResearchAction(request, '/api/research/runs', input);
}

export function updateResearchCandidateReview(request, candidateId, decision) {
  return sendResearchAction(
    request,
    `/api/research/candidates/${encodeURIComponent(candidateId)}/review`,
    {decision},
  );
}

export function subscribeToResearchRun(client, runId, onChange) {
  const channel = client
    .channel(`research-run-${runId}`)
    .on('postgres_changes', {event: '*', schema: 'public', table: 'research_runs', filter: `id=eq.${runId}`}, onChange)
    .on('postgres_changes', {event: '*', schema: 'public', table: 'research_tasks', filter: `run_id=eq.${runId}`}, onChange)
    .on('postgres_changes', {event: '*', schema: 'public', table: 'research_events', filter: `run_id=eq.${runId}`}, onChange)
    .on('postgres_changes', {event: '*', schema: 'public', table: 'research_candidates', filter: `run_id=eq.${runId}`}, onChange)
    .subscribe();
  return () => client.removeChannel(channel);
}
