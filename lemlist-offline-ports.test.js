import test from 'node:test';
import assert from 'node:assert/strict';
import {createLemlistPort,createAttioReadPort,normalizeHistorySnapshot,createSourceInventoryReader,mapAttioHistoryPerson,mapLemlistHistoryLead} from './lemlist-offline-ports.js';
import {createTransactionPort,withSitefinderSnapshot} from './lemlist-runtime.js';
const now='2030-01-01T00:00:00Z';
const base={enabled:true,mode:'synthetic',campaignId:'mock-campaign'};
const lead={_id:'mock-lead',campaignId:'mock-campaign',email:'test@example.invalid',firstName:'Test',projectName:'Mock school',sitefinderProjectId:'mock-project',isPaused:false};
test('all provider/database ports are disabled by default',async()=>{
  await assert.rejects(createLemlistPort().listLeads('mock-campaign'),/Disabled/);
  await assert.rejects(createAttioReadPort().listRecords('people'),/Disabled/);
  await assert.rejects(createTransactionPort().transaction(()=>{}),/Disabled/);
  await assert.rejects(createLemlistPort({...base,mode:'live'}).lookup({campaignId:'mock-campaign',email:lead.email}),/Disabled/);
});
test('Lemlist pagination handles IDs-only pages and bounded 429 retry',async()=>{
  const calls=[],delays=[];let first=true;
  const p=createLemlistPort({...base,pageSize:1,delay:async ms=>delays.push(ms),request:async r=>{
    calls.push(r);if(first){first=false;return {status:429,retryAfterSeconds:2};}
    return {status:200,body:r.query.offset===0?[{_id:'mock-lead'}]:[]};
  }});
  assert.equal((await p.listLeads('mock-campaign')).length,1);
  assert.deepEqual(delays,[2000]);assert.deepEqual(calls.map(c=>c.query.offset),[0,0,1]);
  assert.ok(calls.every(c=>c.method==='GET'&&!('headers' in c)));
});
test('duplicate pages, invalid retry bound and partial pages fail closed',async()=>{
  await assert.rejects(createLemlistPort({...base,pageSize:1,request:async()=>({status:200,body:[{_id:'same'}]})}).listLeads('mock-campaign'),/Unstable/);
  await assert.rejects(createLemlistPort({...base,request:async()=>({status:429,retryAfterSeconds:100})}).listLeads('mock-campaign'),/bound/);
  await assert.rejects(createLemlistPort({...base,request:async()=>({status:200,body:{}})}).listLeads('mock-campaign'),/Incomplete/);
});
test('synthetic enrollment allowlists campaign, avoids launch fields and never retries writes',async()=>{
  const calls=[];const p=createLemlistPort({...base,allowSyntheticWrites:true,request:async r=>{calls.push(r);throw new Error('raw secret from provider');}});
  await assert.rejects(p.enroll({campaignId:'other',payload:lead,launch:false}),/allowlist/);assert.equal(calls.length,0);
  await assert.rejects(p.enroll({campaignId:'mock-campaign',payload:lead,launch:false}),/^Error: Provider outcome unknown$/);
  assert.equal(calls.length,1);assert.equal(calls[0].query.deduplicate,true);assert.equal(calls[0].query.updateStrategy,'fillEmptyOnly');
  assert.equal('launch' in calls[0].body,false);
});
test('readback is identity-bound and provider warnings hold',async()=>{
  const bad=createLemlistPort({...base,request:async()=>({status:200,body:{...lead,campaignId:'wrong'}})});
  await assert.rejects(bad.lookup({campaignId:'mock-campaign',email:lead.email}),/mismatch/);
  const warnings=createLemlistPort({...base,allowSyntheticWrites:true,request:async()=>({status:200,body:{warnings:[{code:'FIELDS_KEPT'}]}})});
  await assert.rejects(warnings.enroll({campaignId:'mock-campaign',payload:lead,launch:false}),/warnings/);
});
test('pause scopes the request and requires paused readback; already paused makes no write',async()=>{
  let paused=false;const calls=[];
  const p=createLemlistPort({...base,allowSyntheticWrites:true,request:async r=>{
    calls.push(r);if(r.method==='POST'){paused=true;return {status:200,body:[]};}
    return {status:200,body:{...lead,isPaused:paused}};
  }});
  const request={campaignId:'mock-campaign',leadId:'mock-lead',email:lead.email};
  assert.equal((await p.pause(request)).confirmed,true);
  assert.deepEqual(calls.find(c=>c.method==='POST').query,{campaignId:'mock-campaign'});
  await p.pause(request);assert.equal(calls.filter(c=>c.method==='POST').length,1);
  await assert.rejects(p.pause({...request,leadId:'other'}),/mismatch/);
  const noStop=createLemlistPort({...base,allowSyntheticWrites:true,request:async()=>({status:200,body:lead})});
  await assert.rejects(noStop.pause(request),/not confirmed/);
});
test('Attio queries only allowlisted objects with complete pages',async()=>{
  const calls=[];const p=createAttioReadPort({...base,pageSize:1,request:async r=>{calls.push(r);return {status:200,body:{data:r.body.offset===0?[{id:{record_id:'mock-person'}}]:[]}};}});
  assert.equal((await p.listRecords('people')).length,1);
  assert.equal(calls[0].path,'/v2/objects/people/records/query');assert.equal(calls[0].method,'POST');
  await assert.rejects(p.listRecords('../unknown'),/allowlist/);
});
test('raw pages never imply full suppression/history coverage',()=>{
  const coverage={provider:'attio',complete:true,stable:true,history:true,suppressions:true,reference:'mock-export',checkedAt:now};
  const options={provider:'attio',rows:[{}],coverage,now,mapRecord:()=>({email:lead.email,companyKey:'attio:mock-company',active:false,contacted:false,suppressed:false,bounced:false,replied:false})};
  assert.equal(normalizeHistorySnapshot(options).complete,true);
  assert.throws(()=>normalizeHistorySnapshot({...options,coverage:{...coverage,stable:false}}),/coverage/);
  assert.throws(()=>normalizeHistorySnapshot({...options,mapRecord:()=>({email:lead.email,companyKey:'attio:mock-company'})}),/mapping/);
});
test('Woodpecker unknown holds; verified non-use needs no provider connection',async()=>{
  let reads=0;const inventory={woodpecker:{status:'unknown'}};
  const read=createSourceInventoryReader({inventory,readSnapshot:async()=>{reads++;}});
  await assert.rejects(read('woodpecker',now),/unconfirmed/);assert.equal(reads,0);
  inventory.woodpecker={status:'not_used',verifiedBy:'owner',reference:'mock-inventory',checkedAt:now};
  assert.equal((await read('woodpecker',now)).unusedVerified,true);assert.equal(reads,0);
  inventory.attio={...inventory.woodpecker};await assert.rejects(read('attio',now),/cannot be disabled/);
});
test('transaction port dedicates one connection and closes escaped transaction handles',async()=>{
  const calls=[];let escaped;
  const connection={query:async(...args)=>{calls.push(args);return {rows:[]};},release:error=>calls.push(['release',error])};
  const db=createTransactionPort({...base,pool:{connect:async()=>connection}});
  await db.transaction(async tx=>{escaped=tx;await tx.query('select $1',[17]);});
  assert.equal(calls[0][0],'BEGIN ISOLATION LEVEL SERIALIZABLE');assert.deepEqual(calls[3],['select $1',[17]]);
  assert.equal(calls.at(-2)[0],'COMMIT');assert.throws(()=>escaped.query('select 1'),/closed/);
});
test('failed commit is rolled back/discarded without replaying the operation',async()=>{
  let operations=0,releases=0;const calls=[];
  const db=createTransactionPort({...base,pool:{connect:async()=>({query:async sql=>{calls.push(sql);if(sql==='COMMIT')throw new Error('lost');return {rows:[]};},release:error=>{assert.ok(error);releases++;}})}});
  await assert.rejects(db.transaction(async()=>{operations++;}),/reconcile/);
  assert.equal(operations,1);assert.equal(releases,1);assert.equal(calls.at(-1),'ROLLBACK');
});
test('snapshot port uses one transaction and binds identities as parameters',async()=>{
  let transactions=0;const queries=[];
  const db={transaction:async fn=>{transactions++;return fn({query:async(sql,params)=>{queries.push({sql,params});return {rows:[{id:'mock'}]};}});}};
  await withSitefinderSnapshot({...base,db},async port=>{await port.one('events','mock');await port.all('runs');await assert.rejects(port.one('bad','x'),/Unknown/);});
  assert.equal(transactions,1);assert.deepEqual(queries[0].params,['mock']);assert.ok(queries[0].sql.includes('where id=$1'));
});
test('provider mappings require record-bound history and a real company relationship',()=>{
  const flags={active:false,contacted:false,suppressed:false,bounced:false,replied:false};
  const record={id:{record_id:'person'},values:{email_addresses:[{email_address:'test@example.invalid'}],company:[{target_record_id:'company',target_object:'companies'}]}};
  const args={companyId:'company',evidence:{subjectId:'person',...flags}};
  assert.equal(mapAttioHistoryPerson(record,args).companyKey,'attio:company');
  assert.throws(()=>mapAttioHistoryPerson(record,{...args,companyId:'wrong'}),/link/);
  assert.throws(()=>mapAttioHistoryPerson(record,{...args,evidence:{...args.evidence,subjectId:'other'}}),/bound/);
  record.values.email_addresses.push({email_address:'other@example.invalid'});
  assert.throws(()=>mapAttioHistoryPerson(record,args),/email/);
  assert.equal(mapAttioHistoryPerson(record,{...args,approvedEmail:'test@example.invalid'}).email,'test@example.invalid');
  assert.equal(mapLemlistHistoryLead(lead,{companyKey:'attio:company',evidence:{subjectId:'mock-lead',campaignId:'mock-campaign',...flags}}).contacted,false);
});
