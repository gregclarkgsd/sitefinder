import {z} from 'zod';

const uuid = z.uuid();
const httpsUrl = z.url().refine(value => new URL(value).protocol === 'https:', {
  message: 'Only HTTPS source URLs are accepted',
});
const domain = z.string()
  .min(3)
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u);
const status = z.enum(['queued', 'running', 'paused', 'stopping', 'completed', 'failed', 'cancelled']);

const runUpsert = z.object({
  type: z.literal('run.upsert'),
  run: z.object({
    id: uuid,
    name: z.string().trim().min(1).max(120),
    source: z.enum(['attio', 'pipedrive', 'file']),
    status,
    companyLimit: z.number().int().min(1).max(250),
    companiesChecked: z.number().int().nonnegative().default(0),
    pagesInspected: z.number().int().nonnegative().default(0),
    peopleFound: z.number().int().nonnegative().default(0),
    configuration: z.record(z.string(), z.unknown()).default({}),
    startedAt: z.iso.datetime(),
  }).strict(),
}).strict();

const taskUpsert = z.object({
  type: z.literal('task.upsert'),
  task: z.object({
    id: uuid,
    runId: uuid,
    companyId: z.string().trim().min(1).max(240),
    companyName: z.string().trim().min(1).max(240),
    domain,
    status: z.enum(['waiting', 'running', 'review', 'completed', 'failed', 'skipped']),
    progress: z.number().int().nonnegative().default(0),
    pageCount: z.number().int().nonnegative().default(0),
    contactsFound: z.number().int().nonnegative().default(0),
    currentUrl: httpsUrl.optional(),
    pageTitle: z.string().trim().max(500).optional(),
    currentRole: z.string().trim().max(240).optional(),
    lastError: z.string().trim().max(1000).optional(),
    startedAt: z.iso.datetime().optional(),
    completedAt: z.iso.datetime().optional(),
  }).strict(),
}).strict();

const eventAppend = z.object({
  type: z.literal('event.append'),
  event: z.object({
    runId: uuid,
    taskId: uuid.optional(),
    sequence: z.number().int().nonnegative(),
    eventType: z.enum(['run', 'company', 'robots', 'page', 'pdf', 'candidate', 'comparison', 'warning', 'error']),
    message: z.string().trim().min(1).max(1000),
    sourceUrl: httpsUrl.optional(),
    createdAt: z.iso.datetime().optional(),
  }).strict(),
}).strict();

const candidateUpsert = z.object({
  type: z.literal('candidate.upsert'),
  candidate: z.object({
    id: uuid,
    runId: uuid,
    taskId: uuid,
    externalCandidateId: z.string().trim().min(1).max(240),
    companyId: z.string().trim().min(1).max(240),
    name: z.string().trim().min(1).max(240),
    jobTitle: z.string().trim().min(1).max(240),
    roleCategory: z.string().trim().min(1).max(120),
    sourceKind: z.string().trim().min(1).max(120),
    sourceUrl: httpsUrl,
    evidenceExcerpt: z.string().trim().max(2000).optional(),
    crmComparison: z.string().trim().min(1).max(500).default('not_checked'),
    emailStatus: z.string().trim().min(1).max(120).default('not_publicly_found'),
    confidence: z.number().min(0).max(1),
  }).strict(),
}).strict();

const runStatus = z.object({
  type: z.literal('run.status'),
  run: z.object({
    id: uuid,
    status,
    companiesChecked: z.number().int().nonnegative(),
    pagesInspected: z.number().int().nonnegative(),
    peopleFound: z.number().int().nonnegative(),
    failureMessage: z.string().trim().max(2000).optional(),
    completedAt: z.iso.datetime().optional(),
  }).strict(),
}).strict();

const messageSchema = z.discriminatedUnion('type', [
  runUpsert,
  taskUpsert,
  eventAppend,
  candidateUpsert,
  runStatus,
]);

export function parseResearchIngestMessage(value) {
  return messageSchema.parse(value);
}

export function parseResearchRunId(value) {
  return uuid.parse(value);
}

function optionalFields(values) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

export async function applyResearchIngestMessage(client, rawMessage) {
  const message = parseResearchIngestMessage(rawMessage);
  const now = new Date().toISOString();
  let operation;

  if (message.type === 'run.upsert') {
    const run = message.run;
    operation = client.from('research_runs').upsert({
      id: run.id,
      name: run.name,
      mode: 'read_only',
      source: run.source,
      status: run.status,
      company_limit: run.companyLimit,
      companies_checked: run.companiesChecked,
      pages_inspected: run.pagesInspected,
      people_found: run.peopleFound,
      configuration: run.configuration,
      started_at: run.startedAt,
      updated_at: now,
    }, {onConflict: 'id'});
  }

  if (message.type === 'task.upsert') {
    const task = message.task;
    operation = client.from('research_tasks').upsert({
      id: task.id,
      run_id: task.runId,
      company_id: task.companyId,
      company_name: task.companyName,
      domain: task.domain,
      status: task.status,
      progress: task.progress,
      page_count: task.pageCount,
      contacts_found: task.contactsFound,
      ...optionalFields({
        current_url: task.currentUrl,
        page_title: task.pageTitle,
        current_role: task.currentRole,
        last_error: task.lastError,
        started_at: task.startedAt,
        completed_at: task.completedAt,
      }),
      updated_at: now,
    }, {onConflict: 'id'});
  }

  if (message.type === 'event.append') {
    const event = message.event;
    operation = client.from('research_events').upsert({
      run_id: event.runId,
      ...optionalFields({task_id: event.taskId}),
      sequence: event.sequence,
      event_type: event.eventType,
      message: event.message,
      ...optionalFields({source_url: event.sourceUrl}),
      created_at: event.createdAt || now,
    }, {onConflict: 'run_id,sequence', ignoreDuplicates: true});
  }

  if (message.type === 'candidate.upsert') {
    const candidate = message.candidate;
    operation = client.from('research_candidates').upsert({
      id: candidate.id,
      run_id: candidate.runId,
      task_id: candidate.taskId,
      external_candidate_id: candidate.externalCandidateId,
      company_id: candidate.companyId,
      name: candidate.name,
      job_title: candidate.jobTitle,
      role_category: candidate.roleCategory,
      source_kind: candidate.sourceKind,
      source_url: candidate.sourceUrl,
      ...optionalFields({evidence_excerpt: candidate.evidenceExcerpt}),
      crm_comparison: candidate.crmComparison,
      email_status: candidate.emailStatus,
      confidence: candidate.confidence,
      updated_at: now,
    }, {onConflict: 'run_id,external_candidate_id'});
  }

  if (message.type === 'run.status') {
    const run = message.run;
    operation = client.from('research_runs').update({
      status: run.status,
      companies_checked: run.companiesChecked,
      pages_inspected: run.pagesInspected,
      people_found: run.peopleFound,
      failure_message: run.failureMessage || null,
      completed_at: run.completedAt || null,
      updated_at: now,
    }).eq('id', run.id);
  }

  const {error} = await operation;
  if (error) throw error;
  return {accepted: true, type: message.type};
}
