import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.110.7';
import {
  AttioAttribute,
  AttioClient,
  AttioError,
  errorMessage,
  findAttribute,
  optionalValues,
  recordReference,
} from '../_shared/attio.ts';

const SITEFINDER_URL = 'https://gsd-sitefinder.onrender.com';

type JsonRecord = Record<string, unknown>;

const DEAL_ATTRIBUTES = [
  {
    title: 'CCS Site ID',
    api_slug: 'ccs_site_id',
    type: 'text',
    description: 'Stable Considerate Constructors Scheme site identifier.',
    is_unique: true,
  },
  {
    title: 'Open in SiteFinder',
    api_slug: 'sitefinder_url',
    type: 'text',
    description: 'Opens the correct project in GSD SiteFinder.',
  },
  {
    title: 'Attio Project',
    api_slug: 'sitefinder_project_url',
    type: 'text',
    description: 'Opens the source Project record in Attio.',
  },
  {
    title: 'CCS Source',
    api_slug: 'ccs_source_url',
    type: 'text',
    description: 'Verified source record from the Considerate Constructors Scheme.',
  },
  {
    title: 'SiteFinder Synced At',
    api_slug: 'sitefinder_synced_at',
    type: 'timestamp',
    description: 'Last successful SiteFinder update of this deal.',
  },
];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function projectUrl(projectId: string) {
  return `${SITEFINDER_URL}/?project=${encodeURIComponent(projectId)}`;
}

function sourceUrl(projectId: string) {
  return `https://portal.ccscheme.org.uk/api/searchwebapi/getsiteposterdetails/${projectId.replace(/^site/, '')}/null`;
}

function put(
  values: Record<string, unknown>,
  attributes: AttioAttribute[],
  aliases: string[],
  value: unknown,
) {
  if (value === null || value === undefined || value === '') return;
  const attribute = findAttribute(attributes, aliases);
  if (!attribute?.is_writable) return;
  if (attribute.type === 'number') {
    const number = Number(value);
    if (Number.isFinite(number)) values[attribute.api_slug] = number;
  } else if (attribute.type === 'date') {
    values[attribute.api_slug] = String(value).slice(0, 10);
  } else if (attribute.type === 'timestamp') {
    values[attribute.api_slug] = new Date(String(value)).toISOString();
  } else if (['text', 'status', 'select'].includes(attribute.type)) {
    values[attribute.api_slug] = String(value);
  }
}

function putReference(
  values: Record<string, unknown>,
  attributes: AttioAttribute[],
  aliases: string[],
  object: string,
  recordId: string | null,
) {
  if (!recordId) return;
  const attribute = attributes.find(candidate =>
    candidate.type === 'record-reference' && findAttribute([candidate], aliases)
  );
  if (attribute?.is_writable) values[attribute.api_slug] = recordReference(object, recordId);
}

async function ensureDealAttributes(attio: AttioClient, attributes: AttioAttribute[]) {
  const output = [...attributes];
  const warnings: string[] = [];
  for (const definition of DEAL_ATTRIBUTES) {
    if (findAttribute(output, [definition.api_slug, definition.title])) continue;
    try {
      output.push(await attio.createAttribute('deals', definition));
    } catch (error) {
      warnings.push(`Could not create ${definition.title}: ${errorMessage(error)}`);
    }
  }
  return { attributes: output, warnings };
}

