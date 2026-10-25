create table if not exists public.phase3_presend_checks (
  id bigserial primary key,
  checked_at timestamptz not null default now(),
  dry_run boolean not null default true,
  caller text,
  sender_email text,
  batch_size int,
  lead_ids uuid[],
  pass boolean not null,
  reasons text[] not null default '{}',
  result jsonb not null
);
alter table public.phase3_presend_checks enable row level security;
revoke all on public.phase3_presend_checks from anon, authenticated;

create or replace function public.phase3_presend_check(
  p_lead_ids uuid[],
  p_sender text default 'sam.projects@gsdecorating.com',
  p_dry_run boolean default true,
  p_caller text default null,
  p_other_sent_today int default 0
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  c_sender constant text := 'sam.projects@gsdecorating.com';
  c_cap constant int := 60;
  v_sender text := lower(trim(coalesce(p_sender, '')));
  v_day_start timestamptz := date_trunc('day', now() at time zone 'Europe/London') at time zone 'Europe/London';
  v_day_end timestamptz := (date_trunc('day', now() at time zone 'Europe/London') + interval '1 day') at time zone 'Europe/London';
  v_ids uuid[] := coalesce(p_lead_ids, '{}');
  v_batch int;
  v_found int;
  v_first_touch_today int;
  v_comms_today int;
  v_sent_today int;
  v_other int := greatest(coalesce(p_other_sent_today, 0), 0);
  v_missing uuid[];
  v_wrong_sender jsonb;
  v_dupes jsonb;
  v_batch_dupes jsonb;
  v_no_gid int;
  v_no_gid_range jsonb;
  v_reasons text[] := '{}';
  v_result jsonb;
begin
  select count(distinct x) into v_batch from unnest(v_ids) x;

  -- (a) London-day total for the Phase 3 sender
  select count(*) into v_first_touch_today from outreach_leads
   where lower(sender_email) = c_sender and sent_at >= v_day_start and sent_at < v_day_end;
  select count(*) into v_comms_today from outreach_communications c
   where c.direction = 'outbound' and c.channel = 'email' and c.status = 'sent'
     and lower(c.sender_email) = c_sender and c.occurred_at >= v_day_start and c.occurred_at < v_day_end
     and not exists (select 1 from outreach_leads l where l.id = c.outreach_lead_id
                     and l.sent_at >= v_day_start and l.sent_at < v_day_end and lower(l.sender_email) = c_sender);
  v_sent_today := v_first_touch_today + v_comms_today + v_other;
  if v_batch = 0 then
    v_reasons := v_reasons || 'empty batch: no lead ids supplied';
  end if;
  if v_sent_today + v_batch > c_cap then
    v_reasons := v_reasons || format('(a) daily cap: %s already sent today (London) + %s in batch = %s > %s',
      v_sent_today, v_batch, v_sent_today + v_batch, c_cap);
  end if;

  -- (b) sender
  if v_sender <> c_sender then
    v_reasons := v_reasons || format('(b) sender is %L, must be %s', coalesce(nullif(v_sender, ''), '(blank)'), c_sender);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('lead_id', id, 'sender_email', sender_email)), '[]') into v_wrong_sender
    from outreach_leads where id = any(v_ids) and sender_email is not null and lower(trim(sender_email)) <> c_sender;
  if jsonb_array_length(v_wrong_sender) > 0 then
    v_reasons := v_reasons || format('(b) %s lead(s) in batch are stamped with a sender other than %s', jsonb_array_length(v_wrong_sender), c_sender);
  end if;

  select array_agg(x) into v_missing from (select distinct unnest(v_ids) x) u
   where not exists (select 1 from outreach_leads l where l.id = u.x);
  if v_missing is not null then
    v_reasons := v_reasons || format('%s lead id(s) in batch not found', cardinality(v_missing));
  end if;

  -- (c) contact already emailed today (any sender) or repeated within the batch
  with b as (select distinct l.id, lower(trim(l.recipient_email)) email from outreach_leads l where l.id = any(v_ids)),
  hits as (
    select b.id, b.email, 'lead_sent_today' src from b
      join outreach_leads o on lower(trim(o.recipient_email)) = b.email
     where o.sent_at >= v_day_start and o.sent_at < v_day_end
    union
    select b.id, b.email, 'communication_today' from b
      join outreach_communications c on lower(trim(c.recipient_email)) = b.email
     where c.direction = 'outbound' and c.occurred_at >= v_day_start and c.occurred_at < v_day_end
  )
  select coalesce(jsonb_agg(distinct jsonb_build_object('lead_id', id, 'email', email, 'source', src)), '[]') into v_dupes from hits;
  if jsonb_array_length(v_dupes) > 0 then
    v_reasons := v_reasons || format('(c) %s contact(s) in batch already emailed today', jsonb_array_length(v_dupes));
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('email', email, 'times', n)), '[]') into v_batch_dupes from (
    select lower(trim(recipient_email)) email, count(*) n from outreach_leads where id = any(v_ids)
     group by 1 having count(*) > 1) d;
  if jsonb_array_length(v_batch_dupes) > 0 then
    v_reasons := v_reasons || format('(c) %s contact(s) appear more than once in this batch', jsonb_array_length(v_batch_dupes));
  end if;

  -- (d) earlier rows marked sent with no Gmail message id (strict, no cutoff)
  select count(*), jsonb_build_object('first_sent_at', min(sent_at), 'last_sent_at', max(sent_at))
    into v_no_gid, v_no_gid_range
    from outreach_leads where status = 'sent' and gmail_message_id is null;
  if v_no_gid > 0 then
    v_reasons := v_reasons || format('(d) %s earlier row(s) marked sent have no Gmail message id', v_no_gid);
  end if;

  v_result := jsonb_build_object(
    'pass', cardinality(v_reasons) = 0,
    'reasons', to_jsonb(v_reasons),
    'checked_at', now(),
    'dry_run', coalesce(p_dry_run, true),
    'london_day_start', v_day_start,
    'sender_email', v_sender,
    'daily_cap', c_cap,
    'batch_size', v_batch,
    'sent_today', jsonb_build_object('first_touch_leads', v_first_touch_today, 'other_logged_sends', v_comms_today,
                                     'caller_reported_other', v_other, 'total', v_sent_today),
    'remaining_after_batch', c_cap - v_sent_today - v_batch,
    'wrong_sender_leads', v_wrong_sender,
    'missing_lead_ids', to_jsonb(coalesce(v_missing, '{}')),
    'already_emailed_today', v_dupes,
    'repeated_in_batch', v_batch_dupes,
    'sent_without_gmail_id', jsonb_build_object('count', v_no_gid) || v_no_gid_range
  );
  insert into phase3_presend_checks (dry_run, caller, sender_email, batch_size, lead_ids, pass, reasons, result)
  values (coalesce(p_dry_run, true), p_caller, v_sender, v_batch, v_ids, cardinality(v_reasons) = 0, v_reasons, v_result);
  return v_result;
end;
$$;

revoke all on function public.phase3_presend_check(uuid[], text, boolean, text, int) from public, anon, authenticated;
grant execute on function public.phase3_presend_check(uuid[], text, boolean, text, int) to service_role;
grant select, insert on public.phase3_presend_checks to service_role;
grant usage, select on sequence public.phase3_presend_checks_id_seq to service_role;

comment on function public.phase3_presend_check(uuid[], text, boolean, text, int) is
 'Phase 3 Site Finder hard pre-send check (Greg, 4 Oct 2026). Blocks if: (a) London-day sent + batch > 60; (b) sender not sam.projects@gsdecorating.com; (c) contact already emailed today or repeated in batch; (d) any earlier status=sent row has no gmail_message_id. Returns {pass, reasons, ...}. Every call is logged to phase3_presend_checks.';
