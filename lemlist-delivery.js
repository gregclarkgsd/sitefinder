import { createHash, timingSafeEqual } from 'node:crypto';
import { syntheticGate, requireValue } from './lemlist-offline-ports.js';
const hash=value=>createHash('sha256').update(value).digest();

export function createWebhookVerifier(options = {}) {
  return async raw=>{
    syntheticGate(options);
    requireValue(typeof options.secret==='string' && options.secret.length>=24,'Webhook secret not configured');
    requireValue(typeof raw==='string'||Buffer.isBuffer(raw),'Raw webhook bytes required');
    requireValue(Buffer.byteLength(raw)<=65536,'Webhook too large');
    let body;try{body=JSON.parse(raw.toString());}catch{throw new Error('Invalid webhook JSON');}
    requireValue(body && typeof body==='object' && !Array.isArray(body)
      && typeof body.secret==='string' && timingSafeEqual(hash(body.secret),hash(options.secret)),'Webhook authentication failed');
    const kind={emailsReplied:'reply',emailsBounced:'bounce',emailsUnsubscribed:'unsubscribe'}[body.type];
    requireValue(kind && body.teamId===options.teamId && body.campaignId===options.campaignId,'Webhook scope/type not accepted');
    requireValue([body._id,body.leadId,body.teamId,body.campaignId].every(v=>typeof v==='string'&&/^[\w-]{1,200}$/.test(v)),'Webhook identity missing');
    requireValue(typeof body.leadEmail==='string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.leadEmail),'Webhook recipient missing');
    const date=Date.parse(body.createdAt),now=Date.parse(options.clock());
    requireValue(typeof body.createdAt==='string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(body.createdAt)
      && Number.isFinite(date) && date<=now,'Webhook timestamp invalid');
    // Shared body password, not an HMAC. Return only allowlisted data: no secret,
    // arbitrary raw payload, headers or provider exception is ever persisted.
    return {authenticated:true,id:body._id,kind,campaignId:body.campaignId,providerLeadId:body.leadId,
      email:body.leadEmail.trim().toLowerCase(),occurredAt:new Date(date).toISOString()};
  };
}

export function createEventInbox(options = {}) {
  return {
    async receive(raw) {
      syntheticGate(options);
      const event=await options.verify(raw);
      requireValue(event?.authenticated===true,'Unverified inbox event');
      // Rebuild from explicit fields so even a misconfigured verifier cannot
      // accidentally persist its input secret or arbitrary provider payload.
      const safe={authenticated:true,id:event.id,kind:event.kind,campaignId:event.campaignId,
        providerLeadId:event.providerLeadId,email:event.email,occurredAt:event.occurredAt};
      requireValue(safe.id && safe.campaignId && safe.email && safe.providerLeadId && ['reply','bounce','unsubscribe'].includes(safe.kind),'Incomplete inbox event');
      const serialized=JSON.stringify(safe),digest=hash(serialized).toString('hex');
      return options.db.transaction(async tx=>{
        await tx.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`lemlist-inbox:${safe.id}`]);
        const prior=(await tx.query('select event_hash from private.lemlist_event_inbox where event_id=$1',[safe.id])).rows[0];
        if(prior){requireValue(prior.event_hash===digest,'Conflicting inbox replay');return {accepted:true,duplicate:true};}
        await tx.query("insert into private.lemlist_event_inbox(event_id,event_hash,normalized_event,state) values($1,$2,$3,'pending')",[safe.id,digest,serialized]);
        return {accepted:true,duplicate:false};
      });
    },
    async processNext(applyVerified) {
      syntheticGate(options);
      const row=await options.db.transaction(async tx=>{
        const next=(await tx.query("select * from private.lemlist_event_inbox where state='pending' order by created_at,event_id for update skip locked limit 1")).rows[0];
        if(!next)return null;
        return (await tx.query("update private.lemlist_event_inbox set state='processing',claimed_at=clock_timestamp(),generation=generation+1 where event_id=$1 returning *",[next.event_id])).rows[0];
      });
      if(!row)return {state:'empty'};
      let state='processed';
      try {
        const result=await applyVerified(row.normalized_event);
        requireValue(result?.state==='held'||result?.duplicate===true,'Event application was not confirmed');
      }catch{state='quarantined';}
      const result=await options.db.transaction(tx=>tx.query("update private.lemlist_event_inbox set state=$2,last_error_code=$3 where event_id=$1 and state='processing' and generation=$4 returning event_id",[row.event_id,state,state==='quarantined'?'event_apply_failed':null,row.generation]));
      return {state:result.rows.length?state:'superseded',eventId:row.event_id};
    },
    // Explicit recovery only; the apply handler must be idempotent by event ID.
    async retry(eventId) {
      syntheticGate(options);
      return options.db.transaction(tx=>tx.query("update private.lemlist_event_inbox set state='pending',last_error_code=null where event_id=$1 and state='quarantined'",[eventId]));
    },
    async quarantineInterrupted(eventId) {
      syntheticGate(options);
      return options.db.transaction(tx=>tx.query("update private.lemlist_event_inbox set state='quarantined',generation=generation+1,last_error_code='interrupted' where event_id=$1 and state='processing' and claimed_at<clock_timestamp()-interval '2 minutes' returning event_id",[eventId]));
    },
  };
}