async function ensureProjectReference(
  attio: AttioClient,
  attributes: AttioAttribute[],
  projectObject: string,
) {
  const existing = attributes.find(attribute =>
    attribute.type === 'record-reference'
    && findAttribute([attribute], ['sitefinder_project', 'project', 'attio project'])
  );
  if (existing) return { attribute: existing, warning: null };
  try {
    const attribute = await attio.createAttribute('deals', {
      title: 'SiteFinder Project Record',
      api_slug: 'sitefinder_project',
      type: 'record-reference',
      description: 'The source SiteFinder project represented by this deal.',
      config: { record_reference: { allowed_objects: [projectObject] } },
    });
    attributes.push(attribute);
    return { attribute, warning: null };
  } catch (error) {
    return {
      attribute: null,
      warning: `Could not create the Deal to Project relationship: ${errorMessage(error)}`,
    };
  }
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
    leadId = String(((await req.json()) as JsonRecord).lead_id || '');
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

  const { data: projectLink } = await db
    .from('attio_sync_links')
    .select('attio_object_slug,attio_record_id,attio_web_url')
    .eq('entity_type', 'project')
    .eq('source_key', lead.project_id)
    .eq('sync_status', 'synced')
    .maybeSingle();
  if (!projectLink?.attio_record_id) {
    return json({ error: 'Sync this project to Attio before creating its deal' }, 409);
  }

  const [{ data: companyLink }, { data: personLink }, { data: dealLink }] = await Promise.all([
    db.from('attio_sync_links')
      .select('attio_record_id')
      .eq('entity_type', 'company')
      .eq('source_name', lead.company_name || '')
      .eq('sync_status', 'synced')
      .limit(1)
      .maybeSingle(),
    lead.recipient_email
      ? db.from('attio_sync_links')
        .select('attio_record_id')
        .eq('entity_type', 'person')
        .eq('source_key', `email:${String(lead.recipient_email).toLowerCase()}`)
        .eq('sync_status', 'synced')
        .maybeSingle()
      : Promise.resolve({ data: null }),
    db.from('attio_sync_links')
      .select('attio_record_id')
      .eq('entity_type', 'deal')
      .eq('source_key', lead.id)
      .maybeSingle(),
  ]);

  const project = Array.isArray(lead.ccs_projects) ? lead.ccs_projects[0] : lead.ccs_projects;
  const attio = new AttioClient(attioToken);
  try {
    const objects = await attio.listObjects();
    const projectObject = objects.find(object => object.api_slug === projectLink.attio_object_slug);
    if (!projectObject) throw new Error('The linked Attio Project object no longer exists');

    const ensured = await ensureDealAttributes(attio, await attio.listAttributes('deals'));
    const warnings = [...ensured.warnings];
    const ccsAttribute = findAttribute(ensured.attributes, ['ccs_site_id']);
    if (!ccsAttribute?.is_writable) {
      throw new Error('Attio Deals requires a writable CCS Site ID attribute for safe retry handling');
    }
    const projectReference = await ensureProjectReference(
      attio,
      ensured.attributes,
      projectLink.attio_object_slug,
    );
    if (projectReference.warning) warnings.push(projectReference.warning);

    let dealRecordId = dealLink?.attio_record_id || null;
    if (!dealRecordId) {
      const number = lead.project_id.replace(/^site/, '');
      const matchValue = ccsAttribute.type === 'number' ? Number(number) : number;
      let matches = await attio.queryRecords(
        'deals',
        { [ccsAttribute.api_slug]: matchValue },
        2,
      );
      if (!matches.length && ccsAttribute.type !== 'number') {
        matches = await attio.queryRecords(
          'deals',
          { [ccsAttribute.api_slug]: lead.project_id },
          2,
        );
      }
      dealRecordId = matches[0]?.id.record_id || null;
    }

    const values: Record<string, unknown> = {};
    put(values, ensured.attributes, ['name'], lead.project_name);
    put(values, ensured.attributes, ['stage'], 'Lead');
    put(values, ensured.attributes, ['ccs_site_id'], lead.project_id.replace(/^site/, ''));
    put(values, ensured.attributes, ['sitefinder_url'], projectUrl(lead.project_id));
    put(values, ensured.attributes, ['sitefinder_project_url'], projectLink.attio_web_url);
    put(values, ensured.attributes, ['ccs_source_url'], sourceUrl(lead.project_id));
    put(values, ensured.attributes, ['sitefinder_synced_at'], new Date().toISOString());
    put(values, ensured.attributes, ['local_authority'], project?.local_authority);
    put(values, ensured.attributes, ['project_address', 'address'], project?.address);
    put(values, ensured.attributes, ['site_start_date', 'start_date'], project?.site_start_date);
    put(values, ensured.attributes, ['site_end_date', 'end_date'], project?.site_end_date);
    put(values, ensured.attributes, ['project_summary', 'description'], project?.summary);

    const owner = findAttribute(ensured.attributes, ['owner']);
    if (owner?.is_writable) {
      values[owner.api_slug] = [{
        referenced_actor_type: 'workspace-member',
        referenced_actor_id: ownerId,
      }];
    }
    putReference(
      values,
      ensured.attributes,
      ['sitefinder_project', 'project', 'attio project'],
      projectLink.attio_object_slug,
      projectLink.attio_record_id,
    );
    putReference(
      values,
      ensured.attributes,
      ['associated_company', 'company'],
      'companies',
      companyLink?.attio_record_id || null,
    );
    putReference(
      values,
      ensured.attributes,
      ['associated_people', 'people'],
      'people',
      personLink?.attio_record_id || null,
    );

    let record;
    try {
      record = dealRecordId
        ? await attio.updateRecord('deals', dealRecordId, optionalValues(values))
        : await attio.createRecord('deals', optionalValues(values));
    } catch (error) {
      const stage = findAttribute(ensured.attributes, ['stage']);
      if (!(error instanceof AttioError) || !stage || !(stage.api_slug in values)) throw error;
      const withoutStage = { ...values };
      delete withoutStage[stage.api_slug];
      record = dealRecordId
        ? await attio.updateRecord('deals', dealRecordId, optionalValues(withoutStage))
        : await attio.createRecord('deals', optionalValues(withoutStage));
    }

    const syncedAt = new Date().toISOString();
    const { error: linkError } = await db.from('attio_sync_links').upsert({
      entity_type: 'deal',
      source_key: lead.id,
      source_name: lead.project_name,
      project_id: lead.project_id,
      attio_object_slug: 'deals',
      attio_record_id: record.id.record_id,
      attio_web_url: record.web_url || null,
      sitefinder_url: projectUrl(lead.project_id),
      sync_status: 'synced',
      sync_error: null,
      last_attempted_at: syncedAt,
      synced_at: syncedAt,
      updated_at: syncedAt,
    }, { onConflict: 'entity_type,source_key' });
    if (linkError) throw linkError;

    const { error: updateError } = await db.from('outreach_leads').update({
      attio_record_id: record.id.record_id,
      attio_web_url: record.web_url || null,
      attio_project_record_id: projectLink.attio_record_id,
      attio_project_url: projectLink.attio_web_url || null,
      attio_synced_at: syncedAt,
      attio_sync_error: null,
      updated_at: syncedAt,
    }).eq('id', lead.id);
    if (updateError) throw updateError;

    return json({
      ok: true,
      lead_id: lead.id,
      attio_record_id: record.id.record_id,
      attio_synced_at: syncedAt,
      web_url: record.web_url || null,
      project_web_url: projectLink.attio_web_url || null,
      warnings,
    });
  } catch (error) {
    const message = errorMessage(error);
    await db.from('outreach_leads').update({
      attio_sync_error: message,
      updated_at: new Date().toISOString(),
    }).eq('id', lead.id);
    return json({ error: message }, 502);
  }
});
