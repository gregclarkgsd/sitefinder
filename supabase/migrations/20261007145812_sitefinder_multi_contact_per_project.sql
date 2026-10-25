-- Site Finder: allow more than one contact per project (Greg approved option A, 7 Oct 2026 15:52 BST)
alter table public.outreach_leads drop constraint if exists outreach_leads_project_id_key;
create unique index if not exists outreach_leads_project_recipient_key
  on public.outreach_leads (project_id, lower(recipient_email));
create index if not exists outreach_leads_project_id_idx on public.outreach_leads (project_id);
alter table public.outreach_leads add column if not exists lead_source text;
comment on column public.outreach_leads.lead_source is 'Optional tag for how the lead was sourced, e.g. refill-geo-2026-10-07, refill-source1-2026-10-07';

-- New-CCS trigger: keep "first contact only" behaviour without relying on UNIQUE(project_id)
CREATE OR REPLACE FUNCTION private.queue_new_ccs_project_for_outreach()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  contact_first_name text;
begin
  if not new.discovered_after_baseline then
    return new;
  end if;

  contact_first_name := nullif(split_part(coalesce(new.site_manager_name, ''), ' ', 1), '');

  insert into public.outreach_leads (
    project_id,
    project_name,
    recipient_email,
    recipient_name,
    company_name,
    status,
    email_subject,
    email_body
  )
  select
    new.project_id,
    new.project_name,
    new.marker_email,
    new.site_manager_name,
    coalesce(new.main_contractor, new.client),
    'queued',
    format('Is %s still live?', new.project_name),
    format(
      E'Hi %s,\n\nI came across %s and wanted to check whether the painting and decorating package is still open for pricing.\n\nIf it is, I''d be happy to look at the drawings or arrange a quick site visit. We can also cover fire protection and window refurbishment where they form part of the package.\n\nIf someone else is handling it, would you mind pointing me in the right direction?\n\nBest,\nSam',
      coalesce(contact_first_name, 'there'),
      new.project_name
    )
  where not exists (select 1 from public.outreach_leads ol where ol.project_id = new.project_id)
  on conflict do nothing;

  return new;
end;
$function$;

-- Pre-send check: add (e) same-project guard; cap (60), sender, same-person and gmail-id checks unchanged
CREATE OR REPLACE FUNCTION public.phase3_presend_check(p_lead_ids uuid[], p_sender text DEFAULT 'sam.projects@gsdecorating.com'::text, p_dry_run boolean DEFAULT true, p_caller text DEFAULT NULL::text, p_other_sent_today integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
  v_proj_dupes jsonb;
  v_batch_proj_dupes jsonb;
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

  -- (e) same project: another lead on the project first-touched in the last 14 days (covers same day),
  --     an outbound email logged on the project today, or 2+ leads for one project in this batch
  with b as (select distinct l.id, l.project_id from outreach_leads l where l.id = any(v_ids)),
  hits as (
    select b.id, b.project_id, 'project_lead_sent_last_14d' src from b
      join outreach_leads o on o.project_id = b.project_id and o.id <> b.id
     where o.sent_at >= now() - interval '14 days'
    union
    select b.id, b.project_id, 'project_communication_today' from b
      join outreach_communications c on c.project_id = b.project_id
     where c.direction = 'outbound' and c.occurred_at >= v_day_start and c.occurred_at < v_day_end
       and c.outreach_lead_id is distinct from b.id
  )
  select coalesce(jsonb_agg(distinct jsonb_build_object('lead_id', id, 'project_id', project_id, 'source', src)), '[]') into v_proj_dupes from hits;
  if jsonb_array_length(v_proj_dupes) > 0 then
    v_reasons := v_reasons || format('(e) %s lead(s) in batch are on a project already emailed in the last 14 days or today', jsonb_array_length(v_proj_dupes));
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('project_id', project_id, 'times', n)), '[]') into v_batch_proj_dupes from (
    select project_id, count(*) n from outreach_leads where id = any(v_ids)
     group by 1 having count(*) > 1) d;
  if jsonb_array_length(v_batch_proj_dupes) > 0 then
    v_reasons := v_reasons || format('(e) %s project(s) appear more than once in this batch', jsonb_array_length(v_batch_proj_dupes));
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
    'same_project_recent', v_proj_dupes,
    'project_repeated_in_batch', v_batch_proj_dupes,
    'sent_without_gmail_id', jsonb_build_object('count', v_no_gid) || v_no_gid_range
  );
  insert into phase3_presend_checks (dry_run, caller, sender_email, batch_size, lead_ids, pass, reasons, result)
  values (coalesce(p_dry_run, true), p_caller, v_sender, v_batch, v_ids, cardinality(v_reasons) = 0, v_reasons, v_result);
  return v_result;
end;
$function$;