export function createStopQueue(options = {}) {
  return {
    async runOne() {
      syntheticGate(options);
      const max=options.maxAttempts??3;
      requireValue(Number.isInteger(max)&&max>=1&&max<=10,'Invalid retry bound');
      const now=options.clock();requireValue(Number.isFinite(Date.parse(now)),'Invalid queue clock');
      const job=await options.db.transaction(async tx=>{
        const row=(await tx.query(`select * from private.lemlist_stop_outbox
          where (state in ('pending','retry') and next_attempt_at<=$1::timestamptz)
             or (state='processing' and claimed_at<$1::timestamptz-interval '2 minutes')
          order by created_at,event_id for update skip locked limit 1`,[now])).rows[0];
        if(!row)return null;
        if(row.attempts>=max){
          await tx.query("update private.lemlist_stop_outbox set state='quarantined',last_error_code='retry_exhausted' where event_id=$1",[row.event_id]);
          return {exhausted:true,event_id:row.event_id};
        }
        const updated=(await tx.query("update private.lemlist_stop_outbox set state='processing',attempts=attempts+1,generation=generation+1,claimed_at=$2 where event_id=$1 returning *",[row.event_id,now])).rows[0];
        return updated;
      });
      if(!job)return {state:'empty'};
      if(job.exhausted)return {state:'quarantined',eventId:job.event_id};
      let confirmed=false;
      try {
        let leadId=job.provider_lead_id;
        if(!leadId){
          const result=await options.provider.lookup({campaignId:job.campaign_id,email:job.recipient_email});
          requireValue(result?.complete===true && result.matches?.length===1
            && result.matches[0].email===job.recipient_email && result.matches[0].campaignId===job.campaign_id,'Stop identity unresolved');
          leadId=result.matches[0].id;
        }
        requireValue(typeof leadId==='string'&&leadId.length>0,'Stop lead missing');
        const result=await options.provider.pause({campaignId:job.campaign_id,leadId,email:job.recipient_email});
        confirmed=result?.confirmed===true && result.leadId===leadId && result.campaignId===job.campaign_id;
      }catch{/* Never store raw provider exceptions or release the permanent claim. */}
      const state=confirmed?'confirmed':job.attempts>=max?'quarantined':'retry';
      const next=new Date(Date.parse(now)+Math.min(300000,1000*2**job.attempts)).toISOString();
      const result=await options.db.transaction(tx=>tx.query(`update private.lemlist_stop_outbox
        set state=$3,next_attempt_at=$4,last_error_code=$5 where event_id=$1 and generation=$2 and state='processing' returning event_id`,
        [job.event_id,job.generation,state,next,confirmed?null:'stop_not_confirmed']));
      return {state:result.rows.length?state:'superseded',eventId:job.event_id};
    },
  };
}
