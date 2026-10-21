import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createWebhookVerifier,createEventInbox,createStopQueue} from './lemlist-delivery.js';
import {createCaptureDispatcher} from './lemlist-runtime.js';
const now='2030-01-03T00:00:00Z';
const base={enabled:true,mode:'synthetic'};
// This is a published dummy test string, not a generated or configured credential.
const dummy='synthetic-fixture-not-a-real-secret';
const raw=(changes={})=>JSON.stringify({secret:dummy,_id:'act_mock',type:'emailsReplied',teamId:'team_mock',campaignId:'campaign_mock',leadId:'lead_mock',leadEmail:'TEST@example.invalid',createdAt:'2030-01-02T00:00:00Z',...changes});
const verifier=()=>createWebhookVerifier({...base,secret:dummy,teamId:'team_mock',campaignId:'campaign_mock',clock:()=>now});
async function fixture(t){
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(`create role anon;create role authenticated;create schema private;
    create table private.lemlist_events(event_id text primary key);
    create table private.lemlist_insert_events(id uuid primary key,capture_id uuid,project_id text,sync_run_id bigint,captured_at timestamptz,project jsonb);
    create table private.lemlist_review_boundary(capture_id uuid,campaign_id text,go_live_at timestamptz);
    create table private.lemlist_excluded_projects(project_id text primary key);
    create table public.ccs_sync_runs(id bigint primary key,status text,started_at timestamptz,completed_at timestamptz);
    create table public.ccs_projects(project_id text primary key,first_seen_sync_run_id bigint,is_active boolean,site_closed boolean);`);
  await db.exec(await readFile(new URL('./docs/lemlist-delivery.sql',import.meta.url),'utf8'));
  return db;
}
async function seedStop(db){
  await db.exec(`insert into private.lemlist_events values('act_mock');
    insert into private.lemlist_stop_outbox(event_id,lead_id,campaign_id,recipient_email,provider_lead_id)
    values('act_mock','00000000-0000-4000-8000-000000000001','campaign_mock','test@example.invalid','lead_mock');`);
}
test('webhook verifies documented body secret and strips everything except normalized identity',async()=>{
  const event=await verifier()(raw({extra:'private content must not persist'}));
  assert.equal(event.kind,'reply');assert.equal(event.email,'test@example.invalid');assert.equal(event.providerLeadId,'lead_mock');
  assert.equal('secret'in event,false);assert.equal('extra'in event,false);
  for(const changes of [{secret:'wrong'},{secret:null},{teamId:'other'},{campaignId:'other'},{type:'emailsOpened'},{leadId:null},{leadEmail:null},{createdAt:'2040-01-01T00:00:00Z'}])await assert.rejects(verifier()(raw(changes)));
  await assert.rejects(verifier()('x'.repeat(65537)),/too large/);
  await assert.rejects(verifier()('{'),/JSON/);
  await assert.rejects(createWebhookVerifier()(raw()),/Disabled/);
});
test('inbox durably accepts verified events, rejects conflicting replay and never persists secret',async t=>{
  const db=await fixture(t);const inbox=createEventInbox({...base,db,verify:verifier()});
  await Promise.all([inbox.receive(raw()),inbox.receive(raw())]);
  const rows=(await db.query('select * from private.lemlist_event_inbox')).rows;
  assert.equal(rows.length,1);assert.ok(!JSON.stringify(rows).includes(dummy));
  await assert.rejects(inbox.receive(raw({type:'emailsBounced'})),/Conflicting/);
  await assert.rejects(inbox.receive(raw({secret:'bad'})),/authentication/);
  let applied=0;
  const results=await Promise.all([inbox.processNext(async()=>{applied++;return {state:'held'};}),inbox.processNext(async()=>{applied++;return {state:'held'};})]);
  assert.equal(applied,1);assert.ok(results.some(r=>r.state==='processed'));
});
test('unknown event application is quarantined and explicit retry uses the stored sanitized event',async t=>{
  const db=await fixture(t);const inbox=createEventInbox({...base,db,verify:verifier()});
  await inbox.receive(raw());
  assert.equal((await inbox.processNext(async()=>{throw new Error('sensitive diagnostic');})).state,'quarantined');
  const row=(await db.query('select * from private.lemlist_event_inbox')).rows[0];
  assert.equal(row.last_error_code,'event_apply_failed');assert.ok(!JSON.stringify(row).includes('sensitive'));
  await inbox.retry('act_mock');assert.equal((await inbox.processNext(async e=>{assert.equal(e.kind,'reply');return {state:'held'};})).state,'processed');
});
test('interrupted inbox processing is fenced before manual retry',async t=>{
  const db=await fixture(t);const inbox=createEventInbox({...base,db,verify:verifier()});await inbox.receive(raw());
  let release,started;const waiting=new Promise(r=>{started=r;});
  const first=inbox.processNext(async()=>{started();await new Promise(resolve=>{release=resolve;});return {state:'held'};});await waiting;
  assert.equal((await inbox.quarantineInterrupted('act_mock')).rows.length,0);
  await db.exec("update private.lemlist_event_inbox set claimed_at=clock_timestamp()-interval '3 minutes'");
  assert.equal((await inbox.quarantineInterrupted('act_mock')).rows.length,1);
  await inbox.retry('act_mock');assert.equal((await inbox.processNext(async()=>({state:'held'}))).state,'processed');
  release();assert.equal((await first).state,'superseded');
});
test('stop queue makes one active claim across workers and verifies exact pause result',async t=>{
  const db=await fixture(t);await seedStop(db);let stops=0;
  const options={...base,db,clock:()=>now,provider:{pause:async r=>{stops++;return {confirmed:true,leadId:r.leadId,campaignId:r.campaignId};}}};
  const results=await Promise.all([createStopQueue(options).runOne(),createStopQueue(options).runOne()]);
  assert.equal(stops,1);assert.ok(results.some(r=>r.state==='confirmed'));
  assert.equal((await db.query('select state from private.lemlist_stop_outbox')).rows[0].state,'confirmed');
});
test('pause failures retain durable work, retry boundedly and quarantine without raw errors',async t=>{
  const db=await fixture(t);await seedStop(db);let time=Date.parse(now),calls=0;
  const queue=createStopQueue({...base,db,clock:()=>new Date(time).toISOString(),provider:{pause:async()=>{calls++;throw new Error('raw credential diagnostic');}}});
  assert.equal((await queue.runOne()).state,'retry');assert.equal((await queue.runOne()).state,'empty');
  time+=10000;assert.equal((await queue.runOne()).state,'retry');time+=10000;
  assert.equal((await queue.runOne()).state,'quarantined');time+=100000;assert.equal((await queue.runOne()).state,'empty');
  assert.equal(calls,3);const row=(await db.query('select * from private.lemlist_stop_outbox')).rows[0];
  assert.equal(row.last_error_code,'stop_not_confirmed');assert.ok(!JSON.stringify(row).includes('credential'));
});
test('expired lease recovery fences a late previous worker result',async t=>{
  const db=await fixture(t);await seedStop(db);let release,started;
  const waiting=new Promise(r=>{started=r;});
  const first=createStopQueue({...base,db,clock:()=>now,provider:{pause:async r=>{started();await new Promise(resolve=>{release=resolve;});return {confirmed:true,leadId:r.leadId,campaignId:r.campaignId};}}});
  const pending=first.runOne();await waiting;
  const second=createStopQueue({...base,db,clock:()=> '2030-01-03T00:03:00Z',provider:{pause:async r=>({confirmed:true,leadId:r.leadId,campaignId:r.campaignId})}});
  assert.equal((await second.runOne()).state,'confirmed');release();assert.equal((await pending).state,'superseded');
  assert.equal((await db.query('select state from private.lemlist_stop_outbox')).rows[0].state,'confirmed');
});
test('missing provider identity requires unique readback before pause',async t=>{
  const db=await fixture(t);await seedStop(db);await db.exec('update private.lemlist_stop_outbox set provider_lead_id=null');
  let stops=0;const queue=createStopQueue({...base,db,clock:()=>now,provider:{lookup:async()=>({complete:true,matches:[]}),pause:async()=>{stops++;}}});
  assert.equal((await queue.runOne()).state,'retry');assert.equal(stops,0);
});
test('disabled queues and dispatcher touch no database',async()=>{
  await assert.rejects(createStopQueue().runOne(),/Disabled/);
  await assert.rejects(createEventInbox().receive(raw()),/Disabled/);
  await assert.rejects(createCaptureDispatcher().stage(),/Disabled/);
});
test('dispatcher stages completed inserts once and later picks up an older slow sync',async t=>{
  const db=await fixture(t);
  await db.exec(`insert into private.lemlist_review_boundary values('00000000-0000-4000-8000-000000000010','mock','2020-01-01');
    insert into public.ccs_sync_runs values(1,'running','2020-01-02T00:00:00Z',null),(2,'completed','2020-01-03T00:00:00Z','2020-01-03 02:00Z');
    insert into public.ccs_projects values('one',1,true,false),('two',2,true,false);
    insert into private.lemlist_insert_events values
    ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000010','one',1,'2020-01-02 01:00Z','{"first_seen_sync_run_id":1,"first_seen_at":"2020-01-02T00:30:00Z","discovered_after_baseline":true}'),
    ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000010','two',2,'2020-01-03 01:00Z','{"first_seen_sync_run_id":2,"first_seen_at":"2020-01-03T00:30:00Z","discovered_after_baseline":true}');`);
  const dispatcher=createCaptureDispatcher({...base,db});
  assert.equal((await dispatcher.stage()).length,1);assert.equal((await dispatcher.stage()).length,0);
  await db.exec("update public.ccs_sync_runs set status='completed',completed_at='2020-01-03 03:00Z' where id=1");
  assert.equal((await dispatcher.stage()).length,1);
  assert.equal((await dispatcher.processNext(async()=>({status:'review_only',submitted:false}))).state,'reviewed');
  assert.equal((await dispatcher.processNext(async()=>{throw new Error('owner review missing');})).state,'held');
  assert.equal((await dispatcher.processNext(async()=>{})).state,'empty');
});
test('historical exclusions and mismatched original linkage never stage work',async t=>{
  const db=await fixture(t);
  await db.exec(`insert into private.lemlist_review_boundary values('00000000-0000-4000-8000-000000000010','mock','2020-01-01');
    insert into public.ccs_sync_runs values(1,'completed','2020-01-02T00:00:00Z','2020-01-02 02:00Z');
    insert into public.ccs_projects values('old',1,true,false),('mismatch',2,true,false);
    insert into private.lemlist_excluded_projects values('old');
    insert into private.lemlist_insert_events values
    ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000010','old',1,'2020-01-02 01:00Z','{"first_seen_sync_run_id":1,"first_seen_at":"2020-01-02T00:30:00Z","discovered_after_baseline":true}'),
    ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000010','mismatch',1,'2020-01-02 01:00Z','{"first_seen_sync_run_id":1,"first_seen_at":"2020-01-02T00:30:00Z","discovered_after_baseline":true}');`);
  assert.equal((await createCaptureDispatcher({...base,db}).stage()).length,0);
});
