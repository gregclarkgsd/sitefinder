import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.110.7';
import { canonicalCcsSiteId } from '../_shared/sync-safety.js';

const ATTIO_API = 'https://api.attio.com/v2';
const SITEFINDER_URL = 'https://gsd-sitefinder.onrender.com';
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const GENERIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'hotmail.com', 'outlook.com', 'live.com',
  'icloud.com', 'me.com', 'yahoo.com', 'aol.com', 'proton.me', 'protonmail.com',
]);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function optionalValues(values: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== null && value !== undefined && value !== ''),
  );
}

function normaliseEmail(value: unknown) {
  const email = String(value || '').trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : '';
}

function normaliseName(value: unknown) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function recordId(record: any) {
  return String(record?.id?.record_id || '');
}

async function attioFetch(token: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`${ATTIO_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
    signal: init.signal || AbortSignal.timeout(25_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(body?.message || `Attio returned ${response.status}`).slice(0, 1000));
  }
  return body;
}

async function queryRecords(token: string, object: string, filter: Record<string, unknown>) {
  const body = await attioFetch(token, `/objects/${object}/records/query`, {
    method: 'POST',
    body: JSON.stringify({ filter, limit: 10 }),
  });
  return Array.isArray(body?.data) ? body.data : [];
}

async function createRecord(token: string, object: string, values: Record<string, unknown>) {
  const body = await attioFetch(token, `/objects/${object}/records`, {
    method: 'POST',
    body: JSON.stringify({ data: { values } }),
  });
  return body?.data;
}

async function findOrCreateCompany(token: string, companyName: string, email: string) {
  const domain = email.split('@')[1] || '';
  const trustedDomain = domain && !GENERIC_EMAIL_DOMAINS.has(domain) ? domain : '';

  if (trustedDomain) {
    const matches = await queryRecords(token, 'companies', {
      domains: { domain: { $eq: trustedDomain } },
    });
    if (matches.length) return { record: matches[0], created: false, matched_by: 'domain' };
    try {
      const record = await createRecord(token, 'companies', optionalValues({
        domains: [trustedDomain],
        name: companyName,
      }));
      return { record, created: true, matched_by: 'domain' };
    } catch (error) {
      // A concurrent sync may have created the unique domain after our query.
      const retry = await queryRecords(token, 'companies', {
        domains: { domain: { $eq: trustedDomain } },
      });
      if (retry.length) return { record: retry[0], created: false, matched_by: 'domain' };
      throw error;
    }
  }

  if (!companyName) return { record: null, created: false, matched_by: null };
  const matches = await queryRecords(token, 'companies', { name: companyName });
  const exact = matches.filter((record: any) => {
    const names = Array.isArray(record?.values?.name) ? record.values.name : [];
    return names.some((value: any) => normaliseName(value?.value).toLowerCase() === companyName.toLowerCase());
  });
  // A name without a domain is not safe enough to create automatically.
  return exact.length === 1
    ? { record: exact[0], created: false, matched_by: 'exact_name' }
    : { record: null, created: false, matched_by: null };
}

async function findOrCreatePerson(
  token: string,
  personName: string,
  email: string,
  companyRecordId: string,
) {
  if (!email) return { record: null, created: false, matched_by: null };
  const matches = await queryRecords(token, 'people', {
    email_addresses: { email_address: { $eq: email } },
  });
  if (matches.length) return { record: matches[0], created: false, matched_by: 'email' };

  const names = personName.split(' ').filter(Boolean);
  const firstName = names.shift() || '';
  const lastName = names.join(' ');
  const values = optionalValues({
    email_addresses: [email],
    name: personName ? [{ first_name: firstName, last_name: lastName, full_name: personName }] : null,
    company: companyRecordId ? [{
      target_object: 'companies',
      target_record_id: companyRecordId,
    }] : null,
  });
  try {
    const record = await createRecord(token, 'people', values);
    return { record, created: true, matched_by: 'email' };
  } catch (error) {
    const retry = await queryRecords(token, 'people', {
      email_addresses: { email_address: { $eq: email } },
    });
    if (retry.length) return { record: retry[0], created: false, matched_by: 'email' };
    throw error;
  }
}

async function projectAttributes(token: string) {
  const body = await attioFetch(token, '/objects/projects/attributes?limit=200');
  return Array.isArray(body?.data) ? body.data : [];
}

function relationshipSlug(
  attributes: any[],
  target: 'companies' | 'people',
  envOverride: string | undefined,
) {
  if (envOverride && attributes.some(attribute => attribute.api_slug === envOverride)) return envOverride;
  const titlePattern = target === 'companies'
    ? /(company|companies|contractor|organisation|organization)/i
    : /(person|people|contact|contacts)/i;
  return attributes.find(attribute => {
    if (attribute.type !== 'record-reference') return false;
    const relationshipObject = String(attribute?.relationship?.object_slug || '');
    const allowed = attribute?.config?.record_reference?.allowed_object_ids || [];
    return relationshipObject === target
      || allowed.includes(target)
      || titlePattern.test(String(attribute.title || ''));
  })?.api_slug || '';
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
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
  const userEmail = String(userData.user?.email || '').toLowerCase();
  if (userError || !userEmail.endsWith('@gsdecorating.com')) {
    return json({ error: 'Authorised GSD account required' }, 403);
  }

  let leadId = '';
  try {
    leadId = String((await req.json()).lead_id || '');
  } catch {
    return json({ error: 'Invalid request body' }, 400);
  }
  if (!/^[0-9a-f-]{36}$/i.test(leadId)) return json({ error: 'Valid lead_id required' }, 400);

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
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

  try {
    const project = Array.isArray(lead.ccs_projects) ? lead.ccs_projects[0] : lead.ccs_projects;
    const email = normaliseEmail(lead.recipient_email || project?.marker_email);
    const personName = normaliseName(lead.recipient_name || project?.site_manager_name);
    const companyName = normaliseName(lead.company_name || project?.main_contractor);

    const companyResult = await findOrCreateCompany(attioToken, companyName, email);
    const companyId = recordId(companyResult.record);
    const personResult = await findOrCreatePerson(attioToken, personName, email, companyId);
    const personId = recordId(personResult.record);

    const attributes = await projectAttributes(attioToken);
    const available = new Set(attributes.map((attribute: any) => attribute.api_slug));
    const companyAttribute = relationshipSlug(
      attributes,
      'companies',
      Deno.env.get('ATTIO_PROJECT_COMPANY_ATTRIBUTE'),
    );
    const peopleAttribute = relationshipSlug(
      attributes,
      'people',
      Deno.env.get('ATTIO_PROJECT_PEOPLE_ATTRIBUTE'),
    );

    const ccsNumber = canonicalCcsSiteId(lead.project_id);
    const sourceUrl = `https://portal.ccscheme.org.uk/api/searchwebapi/getsiteposterdetails/${ccsNumber}/null`;
    const summary = project?.summary
      || `${lead.project_name} is a CCS-registered construction project in ${project?.local_authority || 'the GSD target area'}.`;
    const candidateValues = optionalValues({
      name: lead.project_name,
      owner: [{
        referenced_actor_type: 'workspace-member',
        referenced_actor_id: ownerId,
      }],
      ccs_site_id: ccsNumber,
      sitefinder_source_url: sourceUrl,
      local_authority: project?.local_authority,
      main_contractor: project?.main_contractor || lead.company_name,
      client_name: project?.client,
      project_address: project?.address,
      site_contact_name: personName,
      site_contact_email: email,
      site_contact_phone: project?.site_manager_phone,
      site_start_date: project?.site_start_date,
      site_end_date: project?.site_end_date,
      project_summary: summary,
      sitefinder_synced_at: new Date().toISOString(),
      [companyAttribute]: companyId ? [{
        target_object: 'companies',
        target_record_id: companyId,
      }] : null,
      [peopleAttribute]: personId ? [{
        target_object: 'people',
        target_record_id: personId,
      }] : null,
    });
    const values = Object.fromEntries(
      Object.entries(candidateValues).filter(([slug]) => available.has(slug)),
    );

    const attioBody = await attioFetch(
      attioToken,
      '/objects/projects/records?matching_attribute=ccs_site_id',
      { method: 'PUT', body: JSON.stringify({ data: { values } }) },
    );
    const projectRecordId = recordId(attioBody?.data);
    if (!projectRecordId) throw new Error('Attio returned no Project record identifier');
    const projectWebUrl = String(attioBody?.data?.web_url || '').trim() || null;
    const syncedAt = new Date().toISOString();
    const { data: persistedLead, error: persistenceError } = await db.from('outreach_leads').update({
      attio_record_id: projectRecordId,
      attio_project_record_id: projectRecordId,
      attio_web_url: projectWebUrl,
      attio_project_url: projectWebUrl,
      attio_company_record_id: companyId || null,
      attio_person_record_id: personId || null,
      attio_synced_at: syncedAt,
      attio_sync_error: null,
      updated_at: syncedAt,
    }).eq('id', lead.id).select('id').maybeSingle();
    if (persistenceError || !persistedLead) {
      throw new Error(
        `Attio Project ${projectRecordId} was written, but SiteFinder could not persist the link: ${
          persistenceError?.message || 'lead row was not updated'
        }`,
      );
    }

    return json({
      ok: true,
      lead_id: lead.id,
      attio_record_id: projectRecordId,
      attio_company_record_id: companyId || null,
      attio_person_record_id: personId || null,
      company_created: companyResult.created,
      person_created: personResult.created,
      company_matched_by: companyResult.matched_by,
      person_matched_by: personResult.matched_by,
      attio_synced_at: syncedAt,
      web_url: projectWebUrl,
      source: SITEFINDER_URL,
    });
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).slice(0, 1000);
    const { error: errorPersistenceError } = await db.from('outreach_leads').update({
      attio_sync_error: message,
      updated_at: new Date().toISOString(),
    }).eq('id', lead.id);
    return json({
      error: message,
      ...(errorPersistenceError
        ? { persistence_error: `Attio error state could not be saved: ${errorPersistenceError.message}` }
        : {}),
    }, 502);
  }
});
