// Focused local PostgreSQL tests. PGlite uses memory only; no connection URL.
// Usage: node scripts/test-lemlist-sql.mjs [absolute PGlite module path]
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(process.argv[2] ? pathToFileURL(process.argv[2]).href : '@electric-sql/pglite');
const db = new PGlite();
let checks = 0;
const check = (actual, expected) => { assert.deepEqual(actual, expected); checks++; };
const value = async sql => (await db.query(sql)).rows[0].value;
try {
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table public.ccs_sync_runs(id bigint primary key, status text);
    insert into public.ccs_sync_runs values(1,'completed'),(2,'running');
    create table public.ccs_projects(project_id text primary key, project_name text, first_seen_at timestamptz default now(), discovered_after_baseline boolean default true);
    insert into public.ccs_projects(project_id,project_name) values('old','Historical');
    create table public.outreach_leads(id uuid primary key, project_id text, recipient_email text, attio_company_record_id text, status text,
      sender_email text, gmail_message_id text, sent_at timestamptz, send_claimed_at timestamptz, next_follow_up_at timestamptz,
      last_reply_at timestamptz,last_bounce_at timestamptz,last_unsubscribe_at timestamptz);
    create table public.lead_tracking(project_id text primary key, assigned_email text, stage text);
    create table public.outreach_suppressions(email text primary key);
  `);
  await db.exec(await readFile(new URL('../docs/lemlist-insert-capture.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../docs/outreach-provider-guard.sql', import.meta.url), 'utf8'));
  await db.query("select private.initialize_lemlist_review('mock-campaign', now()+interval '1 day')");
  check(await value("select count(*)::int as value from private.lemlist_excluded_projects where project_id='old'"), 1);
  await assert.rejects(db.query("select private.initialize_lemlist_review('again', now()+interval '2 days')")); checks++;
  await assert.rejects(db.query("update private.lemlist_review_boundary set go_live_at=now()"), /immutable/); checks++;
  await db.exec("insert into public.ccs_projects(project_id,project_name,first_seen_sync_run_id) values('new','New mock',2)");
  check(await value("select sync_run_id::int as value from private.lemlist_insert_events where project_id='new'"), 2);
  await db.exec("update public.ccs_projects set first_seen_sync_run_id=1,project_name='Updated' where project_id='new'");
  check(await value("select first_seen_sync_run_id::int as value from public.ccs_projects where project_id='new'"), 2);
  check(await value("select project->>'project_name' as value from private.lemlist_insert_events where project_id='new'"), 'New mock');
  await db.exec("update public.ccs_projects set first_seen_sync_run_id=1 where project_id='old'");
  check(await value("select first_seen_sync_run_id as value from public.ccs_projects where project_id='old'"), null);
  await db.exec("begin; insert into public.ccs_projects(project_id,first_seen_sync_run_id) values('rolled-back',2); rollback;");
  check(await value("select count(*)::int as value from private.lemlist_insert_events where project_id='rolled-back'"), 0);
  await db.exec("delete from public.ccs_projects where project_id='new'; insert into public.ccs_projects(project_id,first_seen_sync_run_id) values('new',1)");
  check(await value("select sync_run_id::int as value from private.lemlist_insert_events where project_id='new'"), 2);
  await db.exec(`
    insert into public.outreach_leads(id,project_id,recipient_email,attio_company_record_id,status,sender_email)
    values('00000000-0000-4000-8000-000000000001','p1','test@example.invalid','company','approved','owner@example.invalid');
    insert into public.lead_tracking values('p1','owner@example.invalid','new');
  `);
  const claim = provider => db.query("select public.claim_outreach_provider('00000000-0000-4000-8000-000000000001',$1) as value", [provider]);
  await assert.rejects(claim('gmail'), /fresh cross-provider/); checks++;
  await db.exec(`insert into private.outreach_provider_checks values
    ('00000000-0000-4000-8000-000000000001','test@example.invalid','attio:company','owner@example.invalid','gmail',now(),true,true,true,true)`);
  check((await claim('gmail')).rows[0].value, { allowed: true, reused: false });
  check((await claim('gmail')).rows[0].value, { allowed: true, reused: true });
  await assert.rejects(db.exec('delete from private.outreach_provider_claims'), /cannot be erased/); checks++;
  await db.exec("update private.outreach_provider_checks set provider='lemlist'; update public.outreach_leads set status='queued'");
  await assert.rejects(claim('lemlist'), /reservation conflict/); checks++;
  await db.exec("update private.outreach_provider_checks set provider='gmail'; insert into public.outreach_suppressions values('test@example.invalid')");
  await assert.rejects(claim('gmail'), /suppression/); checks++;
  await db.exec("delete from public.outreach_suppressions; update private.outreach_provider_checks set checked_at=now()-interval '1 hour'");
  await assert.rejects(claim('gmail'), /fresh cross-provider/); checks++;
  await assert.rejects(db.exec("insert into private.outreach_provider_claims values('p2','00000000-0000-4000-8000-000000000002','test@example.invalid','attio:other','lemlist',now())"), /unique/); checks++;
  await assert.rejects(db.exec("insert into private.outreach_provider_claims values('p2','00000000-0000-4000-8000-000000000002','other@example.invalid','attio:company','lemlist',now())"), /unique/); checks++;
  check(await value("select has_function_privilege('anon','public.claim_outreach_provider(uuid,text)','execute') as value"), false);
  check(await value("select has_function_privilege('authenticated','public.claim_outreach_provider(uuid,text)','execute') as value"), false);
  check(await value("select has_function_privilege('service_role','public.claim_outreach_provider(uuid,text)','execute') as value"), true);
  console.log(`${checks} focused PostgreSQL checks passed (in-memory synthetic database).`);
} finally { await db.close(); }
