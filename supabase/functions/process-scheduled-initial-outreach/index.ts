import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.110.7';

const START_DATE = '2026-08-17';
const DAILY_LIMIT = 20;
const BATCH_LIMIT = 3;
const ROLE_MAILBOX = /^(info|admin|accounts|sales|office|enquiries|hello|contact|commercial|estimating|tenders?|procurement|marketing|reception|support|team|projects?)$/i;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function londonClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    date: `${value.year}-${value.month}-${value.day}`,
    weekday: value.weekday,
    hour: Number(value.hour),
  };
}

function isNamedBusinessEmail(value: unknown) {
  const email = String(value || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return false;
  return !ROLE_MAILBOX.test(email.split('@')[0] || '');
}

Deno.serve(async req => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const cronSecret = Deno.env.get('OUTREACH_CRON_SECRET');
  if (!cronSecret || req.headers.get('x-sitefinder-cron-secret') !== cronSecret) {
    return json({ error: 'Unauthorised' }, 401);
  }

  const clock = londonClock();
  if (
    clock.date < START_DATE
    || ['Sat', 'Sun'].includes(clock.weekday)
    || clock.hour < 9
    || clock.hour >= 17
  ) {
    return json({ ok: true, skipped: 'outside_delivery_window', clock, sent: 0 });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return json({ error: 'Scheduler not configured' }, 503);
  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const { data: mailbox, error: mailboxError } = await db
    .from('outreach_mailbox_state')
    .select('mailbox_email')
    .eq('is_active', true)
    .is('last_error', null)
    .order('connected_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (mailboxError || !mailbox?.mailbox_email) {
    return json({ error: mailboxError?.message || 'No healthy outreach mailbox' }, 409);
  }
  const senderEmail = String(mailbox.mailbox_email).toLowerCase();

  const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count: sentInWindow, error: quotaError } = await db
    .from('outreach_communications')
    .select('id', { count: 'exact', head: true })
    .eq('direction', 'outbound')
    .eq('channel', 'email')
    .eq('status', 'sent')
    .eq('sender_email', senderEmail)
    .gte('occurred_at', windowStart);
  if (quotaError) return json({ error: `Could not verify daily limit: ${quotaError.message}` }, 502);
  const remaining = Math.max(0, DAILY_LIMIT - Number(sentInWindow || 0));
  if (!remaining) return json({ ok: true, skipped: 'daily_limit_reached', sent: 0, daily_limit: DAILY_LIMIT });

  const { data: owner, error: ownerError } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const approver = owner?.users?.find(user => String(user.email || '').toLowerCase() === 'greg@gsdecorating.com');
  if (ownerError || !approver) return json({ error: ownerError?.message || 'Campaign approver unavailable' }, 409);

  const { data: recentLeads, error: recentError } = await db
    .from('outreach_leads')
    .select('company_name')
    .gte('sent_at', new Date(Date.now() - 7 * 86400000).toISOString())
    .not('company_name', 'is', null);
  if (recentError) return json({ error: `Could not verify company pacing: ${recentError.message}` }, 502);
  const recentCompanies = new Set((recentLeads || []).map(row => String(row.company_name || '').trim().toLowerCase()).filter(Boolean));

  const { data: leads, error: leadsError } = await db
    .from('outreach_leads')
    .select('id,project_id,recipient_email,company_name,status,updated_at,attio_project_record_id,attio_record_id')
    .in('status', ['queued', 'approved'])
    .is('gmail_message_id', null)
    .order('created_at', { ascending: false })
    .limit(300);
  if (leadsError) return json({ error: leadsError.message }, 502);

  const projectIds = [...new Set((leads || []).map(lead => lead.project_id).filter(Boolean))];
  const { data: projects, error: projectsError } = await db
    .from('ccs_projects')
    .select('project_id,first_seen_at,is_active,site_closed')
    .in('project_id', projectIds);
  if (projectsError) return json({ error: projectsError.message }, 502);
  const projectMap = new Map((projects || []).map(project => [project.project_id, project]));

  const { data: suppressions, error: suppressionError } = await db
    .from('outreach_suppressions')
    .select('email');
  if (suppressionError) return json({ error: `Could not verify suppression list: ${suppressionError.message}` }, 502);
  const suppressed = new Set((suppressions || []).map(row => String(row.email || '').trim().toLowerCase()));

  const eligible = (leads || []).filter(lead => {
    const project = projectMap.get(lead.project_id);
    const email = String(lead.recipient_email || '').trim().toLowerCase();
    const company = String(lead.company_name || '').trim().toLowerCase();
    return project
      && project.is_active !== false
      && project.site_closed !== true
      && Boolean(lead.attio_project_record_id || lead.attio_record_id)
      && isNamedBusinessEmail(email)
      && !suppressed.has(email)
      && (!company || !recentCompanies.has(company));
  });
  const fresh = eligible.filter(lead => String(projectMap.get(lead.project_id)?.first_seen_at || '') >= '2026-08-16T23:00:00.000Z');
  const historic = eligible.filter(lead => String(projectMap.get(lead.project_id)?.first_seen_at || '') < '2026-08-16T23:00:00.000Z');
  const selected = [...fresh.slice(0, 1), ...historic].slice(0, Math.min(BATCH_LIMIT, remaining));

  const results = [];
  for (const lead of selected) {
    let approvedLead = lead;
    if (lead.status === 'queued') {
      const approvedAt = new Date().toISOString();
      const { data, error } = await db.from('outreach_leads').update({
        status: 'approved',
        approved_by: approver.id,
        approved_at: approvedAt,
        updated_by: approver.id,
        updated_at: approvedAt,
      }).eq('id', lead.id).eq('status', 'queued').eq('updated_at', lead.updated_at).select('id,status').maybeSingle();
      if (error || !data) {
        results.push({ lead_id: lead.id, sent: false, error: error?.message || 'Lead changed before approval' });
        continue;
      }
      approvedLead = { ...lead, ...data };
    }

    const response = await fetch(`${supabaseUrl}/functions/v1/send-approved-outreach`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'x-sitefinder-cron-secret': cronSecret,
      },
      body: JSON.stringify({ lead_id: approvedLead.id, mode: 'initial' }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await response.json().catch(() => ({}));
    results.push({ lead_id: approvedLead.id, sent: response.ok && body?.email_sent === true, status: response.status, ...body });
    if (response.status === 429) break;
    const company = String(lead.company_name || '').trim().toLowerCase();
    if (company) recentCompanies.add(company);
  }

  return json({
    ok: results.every(result => result.sent === true),
    start_date: START_DATE,
    cutoff_date: '2026-08-16',
    daily_limit: DAILY_LIMIT,
    sent_in_window_before_run: Number(sentInWindow || 0),
    selected: selected.length,
    sent: results.filter(result => result.sent === true).length,
    new_candidates: fresh.length,
    historic_candidates: historic.length,
    results,
  }, results.every(result => result.sent === true) ? 200 : 502);
});
