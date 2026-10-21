// Called only after the complete disposable schema and all four designs exist.
import assert from 'node:assert/strict';
import { createStopQueue } from '../lemlist-delivery.js';
import { createTransactionPort } from '../lemlist-runtime.js';
import { localTestPool } from './local-psql-test-port.mjs';

const mode = { enabled: true, mode: 'synthetic' };
const db = hook => createTransactionPort({ ...mode, pool: localTestPool(hook) });
const admin = db();
const query = (sql, params = []) => admin.transaction(tx => tx.query(sql, params));
const time = '2040-01-01T00:00:00Z';
const later = '2040-01-01T00:03:00Z';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const confirmed = request => ({ confirmed: true, leadId: request.leadId, campaignId: request.campaignId });
const queue = (provider, clock = time, database = admin, maxAttempts = 3) => createStopQueue({ ...mode,
  db: database, clock: () => clock, provider, maxAttempts });
const row = async id => (await query('select * from private.lemlist_stop_outbox where event_id=$1', [id])).rows[0];
async function seed(id) {
  await query(`insert into private.lemlist_events(event_id,event_hash,campaign_id,recipient_email,kind,occurred_at)
    values($1,'synthetic','mock-campaign','test@example.invalid','unsubscribe',$2)`, [id, time]);
  await query(`insert into private.lemlist_stop_outbox(event_id,lead_id,campaign_id,recipient_email,provider_lead_id,next_attempt_at)
    values($1,'00000000-0000-4000-8000-000000000001','mock-campaign','test@example.invalid',$1,$2)`, [id, time]);
}
function lockedClaim() {
  const entered = deferred(), release = deferred(); let once = true;
  const database = db(async (sql, result) => {
    if (once && /for update skip locked/i.test(sql) && result.rows.length) {
      once = false; entered.resolve(); await release.promise;
    }
  });
  return { database, entered, release };
}
async function test(name, fn) {
  await fn(); console.log(`Full PostgreSQL stop queue: ${name} passed.`);
}

export async function testStopConcurrency() {
  // Hold two physical sessions simultaneously and prove they are independent.
  const pool = localTestPool(), a = await pool.connect(), b = await pool.connect();
  try {
    const ids = await Promise.all([a.query('select pg_backend_pid() as pid'), b.query('select pg_backend_pid() as pid')]);
    assert.notEqual(ids[0].rows[0].pid, ids[1].rows[0].pid);
  } finally { a.release(); b.release(); }

  await test('SKIP LOCKED prevents competing workers claiming one job', async () => {
    await seed('mock-stop-lock'); const lock = lockedClaim(); let calls = 0;
    const provider = { pause: async r => { calls++; return confirmed(r); } };
    const first = queue(provider, time, lock.database).runOne();
    try { await lock.entered.promise; assert.equal((await queue(provider).runOne()).state, 'empty'); }
    finally { lock.release.resolve(); }
    assert.equal((await first).state, 'confirmed'); assert.equal(calls, 1);
    assert.equal((await row('mock-stop-lock')).attempts, 1);
  });
  await test('committed claim allows a different job to progress', async () => {
    await seed('mock-stop-independent-a'); await seed('mock-stop-independent-b');
    const entered = deferred(), release = deferred(); const calls = [];
    const provider = { pause: async r => { calls.push(r.leadId); if (calls.length === 1) { entered.resolve(); await release.promise; } return confirmed(r); } };
    const first = queue(provider).runOne();
    try { await entered.promise; assert.equal((await queue(provider).runOne()).state, 'confirmed'); }
    finally { release.resolve(); }
    assert.equal((await first).state, 'confirmed'); assert.equal(new Set(calls).size, 2);
  });
  await test('expired lease fences the old worker after recovery', async () => {
    await seed('mock-stop-fence'); const entered = deferred(), release = deferred();
    const first = queue({ pause: async r => { entered.resolve(); await release.promise; return confirmed(r); } }).runOne();
    try { await entered.promise; assert.equal((await queue({ pause: async () => { throw new Error('synthetic timeout'); } }, later).runOne()).state, 'retry'); }
    finally { release.resolve(); }
    assert.equal((await first).state, 'superseded');
    const saved = await row('mock-stop-fence'); assert.equal(saved.state, 'retry'); assert.equal(saved.generation, 2); assert.equal(saved.attempts, 2);
    assert.equal((await queue({ pause: async r => confirmed(r) }, '2040-01-01T00:03:05Z').runOne()).state, 'confirmed');
  });
  await test('concurrent due retry consumes only one remaining attempt', async () => {
    await seed('mock-stop-retry'); let calls = 0;
    const provider = { pause: async () => { calls++; throw new Error('synthetic provider failure'); } };
    assert.equal((await queue(provider, time, admin, 2).runOne()).state, 'retry');
    assert.equal((await queue(provider, time, admin, 2).runOne()).state, 'empty');
    const lock = lockedClaim(); const first = queue(provider, later, lock.database, 2).runOne();
    try { await lock.entered.promise; assert.equal((await queue(provider, later, admin, 2).runOne()).state, 'empty'); }
    finally { lock.release.resolve(); }
    assert.equal((await first).state, 'quarantined'); assert.equal(calls, 2);
    assert.equal((await row('mock-stop-retry')).attempts, 2);
  });
  await test('exhausted interrupted claim quarantines without another provider call', async () => {
    await seed('mock-stop-exhausted'); const entered = deferred(), release = deferred(); let calls = 0;
    const provider = { pause: async r => { calls++; entered.resolve(); await release.promise; return confirmed(r); } };
    const first = queue(provider, time, admin, 1).runOne();
    try { await entered.promise; assert.equal((await queue(provider, later, admin, 1).runOne()).state, 'quarantined'); }
    finally { release.resolve(); }
    assert.equal((await first).state, 'superseded'); assert.equal(calls, 1);
    assert.equal((await row('mock-stop-exhausted')).state, 'quarantined');
  });
  await test('claim transaction rollback leaves recoverable pending work', async () => {
    await seed('mock-stop-rollback'); let calls = 0;
    const provider = { pause: async r => { calls++; return confirmed(r); } };
    const failing = db(async sql => { if (/attempts=attempts\+1/.test(sql)) throw new Error('synthetic failure before commit'); });
    await assert.rejects(queue(provider, time, failing).runOne(), /reconcile before retry/);
    assert.equal(calls, 0); const saved = await row('mock-stop-rollback');
    assert.equal(saved.state, 'pending'); assert.equal(saved.attempts, 0); assert.equal(saved.generation, 0);
    assert.equal((await queue(provider).runOne()).state, 'confirmed'); assert.equal(calls, 1);
  });
  await test('accepted pause with lost response reconciles idempotently', async () => {
    await seed('mock-stop-uncertain'); let paused = false, effects = 0;
    const provider = { pause: async r => {
      if (!paused) { paused = true; effects++; throw new Error('synthetic response lost after pause'); }
      return confirmed(r);
    } };
    assert.equal((await queue(provider).runOne()).state, 'retry');
    assert.equal((await queue(provider, later).runOne()).state, 'confirmed'); assert.equal(effects, 1);
    assert.equal((await row('mock-stop-uncertain')).attempts, 2);
  });
  assert.equal((await query("select count(*)::int as n from private.outreach_provider_claims where project_id='mock-worker'")).rows[0].n, 1);
  assert.equal((await query("select count(*)::int as n from public.outreach_suppressions where email='test@example.invalid'")).rows[0].n, 1);
  console.log('7 full-schema stop queue scenarios passed with independent PostgreSQL sessions; claims and suppressions retained.');
}
