import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.110.7';

const START_DATE = '2026-08-17';
const CUTOFF_DATE = '2026-08-16T23:00:00.000Z';
const SENDER = 'sam.projects@gsdecorating.com';
const DAILY_LIMIT = 60;
const HISTORIC_TARGET = 60;
const GEO_TARGET = 40;
const TODAY_EXCEPTION_DATE = '2026-09-28';
const TODAY_NEW_TARGET = 4;
const MAX_BATCH = 5000;
const ROLE_MAILBOX = /^(info|admin|accounts|sales|office|enquiries|hello|contact|commercial|estimating|tenders?|procurement|marketing|reception|support|team|projects?)$/i;
const BLOCKED_DOMAINS = new Set(['berkeleygroup.co.uk','stgeorgeplc.com','stwilliam.co.uk','macegroup.com']);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function londonClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { date: `${value.year}-${value.month}-${value.day}`, weekday: value.weekday, hour: Number(value.hour) };
}
function namedBusinessEmail(value: unknown) {
  const email = String(value || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return false;
  const [local, domain] = email.split('@');
  return !ROLE_MAILBOX.test(local) && !BLOCKED_DOMAINS.has(domain);
}
function isFresh(project: any) { return String(project?.first_seen_at || '') >= CUTOFF_DATE; }
function isM25(project: any) {
  return Number(project?.latitude) >= 51.30 && Number(project?.latitude) <= 51.80 && Number(project?.longitude) >= -0.55 && Number(project?.longitude) <= 0.55;
}

Deno.serve(async req => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const cronSecret = Deno.env.get('OUTREACH_CRON_SECRET');
  if (!cronSecret || req.headers.get('x-sitefinder-cron-secret') !== cronSecret) return json({ error: 'Unauthorised' }, 401);
  const clock = londonClock();
  if (clock.date < START_DATE || ['Sat', 'Sun'].includes(clock.weekday) || clock.hour < 9 || clock.hour >= 17) {
    return json({ ok: true, skipped: 'outside_delivery_window', clock, sent: 0 });
  }
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return json({ error: 'Scheduler not configured' }, 503);
  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const localDayStart = new Date(`${clock.date}T00:00:00+01:00`);
  const nextLocalDayStart = new Date(localDayStart.getTime() + 24 * 60 * 60 * 1000);
  const { count: sentToday, error: quotaError } = await db.from('outreach_communications')
    .select('id', { count: 'exact', head: true }).eq('direction', 'outbound').eq('channel', 'email')
    .eq('status', 'sent').eq('sender_email', SENDER)
    .gte('occurred_at', localDayStart.toISOString()).lt('occurred_at', nextLocalDayStart.toISOString());
  if (quotaError) return json({ error: `Could not verify daily limit: ${quotaError.message}` }, 502);

  const { data: approverData, error: ownerError } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const approver = approverData?.users?.find(user => String(user.email || '').toLowerCase() === 'greg@gsdecorating.com');
  if (ownerError || !approver) return json({ error: ownerError?.message || 'Campaign approver unavailable' }, 409);

  const { data: leads, error: leadsError } = await db.from('outreach_leads')
    .select('id,project_id,recipient_email,company_name,status,updated_at,sender_email,attio_project_record_id,attio_record_id,gmail_message_id,created_at')
    .in('status', ['queued', 'approved']).is('gmail_message_id', null).limit(MAX_BATCH);
  if (leadsError) return json({ error: leadsError.message }, 502);
  const projectIds = [...new Set((leads || []).map(lead => lead.project_id).filter(Boolean))];
  if (!projectIds.length) return json({ ok: true, sent: 0, selected: 0, new_candidates: 0, historic_candidates: 0, geo_candidates: 0 });
  const { data: projects, error: projectsError } = await db.from('ccs_projects')
    .select('project_id,first_seen_at,is_active,site_closed,latitude,longitude').in('project_id', projectIds);
  if (projectsError) return json({ error: projectsError.message }, 502);
  const projectMap = new Map((projects || []).map(project => [project.project_id, project]));
  const { data: suppressions, error: suppressionError } = await db.from('outreach_suppressions').select('email');
  if (suppressionError) return json({ error: `Could not verify suppression list: ${suppressionError.message}` }, 502);
  const suppressed = new Set((suppressions || []).map(row => String(row.email || '').trim().toLowerCase()));
  const { data: priorSent, error: priorError } = await db.from('outreach_leads').select('recipient_email')
    .eq('sender_email', SENDER).not('sent_at', 'is', null).limit(MAX_BATCH);
  if (priorError) return json({ error: `Could not verify prior sends: ${priorError.message}` }, 502);
  const priorRecipients = new Set((priorSent || []).map(row => String(row.recipient_email || '').trim().toLowerCase()));
  const { data: recentLeads, error: recentError } = await db.from('outreach_leads').select('company_name')
    .not('sent_at', 'is', null).gte('sent_at', new Date(Date.now() - 7 * 86400000).toISOString()).limit(MAX_BATCH);
  if (recentError) return json({ error: `Could not verify company pacing: ${recentError.message}` }, 502);
  const recentCompanies = new Set((recentLeads || []).map(row => String(row.company_name || '').trim().toLowerCase()).filter(Boolean));
  const { data: staged, error: stagedError } = await db.from('_p3_send_batch').select('lead_id,bucket,sort_ord')
    .in('bucket', ['historic', 'geo']).order('sort_ord', { ascending: true }).limit(MAX_BATCH);
  if (stagedError) return json({ error: `Could not read staged Site Finder batch: ${stagedError.message}` }, 502);
  const baseEligible = (lead: any) => {
    const project = projectMap.get(lead.project_id);
    const email = String(lead.recipient_email || '').trim().toLowerCase();
    const company = String(lead.company_name || '').trim().toLowerCase();
    return project && project.is_active !== false && project.site_closed !== true && Boolean(lead.attio_project_record_id || lead.attio_record_id)
      && namedBusinessEmail(email) && !suppressed.has(email) && !priorRecipients.has(email) && (!company || !recentCompanies.has(company));
  };
  const eligible = (leads || []).filter(baseEligible);
  const byId = new Map(eligible.map(lead => [String(lead.id), lead]));
  const fresh = eligible.filter(lead => isFresh(projectMap.get(lead.project_id))).sort((a,b) => String(a.created_at).localeCompare(String(b.created_at)));
  const todayOnlyFresh = clock.date === TODAY_EXCEPTION_DATE;
  const freshForRun = todayOnlyFresh ? fresh.slice(0, TODAY_NEW_TARGET) : fresh;
  const stagedHistoric = (staged || []).filter(row => row.bucket === 'historic').map(row => byId.get(String(row.lead_id))).filter(Boolean);
  const stagedGeo = (staged || []).filter(row => row.bucket === 'geo').map(row => byId.get(String(row.lead_id))).filter(Boolean);
  const historic = stagedHistoric.filter(lead => isM25(projectMap.get(lead.project_id))).slice(0, HISTORIC_TARGET);
  const used = new Set([...freshForRun, ...historic].map(lead => String(lead.id)));
  const geo = todayOnlyFresh ? [] : stagedGeo.filter(lead => !used.has(String(lead.id))).slice(0, GEO_TARGET);
  const selected = [...freshForRun, ...historic, ...geo];
  const hardCeiling = DAILY_LIMIT;
  const remaining = Math.max(0, hardCeiling - Number(sentToday || 0));
  const results: any[] = [];
  if (!remaining) return json({ ok: true, skipped: 'hard_ceiling_reached', sender_email: SENDER, hard_ceiling: hardCeiling, sent_today_before_run: Number(sentToday || 0), new_candidates: freshForRun.length, fresh_available: fresh.length, historic_candidates: historic.length, geo_candidates: geo.length, selected: selected.length, sent: 0 });

  for (const lead of selected.slice(0, remaining)) {
    const current = lead.sender_email;
    if (current !== SENDER) {
      const stamp = new Date().toISOString();
      const { data: stamped, error: stampError } = await db.from('outreach_leads').update({ sender_email: SENDER, updated_at: stamp, updated_by: approver.id })
        .eq('id', lead.id).eq('status', lead.status).is('gmail_message_id', null).select('id').maybeSingle();
      if (stampError || !stamped) { results.push({ lead_id: lead.id, sent: false, error: stampError?.message || 'Lead changed before sender stamp' }); break; }
    }
    if (lead.status === 'queued') {
      const approvedAt = new Date().toISOString();
      const { data: approved, error: approveError } = await db.from('outreach_leads').update({ status: 'approved', sender_email: SENDER, approved_by: approver.id, approved_at: approvedAt, updated_by: approver.id, updated_at: approvedAt })
        .eq('id', lead.id).eq('status', 'queued').is('gmail_message_id', null).select('id').maybeSingle();
      if (approveError || !approved) { results.push({ lead_id: lead.id, sent: false, error: approveError?.message || 'Lead changed before approval' }); break; }
    }
    const response = await fetch(`${supabaseUrl}/functions/v1/send-approved-outreach`, { method: 'POST', headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', 'x-sitefinder-cron-secret': cronSecret }, body: JSON.stringify({ lead_id: lead.id, mode: 'initial', daily_ceiling: hardCeiling }), signal: AbortSignal.timeout(60_000) });
    const body = await response.json().catch(() => ({}));
    const sent = response.ok && body?.email_sent === true;
    results.push({ lead_id: lead.id, sent, status: response.status, ...body });
    if (!sent || response.status === 429 || /bounce|spam/i.test(JSON.stringify(body))) break;
  }
  return json({ ok: results.length > 0 && results.every(result => result.sent === true), sender_email: SENDER, start_date: START_DATE, cutoff_date: CUTOFF_DATE, hard_ceiling: hardCeiling, sent_today_before_run: Number(sentToday || 0), new_candidates: freshForRun.length, fresh_available: fresh.length, historic_candidates: historic.length, geo_candidates: geo.length, selected: selected.length, sent: results.filter(result => result.sent).length, stopped_on_error: results.some(result => !result.sent), results }, results.length > 0 && results.every(result => result.sent === true) ? 200 : 502);
});
