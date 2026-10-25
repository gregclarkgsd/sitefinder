# Tenancy

Site Finder is multi-tenant. Every tenant-scoped row carries a `tenant_id`
that references `public.tenants`, and every policy on those rows goes through
`public.is_tenant_member(tenant_id, min_role)`.

## Model

| Table | Purpose |
|---|---|
| `tenants` | `id`, `name`, unique `slug` |
| `tenant_members` | `(tenant_id, user_id)` with `role` in `admin`, `member`, `viewer` |

Roles rank `viewer < member < admin`. `is_tenant_member(t, min_role)` returns
true when the signed-in user's role in tenant `t` is at least `min_role`. It
fails closed for a null tenant, an unknown role or no session.

Access rules:

- Members read their own tenant and its member list.
- Only admins rename the tenant or add, change and remove members.
- A tenant always keeps one admin. Deleting the tenant or the auth user is
  still allowed.
- Nobody creates tenants from the app. `anon` has no access.

## Operating

Tenants and memberships are data, not migrations, so no tenant id or name
lives in source. Run these by hand with a service-level connection after the
person has signed in once:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v tenant_name='Example Ltd' -v tenant_slug='example' \
  -v admin_email='admin@example.com' \
  -f scripts/tenancy/create-tenant.sql

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v tenant_slug='example' -v member_email='person@example.com' \
  -v member_role='member' \
  -f scripts/tenancy/add-tenant-member.sql
```

Both scripts are safe to re-run and exit non-zero when the tenant or user is
missing.

## Tenant-owned tables

`saved_projects`, `project_notes`, `project_tasks`, `lead_tracking`,
`outreach_leads`, `outreach_communications`, `outreach_suppressions`,
`outreach_mailbox_state`, `outreach_oauth_states`, `outreach_reply_outcomes`,
`research_runs`, `research_tasks`, `research_events`, `research_candidates` and
`attio_sync_links` carry `tenant_id NOT NULL` with no default.

- Reads need membership; writes need the `member` role or above.
- `ccs_*` tables are shared public data, readable by anyone in any tenant.
- `outreach_programme_snapshot` is a frozen audit record that the app does not
  read. It is service-role only.
- Saved projects, notes, lead tracking, outreach leads (per recipient) and
  suppressions are unique per tenant, so tenants work the same CCS project
  independently.
- `tenant_id` cannot be changed once set.

Writers that predate tenancy do not send `tenant_id`, so it is filled in on
insert, never from a default:

| Table | Tenant comes from |
|---|---|
| research tasks, events, candidates | their run |
| outreach communications, reply outcomes | their lead |
| outreach suppressions | the lead with that recipient, else the acting user |
| mailbox state | the existing row, else the user who connected it |
| research runs | the existing row, else the creator, else `RESEARCH_AGENT_INGEST_TENANT_ID` for worker-started runs |
| Attio sync links | the existing row, else the tenant that owns the Attio project sync |
| everything else | the acting user, when they belong to exactly one tenant |

If no single tenant can be determined, the insert fails.

`tenant_outreach_settings` holds each tenant's CCS auto-queue templates and
whether it owns the Attio project sync. Only operators write it:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v tenant_slug='example' -v auto_queue=true \
  -v subject_template='Is {{project_name}} still live?' \
  -v body_template="$(cat body-template.txt)" \
  -v attio_project_sync=true \
  -f scripts/tenancy/set-outreach-settings.sql
```

## Rolling out to an existing database

1. Apply `20261025090000_add_tenants_and_memberships` and
   `20261025100000_scope_existing_tables_to_tenants`. From here, rows without a
   tenant are hidden from app users and new CCS projects are not auto-queued.
2. Create the tenant and its admin with `create-tenant.sql`.
3. Assign the existing rows:
   `psql "$DATABASE_URL" -v tenant_slug='example' -f scripts/tenancy/assign-existing-data-to-tenant.sql`
4. Restore automation with `set-outreach-settings.sql`. To keep the current
   auto-queue copy, use the subject and body from migration
   `20261007145812_sitefinder_multi_contact_per_project`, with `%s` replaced by
   `{{first_name}}` and `{{project_name}}`.
5. Set `RESEARCH_AGENT_INGEST_TENANT_ID` on the web service if the research
   worker starts its own runs.
6. Apply `20261025100100_require_tenant_on_existing_tables`. It stops and lists
   the tables with unassigned rows if step 3 was missed.

## Before adding a second tenant

The database isolates tenants, but some server code is still single-tenant:

- `process-scheduled-initial-outreach`, `send-approved-outreach` and
  `process-outreach-followups` read every tenant's leads and send from one
  configured mailbox. They must filter by tenant before a second tenant queues
  or approves outreach.
- `sync-ccs-projects-to-attio` and `sync-approved-leads-to-attio` write to one
  Attio workspace.
- The login screen, `server.js` and the Gmail and Attio functions still check
  for one company email domain.
- `server.js` research endpoints use the service key, so they need a
  membership check before users from different tenants share them.

## Guard rails

`tenant-neutral.test.js` fails if a migration from the tenancy work onwards,
or a tenancy script, names a brand or email domain, or gives `tenant_id` a
default.
