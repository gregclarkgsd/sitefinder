import { createHash } from 'node:crypto';
import { evaluateCandidate } from './lemlist-review.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const normalize = value => String(value || '').trim().toLowerCase();

// No live transport, credentials, scheduler or endpoint. Explicit synthetic mode
// is a test harness contract, not authentication or permission to connect a client.
export function createLemlistWorker({ enabled = false, mode, db, provider, verifyEvent, clock = () => new Date().toISOString() }) {
  function gate() {
    requireValue(enabled === true && mode === 'synthetic', 'Worker disabled: synthetic execution only');
  }
  const transaction = operation => db.transaction(operation);
  async function attempt(tx, leadId) {
    return (await tx.query('select * from private.lemlist_attempts where lead_id=$1 for update', [leadId])).rows[0];
  }
  function sameReadback(row, result) {
    return result?.complete === true && result.matches?.length === 1
      && result.matches[0].campaignId === row.campaign_id
      && result.matches[0].email === row.recipient_email
      && result.matches[0].projectName === row.payload.projectName
      && result.matches[0].sitefinderProjectId === row.payload.sitefinderProjectId
      && result.matches[0].firstName === row.payload.firstName
      && typeof result.matches[0].id === 'string' && result.matches[0].id.length > 0;
  }
  async function reconcile(leadId) {
    gate();
    const row = await transaction(tx => attempt(tx, leadId));
    requireValue(row, 'Unknown attempt');
    if (row.state !== 'uncertain') return { state: row.state };
    // Absence, duplicates, errors and mismatches never authorize a retry.
    let result;
    try { result = await provider.lookup({ campaignId: row.campaign_id, email: row.recipient_email }); }
    catch { return { state: 'uncertain' }; }
    if (!sameReadback(row, result)) return { state: 'uncertain' };
    return transaction(async tx => {
      const current = await attempt(tx, leadId);
      if (current.state !== 'uncertain') return { state: current.state };
      await tx.query("update private.lemlist_attempts set state='confirmed',provider_id=$2 where lead_id=$1", [leadId, result.matches[0].id]);
      return { state: 'confirmed' };
    });
  }
  async function enroll({ leadId, boundary, event, evidence }) {
    gate();
    requireValue(boundary?.evidenceMode === 'mock' && event?.evidenceMode === 'mock', 'Synthetic evidence required');
    const candidate = evaluateCandidate(boundary, event, evidence, clock());
    requireValue(candidate.eligible, `Candidate held: ${candidate.reasons.join(',')}`);
    requireValue(candidate.payload.firstName, 'Reviewed firstName required');
    const campaignId = boundary.campaignId;
    requireValue(typeof campaignId === 'string' && campaignId.length > 0, 'Campaign required');
    const payloadHash = digest({ campaignId, payload: candidate.payload });
    const reserved = await transaction(async tx => {
      // Same lock order as the shared provider RPC; serializes worker instances.
      const lead = (await tx.query('select * from public.outreach_leads where id=$1 for update', [leadId])).rows[0];
      requireValue(lead?.project_id === event.project.project_id && normalize(lead.recipient_email) === candidate.recipient
        && `attio:${normalize(lead.attio_company_record_id)}` === candidate.companyKey, 'Lead identity mismatch');
      const existing = await attempt(tx, leadId);
      if (existing) {
        requireValue(existing.payload_hash === payloadHash, 'Attempt identity/payload changed');
        return { created: false, state: existing.state };
      }
      const claim = (await tx.query("select public.claim_outreach_provider($1,'lemlist') as claim", [leadId])).rows[0].claim;
      requireValue(claim.allowed === true, 'Reservation denied');
      await tx.query("insert into private.lemlist_attempts(lead_id,campaign_id,recipient_email,payload_hash,payload,state) values($1,$2,$3,$4,$5,'uncertain')",
        [leadId, campaignId, candidate.recipient, payloadHash, JSON.stringify(candidate.payload)]);
      return { created: true };
    });
    if (!reserved.created) return { state: reserved.state, submitted: false };
    // Recheck local stops immediately before transport; keep the reservation even
    // if an event arrived after the claim. No transaction can atomically span a
    // remote API: provider-side pause/suppression enforcement remains necessary.
    const clear = await transaction(async tx => {
      await tx.query('select id from public.outreach_leads where id=$1 for update', [leadId]);
      const row = await attempt(tx, leadId);
      if (row.state !== 'uncertain') return false;
      if ((await tx.query('select 1 from public.outreach_suppressions where email=$1', [candidate.recipient])).rows.length) {
        await tx.query("update private.lemlist_attempts set state='held' where lead_id=$1", [leadId]);
        return false;
      }
      const claim = (await tx.query("select public.claim_outreach_provider($1,'lemlist') as claim", [leadId])).rows[0].claim;
      requireValue(claim.allowed === true, 'Final reservation check denied');
      return true;
    });
    if (!clear) return { state: 'held', submitted: false };
    try {
      await provider.enroll({ campaignId, payload: candidate.payload, launch: false });
    } catch { return { state: 'uncertain', submitted: true }; }
    return { ...await reconcile(leadId), submitted: true };
  }
  async function handleEvent(raw, headers) {
    gate();
    // Verifier must authenticate raw bytes before parsing and normalize only
    // supported provider events. No production verifier is supplied here.
    const event = await verifyEvent(raw, headers);
    const now = Date.parse(clock());
    requireValue(event?.authenticated === true && typeof event.id === 'string' && event.id.length > 0
      && ['reply','bounce','unsubscribe'].includes(event.kind)
      && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(event.email)
      && event.email === normalize(event.email)
      && Number.isFinite(Date.parse(event.occurredAt)) && Date.parse(event.occurredAt) <= now, 'Unverified or invalid event');
    const hash = digest([event.id,event.campaignId,event.email,event.kind,event.occurredAt]);
    return transaction(async tx => {
      // Serialize event replay, including deliveries racing across worker instances.
      await tx.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`lemlist-event:${event.id}`]);
      const prior = (await tx.query('select event_hash from private.lemlist_events where event_id=$1', [event.id])).rows[0];
      if (prior) { requireValue(prior.event_hash === hash, 'Conflicting event replay'); return { duplicate: true }; }
      const rows = (await tx.query('select * from private.lemlist_attempts where campaign_id=$1 and recipient_email=$2', [event.campaignId,event.email])).rows;
      requireValue(rows.length === 1, 'Unknown or ambiguous event identity; manual reconciliation required');
      await tx.query('select id from public.outreach_leads where lower(trim(recipient_email))=$1 order by id for update', [event.email]);
      await attempt(tx, rows[0].lead_id);
      await tx.query('insert into private.lemlist_events(event_id,event_hash,campaign_id,recipient_email,kind,occurred_at) values($1,$2,$3,$4,$5,$6)',
        [event.id,hash,event.campaignId,event.email,event.kind,event.occurredAt]);
      await tx.query("update private.lemlist_attempts set state='held' where lead_id=$1", [rows[0].lead_id]);
      // All three event types stop follow-ups. Replies hold without adding a
      // do-not-contact record; bounce and unsubscribe add durable suppression.
      const column = { reply:'last_reply_at', bounce:'last_bounce_at', unsubscribe:'last_unsubscribe_at' }[event.kind];
      const status = { reply:'replied', bounce:'bounced', unsubscribe:'suppressed' }[event.kind];
      await tx.query(`update public.outreach_leads set follow_up_enabled=false,next_follow_up_at=null,
        ${column}=greatest(${column},$2::timestamptz),status=case when status='suppressed' then status else $3 end
        where lower(trim(recipient_email))=$1`, [event.email,event.occurredAt,status]);
      if (event.kind !== 'reply') await tx.query("insert into public.outreach_suppressions(email,reason,source) values($1,$2,'lemlist') on conflict(email) do nothing", [event.email,event.kind]);
      return { duplicate: false, state: 'held' };
    });
  }
  return { enroll, reconcile, handleEvent };
}
