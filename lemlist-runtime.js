import { syntheticGate, requireValue } from './lemlist-offline-ports.js';

export function createTransactionPort(options = {}) {
  return {
    async transaction(operation) {
      syntheticGate(options);
      const connection=await options.pool.connect();let begun=false,finished=false,releaseError;
      try {
        await connection.query('BEGIN ISOLATION LEVEL SERIALIZABLE');begun=true;
        await connection.query("SET LOCAL statement_timeout = '10s'");
        await connection.query("SET LOCAL lock_timeout = '5s'");
        const tx={query:(sql,params=[])=>{
          requireValue(!finished,'Transaction already closed');
          requireValue(typeof sql==='string' && Array.isArray(params),'Invalid parameterized query');
          return connection.query(sql,params);
        }};
        const result=await operation(tx);
        finished=true;
        // Do not replay callbacks: a failed COMMIT can have an uncertain outcome.
        await connection.query('COMMIT');return result;
      } catch(error) {
        releaseError=error;
        if(begun){try{await connection.query('ROLLBACK');}catch{/* release destroys connection */}}
        throw new Error('Transaction failed; reconcile before retry', {cause:error});
      } finally {finished=true;connection.release(releaseError);}
    },
  };
}

// Invoke the existing review builder within this callback to obtain one database
// snapshot rather than unrelated paginated REST requests. External coverage still
// requires its own fresh, complete evidence and is not part of this transaction.
export async function withSitefinderSnapshot(options, operation) {
  syntheticGate(options);
  const tables={events:['private.lemlist_insert_events','id'],boundary:['private.lemlist_review_boundary','singleton'],
    excluded:['private.lemlist_excluded_projects','project_id'],runs:['public.ccs_sync_runs','id'],
    projects:['public.ccs_projects','project_id'],leads:['public.outreach_leads','id'],tracking:['public.lead_tracking','project_id'],
    suppressions:['public.outreach_suppressions','id'],communications:['public.outreach_communications','id'],claims:['private.outreach_provider_claims','project_id']};
  return options.db.transaction(async tx=>{
    const port={
      async one(name,value){
        requireValue(Object.hasOwn(tables,name),'Unknown snapshot table');const [table,key]=tables[name];
        const rows=(await tx.query(`select * from ${table} where ${key}=$1`,[value])).rows;
        requireValue(rows.length===1,'Missing or ambiguous snapshot row');return rows[0];
      },
      async all(name){
        requireValue(Object.hasOwn(tables,name),'Unknown snapshot table');const [table,key]=tables[name];
        const rows=[];let cursor=null;
        for(let page=0;page<1000;page++){
          const batch=(await tx.query(`select * from ${table} ${cursor===null?'':`where ${key}>$1`} order by ${key} limit 1000`,cursor===null?[]:[cursor])).rows;
          rows.push(...batch);if(batch.length<1000)return rows;
          const next=batch.at(-1)[key];requireValue(next!=null && next!==cursor,'Unstable snapshot cursor');cursor=next;
        }
        throw new Error('Snapshot bound exceeded');
      },
    };
    return operation(port);
  });
}

// Durable per-event rows instead of a timestamp cursor that could skip an earlier
// slow sync. Dispatch stages review work only; it never calls enrollment.
export function createCaptureDispatcher(options = {}) {
  return {
    async stage(limit=100) {
      syntheticGate(options);requireValue(Number.isInteger(limit)&&limit>0&&limit<=500,'Invalid dispatch limit');
      return options.db.transaction(async tx=>{
        const result=await tx.query(`insert into private.lemlist_dispatch(event_id,state)
          select e.id,'pending' from private.lemlist_insert_events e
          join private.lemlist_review_boundary b on b.capture_id=e.capture_id
          join public.ccs_sync_runs r on r.id=e.sync_run_id
          join public.ccs_projects p on p.project_id=e.project_id
          where r.status='completed' and r.completed_at is not null
            and e.sync_run_id=p.first_seen_sync_run_id
            and e.project->>'first_seen_sync_run_id'=e.sync_run_id::text
            and (e.project->>'discovered_after_baseline')::boolean is true
            and (e.project->>'first_seen_at')::timestamptz>b.go_live_at
            and r.started_at<=(e.project->>'first_seen_at')::timestamptz
            and (e.project->>'first_seen_at')::timestamptz<=e.captured_at
            and e.captured_at<=r.completed_at and r.completed_at<=clock_timestamp()
            and p.is_active is true and p.site_closed is false
            and not exists(select 1 from private.lemlist_excluded_projects x where x.project_id=e.project_id)
            and not exists(select 1 from private.lemlist_dispatch d where d.event_id=e.id)
          order by e.captured_at,e.id limit $1 on conflict(event_id) do nothing returning event_id`,[limit]);
        return result.rows;
      });
    },
    async processNext(review) {
      syntheticGate(options);
      const row=await options.db.transaction(async tx=>{
        const next=(await tx.query("select event_id from private.lemlist_dispatch where state='pending' order by created_at,event_id for update skip locked limit 1")).rows[0];
        if(!next)return null;
        return (await tx.query("update private.lemlist_dispatch set state='processing',claimed_at=clock_timestamp(),generation=generation+1 where event_id=$1 returning *",[next.event_id])).rows[0];
      });
      if(!row)return {state:'empty'};
      // A crash leaves processing for explicit reconciliation, not auto-replay.
      let state;
      try {const result=await review(row.event_id);state=result?.submitted===false&&['review_only','already_reviewed'].includes(result.status)?'reviewed':'held';}
      catch{state='held';}
      const result=await options.db.transaction(tx=>tx.query('update private.lemlist_dispatch set state=$2 where event_id=$1 and state=\'processing\' and generation=$3 returning event_id',[row.event_id,state,row.generation]));
      return {eventId:row.event_id,state:result.rows.length?state:'superseded'};
    },
    async holdInterrupted(eventId) {
      syntheticGate(options);
      return options.db.transaction(tx=>tx.query("update private.lemlist_dispatch set state='held',generation=generation+1 where event_id=$1 and state='processing' and claimed_at<clock_timestamp()-interval '2 minutes' returning event_id",[eventId]));
    },
    async retryHeld(eventId) {
      syntheticGate(options);
      return options.db.transaction(tx=>tx.query("update private.lemlist_dispatch set state='pending' where event_id=$1 and state='held'",[eventId]));
    },
  };
}
