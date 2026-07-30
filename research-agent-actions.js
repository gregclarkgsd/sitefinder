import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {stableResearchTaskId} from './research-agent-ingest.js';

const uuid = z.uuid();
const minimumApprovalConfidence = 0.65;
const controlStatus = z.enum(['running', 'paused', 'stopping']);
const reviewDecision = z.enum(['approved', 'rejected', 'investigate']);

const controlRequest = z.object({
  runId: uuid,
  status: controlStatus,
}).strict();

const reviewRequest = z.object({
  candidateId: uuid,
  decision: reviewDecision,
}).strict();
const companyDomain = z.string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u);
const researchCompany = z.object({
  companyId: z.string().trim().min(1).max(240),
  companyName: z.string().trim().min(1).max(240),
  domain: companyDomain,
  apolloSearchDomain: companyDomain.optional(),
}).strict();
const runRequest = z.object({
  name: z.string().trim().min(1).max(120),
  companies: z.array(researchCompany).min(1).max(25),
  sources: z.object({
    website: z.literal(true),
    apollo: z.boolean(),
    companiesHouse: z.boolean(),
    procurement: z.boolean(),
  }).strict(),
  apolloMaxPeople: z.number().int().min(1).max(25),
  procurementDays: z.number().int().min(0).max(365),
}).strict().superRefine((request, context) => {
  const ids = new Set();
  for (const [index, company] of request.companies.entries()) {
    if (ids.has(company.companyId)) {
      context.addIssue({
        code: 'custom',
        path: ['companies', index, 'companyId'],
        message: 'Each company may appear only once',
      });
    }
    ids.add(company.companyId);
    if (!request.sources.apollo && company.apolloSearchDomain) {
      context.addIssue({
        code: 'custom',
        path: ['companies', index, 'apolloSearchDomain'],
        message: 'Apollo search domains require Apollo to be enabled',
      });
    }
  }
});

const allowedControlSources = {
  running: ['queued', 'running', 'paused'],
  paused: ['queued', 'running', 'paused'],
  stopping: ['queued', 'running', 'paused', 'stopping'],
};

export class ResearchActionError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'ResearchActionError';
    this.statusCode = statusCode;
  }
}

export function parseResearchControlRequest(runId, body) {
  return controlRequest.parse({
    runId,
    status: body?.status,
  });
}

export function parseResearchReviewRequest(candidateId, body) {
  return reviewRequest.parse({
    candidateId,
    decision: body?.decision,
  });
}

export function parseResearchRunRequest(body) {
  return runRequest.parse(body);
}

export async function applyResearchRunRequest(
  client,
  input,
  actorId,
  {idFactory = randomUUID, now = () => new Date().toISOString()} = {},
) {
  const request = runRequest.parse(input);
  const createdBy = uuid.parse(actorId);
  const runId = uuid.parse(idFactory());
  const createdAt = now();
  const requestedSources = Object.entries(request.sources)
    .filter(([, enabled]) => enabled)
    .map(([source]) => source);
  const configuration = {
    requestedSources,
    apolloMaxPeople: request.apolloMaxPeople,
    procurementDays: request.sources.procurement
      ? request.procurementDays
      : 0,
    companies: request.companies.map(company => ({
      companyId: company.companyId,
      domain: company.domain,
      ...(company.apolloSearchDomain
        ? {apolloSearchDomain: company.apolloSearchDomain}
        : {}),
    })),
    requestedBy: createdBy,
    requestVersion: 1,
  };
  const runRow = {
    id: runId,
    name: request.name,
    mode: 'read_only',
    source: 'file',
    status: 'queued',
    company_limit: request.companies.length,
    configuration,
    created_by: createdBy,
    updated_by: createdBy,
    created_at: createdAt,
    updated_at: createdAt,
  };
  const taskRows = request.companies.map(company => ({
    id: stableResearchTaskId(runId, company.companyId),
    run_id: runId,
    company_id: company.companyId,
    company_name: company.companyName,
    domain: company.domain,
    status: 'waiting',
    created_by: createdBy,
    updated_by: createdBy,
    created_at: createdAt,
    updated_at: createdAt,
  }));

  const runResult = await client
    .from('research_runs')
    .insert(runRow)
    .select('id')
    .single();
  if (runResult.error) throw runResult.error;

  try {
    const taskResult = await client.from('research_tasks').insert(taskRows);
    if (taskResult.error) throw taskResult.error;
    const eventResult = await client.from('research_events').insert({
      run_id: runId,
      sequence: 0,
      event_type: 'run',
      message:
        'Research request queued. Waiting for the approved local worker.',
      created_by: createdBy,
      created_at: createdAt,
    });
    if (eventResult.error) throw eventResult.error;
  } catch (error) {
    await client.from('research_runs').delete().eq('id', runId);
    throw error;
  }

  return {
    accepted: true,
    runId,
    status: 'queued',
    companyCount: request.companies.length,
    workerState: 'waiting_for_local_worker',
  };
}

export async function applyResearchRunControl(client, input, actorId) {
  const request = controlRequest.parse(input);
  const reviewedBy = uuid.parse(actorId);
  const {data, error} = await client
    .from('research_runs')
    .update({
      status: request.status,
      updated_by: reviewedBy,
      updated_at: new Date().toISOString(),
    })
    .eq('id', request.runId)
    .in('status', allowedControlSources[request.status])
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new ResearchActionError('Research run is not controllable', 409);
  }
  return {accepted: true, status: request.status};
}

export async function applyResearchCandidateReview(client, input, actorId) {
  const request = reviewRequest.parse(input);
  const reviewedBy = uuid.parse(actorId);
  const now = new Date().toISOString();
  let operation = client
    .from('research_candidates')
    .update({
      review_status: request.decision,
      reviewed_by: reviewedBy,
      reviewed_at: now,
      updated_by: reviewedBy,
      updated_at: now,
    })
    .eq('id', request.candidateId);
  if (request.decision === 'approved') {
    operation = operation
      .in('crm_comparison', [
        'pipedrive_only',
        'missing_from_both',
      ])
      .eq('email_status', 'public_email_found')
      .gte('confidence', minimumApprovalConfidence);
  }
  const {data, error} = await operation
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new ResearchActionError(
      request.decision === 'approved'
        ? 'Research candidate is not eligible for approval'
        : 'Research candidate not found',
      request.decision === 'approved' ? 409 : 404,
    );
  }
  return {
    accepted: true,
    decision: request.decision,
    crmWritebackAuthorized: false,
  };
}
