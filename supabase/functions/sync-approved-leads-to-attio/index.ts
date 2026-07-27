import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

const ATTIO_API = 'https://api.attio.com/v2';
const SITEFINDER_URL = 'https://gsd-sitefinder.onrender.com';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function optionalValues(values: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== null && value !== undefined && value !== ''),
  );
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const attioToken = Deno.env.get('ATTIO_ACCESS_TOKEN');
  const ownerId = Deno.env.get('ATTIO_DEFAULT_OWNER_ID');
  if (!supabaseUrl || !anonKey || !serviceKey || !attioToken || !ownerId) {
    return json({ error: 'Attio sync is not fully configured' }, 503);
  }

  const authorization = req.headers.get('Authorization') || '';
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  const email = String(userData.user?.email || '').toLowerCase();
  if (userError || !email.endsWith('@gsdecorating.com')) {
    return json({ error: 'Authorised GSD account required' }, 403);
  }

  let leadId = '';
  try {
    leadId = String((await req.json()).lead_id || '');
  } catch {
    return json({ error: 'Invalid request body' }, 400);
  }
  if (!/^[0-9a-f-]{36}$/i.test(leadId)) return json({ error: 'Valid lead_id required' }, 400);

  const db = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  const { data: lead, error: leadError } = await db
    .from('outreach_leads')
    .select(`
      id, project_id, project_name, recipient_email, recipient_name,
      company_name, status, approved_at,
      ccs_projects (
        main_contractor, client, local_authority, address,
        site_manager_name, site_manager_phone, marker_email,
        site_start_date, site_end_date, summary
      )
    `)
    .eq('id', leadId)
    .single();

  if (leadError || !lead) return json({ error: 'Approved lead not found' }, 404);
  if (!['approved', 'sent', 'replied'].includes(lead.status)) {
    return json({ error: 'Lead must be approved before Attio sync' }, 409);
  }

  const project = Array.isArray(lead.ccs_projects)
    ? lead.ccs_projects[0]
    : lead.ccs_projects;
  const ccsNumber = String(lead.project_id).replace(/^site/, '');
  const sourceUrl = `https://portal.ccscheme.org.uk/api/searchwebapi/getsiteposterdetails/${ccsNumber}/null`;
  const summary = project?.summary
    || `${lead.project_name} is a CCS-registered construction project in ${project?.local_authority || 'the GSD target area'}.`;

  const values = optionalValues({
    name: lead.project_name,
    stage: 'Lead',
    owner: [{
      referenced_actor_type: 'workspace-member',
      referenced_actor_id: ownerId,
    }],
    ccs_site_id: lead.project_id,
    sitefinder_source_url: sourceUrl,
    local_authority: project?.local_authority,
    main_contractor: project?.main_contractor || lead.company_name,
    client_name: project?.client,
    project_address: project?.address,
    site_contact_name: project?.site_manager_name || lead.recipient_name,
    site_contact_email: project?.marker_email || lead.recipient_email,
    site_contact_phone: project?.site_manager_phone,
    site_start_date: project?.site_start_date,
    site_end_date: project?.site_end_date,
    project_summary: summary,
    sitefinder_synced_at: new Date().toISOString(),
  });

  const attioResponse = await fetch(
    `${ATTIO_API}/objects/deals/records?matching_attribute=ccs_site_id`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${attioToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ data: { values } }),
    },
  );
  const attioBody = await attioResponse.json().catch(() => ({}));

  if (!attioResponse.ok) {
    const message = String(attioBody?.message || `Attio returned ${attioResponse.status}`).slice(0, 1000);
    await db.from('outreach_leads').update({
      attio_sync_error: message,
      updated_at: new Date().toISOString(),
    }).eq('id', lead.id);
    return json({ error: message }, 502);
  }

  const recordId = attioBody?.data?.id?.record_id;
  const syncedAt = new Date().toISOString();
  await db.from('outreach_leads').update({
    attio_record_id: recordId,
    attio_synced_at: syncedAt,
    attio_sync_error: null,
    updated_at: syncedAt,
  }).eq('id', lead.id);

  return json({
    ok: true,
    lead_id: lead.id,
    attio_record_id: recordId,
    attio_synced_at: syncedAt,
    web_url: attioBody?.data?.web_url || null,
    source: SITEFINDER_URL,
  });
});
