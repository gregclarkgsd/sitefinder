// Explicit local Docker only. No connection string, network client or production target.
// Run after `supabase db reset --local --no-seed`; uses disposable synthetic rows.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const args=['exec','-i','supabase_db_sitefinder','psql','-X','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-At'];
function sql(source) {
  const result=spawnSync('docker',args,{input:source,encoding:'utf8'});
  if(result.error) throw result.error;
  if(result.status!==0) throw new Error(result.stderr);
  return result.stdout;
}
function concurrent(source) {
  return new Promise(resolve=>{
    const child=spawn('docker',args);let output='';
    child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
    child.on('error',error=>resolve({code:-1,output:error.message}));
    child.on('close',code=>resolve({code,output}));child.stdin.end(source);
  });
}
// Check the exact local stack exists before any writes; no remote fallback.
sql('select version();');
for(const file of ['lemlist-insert-capture.sql','outreach-provider-guard.sql','lemlist-worker.sql','lemlist-delivery.sql'])
  sql(readFileSync(new URL(`../docs/${file}`,import.meta.url),'utf8'));
sql(`
  insert into public.ccs_projects(project_id,project_name,payload_hash,discovered_after_baseline)
    values('mock-historical','Mock historical','mock',false);
  select private.initialize_lemlist_review('mock-campaign',now()+interval '1 day');
  insert into public.ccs_sync_runs(status) values('running');
  insert into public.ccs_projects(project_id,project_name,payload_hash,discovered_after_baseline,first_seen_sync_run_id)
    values('mock-worker','Mock school','mock',false,(select max(id) from public.ccs_sync_runs));
  insert into public.outreach_leads(id,project_id,project_name,recipient_email,attio_company_record_id,status,sender_email)
    values('00000000-0000-4000-8000-000000000001','mock-worker','Mock school','test@example.invalid','mock-company','queued','sender@example.invalid');
  insert into public.lead_tracking(project_id,assigned_email,stage) values('mock-worker','owner@example.invalid','new');
  insert into private.outreach_provider_checks values('00000000-0000-4000-8000-000000000001','test@example.invalid','attio:mock-company','owner@example.invalid','sender@example.invalid','lemlist',now(),true,true,true,true);
  do $$ begin
    if not exists(select 1 from private.lemlist_excluded_projects where project_id='mock-historical') then raise exception 'Exclusion missing'; end if;
    if not exists(select 1 from private.lemlist_insert_events where project_id='mock-worker' and sync_run_id is not null) then raise exception 'Capture missing'; end if;
  end $$;
  update public.ccs_projects set first_seen_sync_run_id=null where project_id='mock-worker';
  do $$ begin
    if (select first_seen_sync_run_id is null from public.ccs_projects where project_id='mock-worker') then raise exception 'Original run lost'; end if;
  end $$;
`);
const claim="select public.claim_outreach_provider('00000000-0000-4000-8000-000000000001','lemlist');";
const claims=await Promise.all([concurrent(`begin;${claim}select pg_sleep(2);commit;`),concurrent(`begin;${claim}commit;`)]);
assert.ok(claims.every(r=>r.code===0),JSON.stringify(claims));
assert.equal(claims.filter(r=>r.output.includes('"reused": false')).length,1);
assert.equal(claims.filter(r=>r.output.includes('"reused": true')).length,1);
const race=await Promise.all([1,2].map(n=>concurrent(`begin;
  insert into private.outreach_provider_claims values('race-${n}','00000000-0000-4000-8000-00000000000${n+2}','race-${n}@example.invalid','attio:race-company','gmail',now());
  select pg_sleep(1); commit;`)));
assert.equal(race.filter(r=>r.code===0).length,1,JSON.stringify(race));
assert.match(race.find(r=>r.code!==0).output,/unique constraint/);
// Independent transactions compete on the global recipient and company indexes.
for(const [key,email,company] of [['email','test@example.invalid','attio:other'],['company','other@example.invalid','attio:mock-company']]) {
  const rejected=await concurrent(`insert into private.outreach_provider_claims values('mock-other-${key}','00000000-0000-4000-8000-000000000002','${email}','${company}','gmail',now());`);
  assert.notEqual(rejected.code,0); assert.match(rejected.output,/unique constraint/);
}
sql(`begin;
  insert into private.lemlist_attempts values('00000000-0000-4000-8000-000000000001','mock-campaign','test@example.invalid','mock','{}','uncertain',null,now());
  insert into private.lemlist_events(event_id,event_hash,campaign_id,recipient_email,kind,occurred_at) values('mock-event','mock','mock-campaign','test@example.invalid','unsubscribe',now());
  insert into public.outreach_suppressions(email,reason,source) values('test@example.invalid','unsubscribe','lemlist') on conflict(email) do nothing;
  update public.outreach_leads set follow_up_enabled=false,next_follow_up_at=null,last_unsubscribe_at=now(),status='suppressed' where project_id='mock-worker';
  update private.lemlist_attempts set state='held';
commit;`);
const blocked=await concurrent(claim);assert.notEqual(blocked.code,0);assert.match(blocked.output,/suppression/);
console.log('Complete migrated Supabase schema: design SQL, capture, immutable linkage, concurrent claims, unique identities and suppression passed.');
