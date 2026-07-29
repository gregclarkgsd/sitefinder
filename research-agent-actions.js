import {z} from 'zod';

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
