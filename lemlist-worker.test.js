import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createLemlistWorker } from './lemlist-worker.js';
import {createWebhookVerifier,createEventInbox,createStopQueue} from './lemlist-delivery.js';

const leadId='00000000-0000-4000-8000-000000000001';
const now='2030-01-03T00:00:00Z';
function input() {
  return {leadId, boundary:{campaignId:'mock-campaign',captureId:'capture',evidenceMode:'mock',excludedProjectIds:[],goLiveAt:'2030-01-01T00:00:00Z'},
    event:{id:'event',captureId:'capture',evidenceMode:'mock',operation:'INSERT',capturedAt:'2030-01-02T01:00:00Z',project:{project_id:'p1',project_name:'Mock school',first_seen_at:'2030-01-02T00:00:00Z',discovered_after_baseline:true,is_active:true,site_closed:false}},
    evidence:{checkedAt:now,projectId:'p1',insertEventId:'event',syncCompleted:true,projectActive:true,projectClosed:false,
      contact:{email:'test@example.invalid',firstName:'Test',verified:true,suitableForDecoratingTender:true},companyKey:'attio:company',companyVerified:true,
      suppressionChecksComplete:true,suppressed:false,bounced:false,replied:false,historyChecksComplete:true,existingProjectOutreach:false,existingContactOutreach:false,existingCompanyOutreach:false,
      ownershipChecksComplete:true,ownerConflict:false,ownerEmail:'owner@example.invalid',ownerApproved:true,stage:'new',provider:'lemlist',gmailActive:false,otherProviderActive:false,reviewedBy:'owner@example.invalid',manualReviewApproved:true}};
}
async function fixture(t) {
  const db=new PGlite(); t.after(()=>db.close());
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table public.outreach_leads(id uuid primary key,project_id text,recipient_email text,attio_company_record_id text,status text,sender_email text,
      gmail_message_id text,sent_at timestamptz,send_claimed_at timestamptz,next_follow_up_at timestamptz,
      last_reply_at timestamptz,last_bounce_at timestamptz,last_unsubscribe_at timestamptz,follow_up_enabled boolean default true);
    create table public.lead_tracking(project_id text primary key,assigned_email text,stage text);
    create table public.outreach_suppressions(email text primary key,reason text,source text);`);
  for (const file of ['outreach-provider-guard.sql','lemlist-worker.sql']) await db.exec(await readFile(new URL(`./docs/${file}`,import.meta.url),'utf8'));
  await db.exec('create table private.lemlist_insert_events(id uuid primary key)');
  await db.exec(await readFile(new URL('./docs/lemlist-delivery.sql',import.meta.url),'utf8'));
  await db.exec(`insert into public.outreach_leads(id,project_id,recipient_email,attio_company_record_id,status,sender_email)
      values('${leadId}','p1','test@example.invalid','company','queued','sender@example.invalid');
    insert into public.lead_tracking values('p1','owner@example.invalid','new');
    insert into private.outreach_provider_checks values('${leadId}','test@example.invalid','attio:company','owner@example.invalid','sender@example.invalid','lemlist',now(),true,true,true,true);`);
  let submissions=0, lookupResult;
  const provider={enroll:async request=>{submissions++; lookupResult={complete:true,matches:[{id:'mock-lead',campaignId:request.campaignId,...request.payload}]};},lookup:async()=>lookupResult};
  const options={enabled:true,mode:'synthetic',db,provider,verifyEvent:async raw=>JSON.parse(raw),clock:()=>now};
  return {db,provider,options,worker:createLemlistWorker(options),submissions:()=>submissions,
    event:(kind='unsubscribe',id='hook')=>JSON.stringify({authenticated:true,id,kind,email:'test@example.invalid',campaignId:'mock-campaign',occurredAt:'2030-01-02T23:00:00Z'})};
}
test('worker is disabled by default and rejects live mode before touching ports',async()=>{
  for (const options of [{},{enabled:true,mode:'live'}]) await assert.rejects(createLemlistWorker(options).enroll(input()),/disabled/);
});
test('concurrent mock workers submit once and persist exact reviewed variables',async t=>{
  const f=await fixture(t);
  const second=createLemlistWorker(f.options);
  await Promise.all([f.worker.enroll(input()),second.enroll(input())]);
  assert.equal(f.submissions(),1);
  const row=(await f.db.query('select * from private.lemlist_attempts')).rows[0];
  assert.equal(row.state,'confirmed'); assert.equal(row.payload.projectName,'Mock school');
  assert.equal(row.payload.firstName,'Test');
  assert.equal((await f.worker.enroll(input())).submitted,false);
  const changed=input(); changed.event.project.project_name='Renamed';
  await assert.rejects(f.worker.enroll(changed),/payload changed/);
});
test('timeout retains claim; missing or mismatched readback never retries',async t=>{
  const f=await fixture(t); let calls=0;
  f.provider.enroll=async()=>{calls++;throw new Error('timeout after possible acceptance');};
  assert.equal((await f.worker.enroll(input())).state,'uncertain');
  f.provider.lookup=async()=>({complete:true,matches:[]});
  assert.equal((await f.worker.reconcile(leadId)).state,'uncertain');
  await f.worker.enroll(input()); assert.equal(calls,1);
  assert.equal((await f.db.query('select * from private.outreach_provider_claims')).rows.length,1);
  f.provider.lookup=async()=>({complete:true,matches:[{id:'mock',campaignId:'wrong'}]});
  assert.equal((await f.worker.reconcile(leadId)).state,'uncertain');
  const payload=(await f.db.query('select payload from private.lemlist_attempts')).rows[0].payload;
  f.provider.lookup=async()=>({complete:true,matches:[{id:'mock',campaignId:'mock-campaign',...payload}]});
  assert.equal((await f.worker.reconcile(leadId)).state,'confirmed');
});
test('failed claim and stale review make zero submissions',async t=>{
  const f=await fixture(t); const stale=input();stale.evidence.checkedAt='2020-01-01T00:00:00Z';
  await assert.rejects(f.worker.enroll(stale),/held/);
  await f.db.exec('delete from private.outreach_provider_checks');
  await assert.rejects(f.worker.enroll(input()),/fresh cross-provider/);
  assert.equal(f.submissions(),0);
  assert.equal((await f.db.query('select * from private.lemlist_attempts')).rows.length,0);
});
for(const kind of ['reply','bounce','unsubscribe']) test(`${kind} atomically stops follow-ups, survives replay and cannot be undone by reconciliation`,async t=>{
  const f=await fixture(t); await f.worker.enroll(input());
  await Promise.all([f.worker.handleEvent(f.event(kind)),f.worker.handleEvent(f.event(kind))]);
  assert.equal((await f.db.query('select * from private.lemlist_events')).rows.length,1);
  assert.equal((await f.db.query('select * from private.lemlist_stop_outbox')).rows.length,1);
  const lead=(await f.db.query('select * from public.outreach_leads')).rows[0];
  assert.equal(lead.follow_up_enabled,false);assert.equal(lead.next_follow_up_at,null);
  assert.equal((await f.db.query('select * from public.outreach_suppressions')).rows.length,kind==='reply'?0:1);
  assert.equal((await f.worker.reconcile(leadId)).state,'held');
  assert.equal((await f.worker.enroll(input())).submitted,false);
  await assert.rejects(f.worker.handleEvent(f.event(kind==='reply'?'bounce':'reply')),/Conflicting/);
});
test('unverified and foreign-campaign events do not mutate state',async t=>{
  const f=await fixture(t);await f.worker.enroll(input());
  await assert.rejects(f.worker.handleEvent(f.event().replace('"authenticated":true','"authenticated":false')),/Unverified/);
  await assert.rejects(f.worker.handleEvent(f.event().replace('mock-campaign','foreign')),/Unknown/);
  assert.equal((await f.db.query('select * from private.lemlist_events')).rows.length,0);
});
test('event racing transport response wins over confirmation',async t=>{
  const f=await fixture(t);const original=f.provider.enroll;
  f.provider.enroll=async request=>{await original(request);await f.worker.handleEvent(f.event());};
  assert.equal((await f.worker.enroll(input())).state,'held');
});
test('crash after committed attempt and before transport never resubmits',async t=>{
  const f=await fixture(t);let first=true;
  const db={transaction:async operation=>{
    const result=await f.db.transaction(operation);
    if(first){first=false;throw new Error('simulated crash after commit');}
    return result;
  }};
  const interrupted=createLemlistWorker({...f.options,db});
  await assert.rejects(interrupted.enroll(input()),/simulated crash/);
  assert.deepEqual(await f.worker.enroll(input()),{state:'uncertain',submitted:false});
  assert.equal(f.submissions(),0);
});
test('event transaction rolls back all changes if shared suppression cannot be saved',async t=>{
  const f=await fixture(t);await f.worker.enroll(input());
  await f.db.exec("alter table public.outreach_suppressions add constraint simulate_failure check(reason <> 'unsubscribe')");
  await assert.rejects(f.worker.handleEvent(f.event()),/simulate_failure/);
  assert.equal((await f.db.query('select * from private.lemlist_events')).rows.length,0);
  assert.equal((await f.db.query('select state from private.lemlist_attempts')).rows[0].state,'confirmed');
  assert.equal((await f.db.query('select * from private.lemlist_stop_outbox')).rows.length,0);
  assert.equal((await f.db.query('select follow_up_enabled from public.outreach_leads')).rows[0].follow_up_enabled,true);
});
test('verified synthetic webhook flows through durable inbox, local hold and confirmed stop',async t=>{
  const f=await fixture(t);await f.worker.enroll(input());
  const dummy='synthetic-integration-fixture-secret';
  const verify=createWebhookVerifier({enabled:true,mode:'synthetic',secret:dummy,teamId:'mock-team',campaignId:'mock-campaign',clock:()=>now});
  const inbox=createEventInbox({enabled:true,mode:'synthetic',db:f.db,verify});
  await inbox.receive(JSON.stringify({_id:'act-integration',type:'emailsUnsubscribed',teamId:'mock-team',campaignId:'mock-campaign',leadId:'mock-lead',leadEmail:'test@example.invalid',createdAt:'2030-01-02T23:00:00Z',secret:dummy}));
  // Only the trusted inbox consumer passes stored verified events to this worker.
  const consumer=createLemlistWorker({...f.options,verifyEvent:async event=>event});
  assert.equal((await inbox.processNext(event=>consumer.handleEvent(event))).state,'processed');
  assert.equal((await f.db.query('select state from private.lemlist_attempts')).rows[0].state,'held');
  assert.equal((await f.db.query('select count(*)::int as n from public.outreach_suppressions')).rows[0].n,1);
  const queue=createStopQueue({enabled:true,mode:'synthetic',db:f.db,clock:()=>now,provider:{pause:async r=>({confirmed:true,leadId:r.leadId,campaignId:r.campaignId})}});
  assert.equal((await queue.runOne()).state,'confirmed');
  const persisted=JSON.stringify((await f.db.query('select * from private.lemlist_event_inbox')).rows);
  assert.ok(!persisted.includes(dummy));
});
