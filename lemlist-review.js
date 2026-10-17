// Offline review only. This module deliberately has no HTTP client or credentials.
import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, renameSync, unlinkSync, fsyncSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const time = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
const email = value => String(value || '').trim().toLowerCase();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validEmail = value => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };

// A single-machine, exclusive writer lock. An interrupted writer leaves the lock
// behind intentionally: inspect/reconcile it, never silently expire it and retry.
function transaction(path, operation) {
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  const fd = openSync(lock, 'wx', 0o600);
  let temporary;
  try {
    let state = null;
    try { state = JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const result = operation(state);
    temporary = `${path}.${randomUUID()}.tmp`;
    const out = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(out, JSON.stringify(result.state, null, 2)); fsyncSync(out); }
    finally { closeSync(out); }
    renameSync(temporary, path);
    return result.output;
  } finally {
    if (temporary) { try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    closeSync(fd);
    unlinkSync(lock);
  }
}

export function initializeReview(path, config, now = new Date().toISOString()) {
  return transaction(path, existing => {
    requireValue(!existing, 'Review store already exists; its boundary cannot be reset');
    requireValue(Number.isFinite(time(now)) && time(config.goLiveAt) > time(now), 'Choose a future, timezone-qualified go-live boundary');
    requireValue(typeof config.campaignId === 'string' && /^[\w-]+$/.test(config.campaignId), 'Campaign identifier required');
    requireValue(Array.isArray(config.excludedProjectIds) && config.excludedProjectIds.every(id => typeof id === 'string' && id.trim()), 'Complete historical project ID snapshot required');
    requireValue(config.snapshotComplete === true && config.captureInstalled === true, 'Complete snapshot and insert capture must be attested');
    requireValue(['mock', 'database'].includes(config.evidenceMode), 'Declare mock or database evidence mode');
    requireValue(typeof config.captureId === 'string' && config.captureId.trim(), 'Insert capture identifier required');
    const boundary = { campaignId: config.campaignId, goLiveAt: config.goLiveAt, excludedProjectIds: [...new Set(config.excludedProjectIds)].sort(), evidenceMode: config.evidenceMode, captureId: config.captureId, initializedAt: now };
    const state = { version: 1, automaticSending: false, boundary, boundaryHash: hash(boundary), events: {}, candidates: [], decisions: [] };
    return { state, output: { initialized: true, automaticSending: false, evidenceMode: boundary.evidenceMode, boundaryHash: state.boundaryHash } };
  });
}

function validateState(state) {
  requireValue(state?.version === 1 && state.automaticSending === false, 'Missing or unsupported review store');
  requireValue(state.boundaryHash === hash(state.boundary), 'Boundary changed: stop and reconcile');
}

export function evaluateCandidate(boundary, event, evidence, now) {
  const reasons = [];
  const p = event?.project || {};
  const c = evidence?.contact || {};
  const recipient = email(c.email);
  const companyKey = String(evidence?.companyKey || '').trim().toLowerCase();
  if (!event?.id || event.operation !== 'INSERT' || event.captureId !== boundary.captureId || event.evidenceMode !== boundary.evidenceMode) reasons.push('unverified_insert');
  if (!p.project_id || boundary.excludedProjectIds.includes(p.project_id)) reasons.push('historical_project');
  if (p.discovered_after_baseline !== true) reasons.push('baseline_project');
  if (!(time(p.first_seen_at) > time(boundary.goLiveAt) && time(p.first_seen_at) <= time(event?.capturedAt) && time(event?.capturedAt) <= time(now))) reasons.push('outside_go_live_boundary');
  if (p.is_active !== true || p.site_closed !== false) reasons.push('inactive_or_unknown_closure');
  if (!String(p.project_name || '').trim() || p.project_name === p.project_id) reasons.push('missing_project_name');
  // Evidence must be fresh, complete and bound to this exact project/contact/company.
  if (!Number.isFinite(time(now)) || !(time(evidence?.checkedAt) <= time(now) && time(now) - time(evidence?.checkedAt) <= 15 * 60_000)) reasons.push('stale_or_missing_checks');
  if (evidence?.projectId !== p.project_id || evidence?.insertEventId !== event?.id || evidence?.syncCompleted !== true || evidence?.projectActive !== true || evidence?.projectClosed !== false) reasons.push('unverified_project_or_sync');
  if (!validEmail(recipient) || c.verified !== true || c.suitableForDecoratingTender !== true) reasons.push('unverified_or_unsuitable_contact');
  if (!/^(attio:[\w-]+|domain:[a-z0-9.-]+\.[a-z]{2,})$/.test(companyKey) || evidence?.companyVerified !== true) reasons.push('unverified_company');
  if (evidence?.suppressionChecksComplete !== true || evidence?.suppressed !== false || evidence?.bounced !== false || evidence?.replied !== false) reasons.push('suppression_or_reply_hold');
  if (evidence?.historyChecksComplete !== true || evidence?.existingProjectOutreach !== false || evidence?.existingContactOutreach !== false || evidence?.existingCompanyOutreach !== false) reasons.push('existing_or_unknown_outreach');
  if (evidence?.ownershipChecksComplete !== true || evidence?.ownerConflict !== false || !validEmail(email(evidence?.ownerEmail)) || evidence?.ownerApproved !== true || evidence?.stage !== 'new') reasons.push('ownership_hold');
  if (evidence?.provider !== 'lemlist' || evidence?.gmailActive !== false || evidence?.otherProviderActive !== false) reasons.push('provider_conflict');
  if (!evidence?.reviewedBy || evidence?.manualReviewApproved !== true) reasons.push('manual_review_required');
  if (reasons.length) return { eligible: false, reasons };
  const payload = {
    email: recipient,
    projectName: p.project_name.trim(),
    sitefinderProjectId: p.project_id,
    projectFirstSeenAt: p.first_seen_at,
    contactOwner: email(evidence.ownerEmail),
  };
  // Identity fields must describe the reviewed recipient, not blindly copied CCS manager data.
  for (const key of ['firstName', 'lastName', 'companyName', 'jobTitle', 'phone']) {
    if (typeof c[key] === 'string' && c[key].trim()) payload[key] = c[key].trim();
  }
  if (p.address) payload.projectAddress = String(p.address);
  return { eligible: true, reasons: [], recipient, companyKey, payload };
}

export function reviewInsert(path, event, evidence, now = new Date().toISOString()) {
  return transaction(path, state => {
    validateState(state);
    requireValue(typeof event?.id === 'string' && event.id.trim(), 'Insert event ID required');
    const eventHash = hash(event);
    const previous = state.events[event.id];
    requireValue(!previous || previous.hash === eventHash, 'Insert event changed: reconcile rather than replacing it');
    const sameEvent = state.candidates.find(row => row.eventId === event.id);
    state.events[event.id] = { hash: eventHash, projectId: event.project?.project_id };
    const result = evaluateCandidate(state.boundary, event, evidence, now);
    if (result.eligible) {
      for (const row of state.candidates) {
        if (row === sameEvent) continue;
        if (row.projectId === event.project.project_id) result.reasons.push('duplicate_project');
        if (row.recipient === result.recipient) result.reasons.push('duplicate_contact');
        if (row.companyKey === result.companyKey) result.reasons.push('duplicate_company');
      }
    }
    if (result.reasons.length) {
      const output = { status: 'held', reasons: [...new Set(result.reasons)], submitted: false };
      if (sameEvent) { sameEvent.status = 'held'; sameEvent.holdReasons = output.reasons; }
      state.decisions.push({ eventId: event.id, checkedAt: now, ...output });
      return { state, output };
    }
    if (sameEvent) {
      // A changed recipient/company requires a new human reconciliation, never a
      // silent replacement that would free the old durable duplicate reservation.
      if (sameEvent.recipient !== result.recipient || sameEvent.companyKey !== result.companyKey || hash(sameEvent.requestPreview.body) !== hash(result.payload)) {
        sameEvent.status = 'held';
        sameEvent.holdReasons = ['reviewed_payload_changed'];
        return { state, output: { status: 'held', reasons: sameEvent.holdReasons, submitted: false } };
      }
      sameEvent.status = 'review_only';
      delete sameEvent.holdReasons;
      sameEvent.reviewedAt = now;
      sameEvent.reviewedBy = evidence.reviewedBy;
      sameEvent.evidenceHash = hash(evidence);
      return { state, output: { status: 'already_reviewed', candidateId: sameEvent.id, submitted: false } };
    }
    const candidate = {
      id: randomUUID(), eventId: event.id, projectId: event.project.project_id,
      recipient: result.recipient, companyKey: result.companyKey,
      status: 'review_only', reviewedAt: now, reviewedBy: evidence.reviewedBy,
      evidenceHash: hash(evidence), evidenceMode: state.boundary.evidenceMode,
      requestPreview: { method: 'POST', path: `/api/campaigns/${state.boundary.campaignId}/leads/?deduplicate=true&updateStrategy=fillEmptyOnly`, body: result.payload },
    };
    state.candidates.push(candidate);
    return { state, output: { status: 'review_only', submitted: false, candidate } };
  });
}
