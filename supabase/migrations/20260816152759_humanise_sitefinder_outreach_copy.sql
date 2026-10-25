create or replace function private.queue_new_ccs_project_for_outreach()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
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
  values (
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
  )
  on conflict (project_id) do nothing;

  return new;
end;
$$;

revoke all on function private.queue_new_ccs_project_for_outreach() from public, anon, authenticated;
