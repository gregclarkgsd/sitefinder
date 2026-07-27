create schema if not exists private;

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
    format('Painting and decorating support for %s', new.project_name),
    format(
      E'Hi%s,\n\nI''m getting in touch from GSD Painting & Decorating regarding %s.\n\nWe support main contractors with commercial painting and decorating packages across London and the Home Counties. If this package is still available, we would welcome the opportunity to introduce GSD and understand your requirements.\n\nWould you be the right person to speak with?\n\nKind regards,\nSam\nGSD Painting & Decorating',
      case when contact_first_name is null then '' else ' ' || contact_first_name end,
      new.project_name
    )
  )
  on conflict (project_id) do nothing;

  return new;
end;
$$;

revoke all on function private.queue_new_ccs_project_for_outreach() from public, anon, authenticated;

drop trigger if exists queue_new_ccs_project_for_outreach on public.ccs_projects;
create trigger queue_new_ccs_project_for_outreach
after insert on public.ccs_projects
for each row
execute function private.queue_new_ccs_project_for_outreach();
