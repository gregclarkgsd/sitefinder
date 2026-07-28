import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.110.7';
import {
  AttioAttribute,
  AttioClient,
  AttioError,
  AttioRecord,
  errorMessage,
  findAttribute,
  normaliseSlug,
  optionalValues,
  recordReference,
} from '../_shared/attio.ts';
import { safeBoolean, safeBooleanWithFallback } from '../_shared/values.ts';

const SITEFINDER_URL = 'https://gsd-sitefinder.onrender.com';
const MAX_BATCH_SIZE = 25;

type JsonRecord = Record<string, unknown>;
type DbClient = any;

type Enrichment = {
  programme_stage?: string | null;
  gsd_timing?: string | null;
  months_remaining?: number | null;
  map_url?: string | null;
  ccs_rating?: string | null;
  complaints_count?: number | null;
  registration_count?: number | null;
  has_alerts?: boolean | null;
  has_news?: boolean | null;
  is_ultra_site?: boolean | null;
  sector?: string | null;
  work_type?: string | null;
  fit_out_state?: string | null;
  new_build_housing_state?: string | null;
  classification_confidence?: number | null;
  classification_evidence?: string[] | null;
  classification_sources?: unknown;
  classification_method?: string | null;
  researched_at?: string | null;
};

type ProjectRow = {
  project_id: string;
  project_name: string;
  main_contractor: string | null;
  client: string | null;
  local_authority: string | null;
  latitude: number | null;
  longitude: number | null;
  first_seen_at: string;
  last_seen_at: string;
  last_changed_at: string;
  is_active: boolean;
  source_data: JsonRecord;
  address: string | null;
  site_manager_name: string | null;
  site_manager_job_title: string | null;
  site_manager_phone: string | null;
  marker_email: string | null;
  site_start_date: string | null;
  site_end_date: string | null;
  site_closed: boolean | null;
  summary: string | null;
  last_visit_date: string | null;
  detail_data: JsonRecord | null;
  ccs_project_enrichment?: Enrichment | Enrichment[] | null;
};

type LinkRow = {
  attio_record_id: string | null;
  attio_web_url: string | null;
};

type AttributeDefinition = {
  title: string;
  api_slug: string;
  type: string;
  description: string;
  is_unique?: boolean;
  is_multiselect?: boolean;
  config?: Record<string, unknown>;
  relationship?: Record<string, unknown>;
  aliases?: string[];
};

const PROJECT_ATTRIBUTES: AttributeDefinition[] = [
  {
    title: 'CCS Site ID',
    api_slug: 'ccs_site_id',
    type: 'text',
    description: 'Stable Considerate Constructors Scheme site identifier.',
    aliases: ['ccs id', 'ccs number'],
  },
  {
    title: 'Open in SiteFinder',
    api_slug: 'sitefinder_url',
    type: 'text',
    description: 'Opens this exact project in GSD SiteFinder.',
    aliases: ['sitefinder link', 'sitefinder project'],
  },
  {
    title: 'Map',
    api_slug: 'map_url',
    type: 'text',
    description: 'Opens the published CCS coordinates in Google Maps.',
    aliases: ['google maps', 'map link'],
  },
  {
    title: 'GSD Timing',
    api_slug: 'gsd_timing',
    type: 'text',
    description: 'Deterministic sales timing derived from the CCS project end date.',
  },
  {
    title: 'Programme Stage',
    api_slug: 'programme_stage',
    type: 'text',
    description: 'Early, mid, late, closed or unknown based on the CCS programme dates.',
  },
  {
    title: 'Site Manager Job Title',
    api_slug: 'site_manager_job_title',
    type: 'text',
    description: 'Job title published on the CCS record.',
  },
  {
    title: 'Site Contact Email',
    api_slug: 'site_contact_email',
    type: 'text',
    description: 'Contact email published on the CCS record.',
  },
  {
    title: 'Site Contact Phone',
    api_slug: 'site_contact_phone',
    type: 'text',
    description: 'Contact telephone number published on the CCS record.',
  },
  {
    title: 'CCS Source',
    api_slug: 'ccs_source_url',
    type: 'text',
    description: 'Verified source record from the Considerate Constructors Scheme.',
    aliases: ['sitefinder_source_url'],
  },
  {
    title: 'Project Summary',
    api_slug: 'project_summary',
    type: 'text',
    description: 'Published CCS summary or source-honest SiteFinder fallback.',
    aliases: ['summary'],
  },
  {
    title: 'CCS Rating',
    api_slug: 'ccs_rating',
    type: 'text',
    description: 'CCS performance level when published.',
  },
  {
    title: 'Complaints',
    api_slug: 'complaints_count',
    type: 'number',
    description: 'Number of complaints published on the CCS record.',
  },
  {
    title: 'CCS Registrations',
    api_slug: 'registration_count',
    type: 'number',
    description: 'Number of registrations associated with the CCS site.',
  },
  {
    title: 'Fit Out',
    api_slug: 'fit_out_state',
    type: 'text',
    description: 'Yes, no or unknown. Unknown is retained when the source does not prove it.',
  },
  {
    title: 'New Build Housing',
    api_slug: 'new_build_housing_state',
    type: 'text',
    description: 'Yes, no or unknown. Unknown is retained when the source does not prove it.',
  },
  {
    title: 'Sector',
    api_slug: 'sector',
    type: 'text',
    description: 'Evidence-backed project sector; blank when it cannot be established.',
  },
  {
    title: 'Work Type',
    api_slug: 'work_type',
    type: 'text',
    description: 'Evidence-backed work type; blank when it cannot be established.',
  },
  {
    title: 'Classification Confidence',
    api_slug: 'classification_confidence',
    type: 'number',
    description: 'Confidence from 0 to 1 for the source-backed classification.',
  },
  {
    title: 'Classification Evidence',
    api_slug: 'classification_evidence',
    type: 'text',
    description: 'Short evidence explaining the project classification.',
  },
  {
    title: 'CCS Has Alerts',
    api_slug: 'has_ccs_alerts',
    type: 'checkbox',
    description: 'Whether CCS publishes alerts for the site.',
  },
  {
    title: 'CCS Has News',
    api_slug: 'has_ccs_news',
    type: 'checkbox',
    description: 'Whether CCS publishes news for the site.',
  },
  {
    title: 'CCS Ultra Site',
    api_slug: 'is_ultra_site',
    type: 'checkbox',
    description: 'Whether the CCS record identifies this as an Ultra Site.',
  },
  {
    title: 'Last Refreshed',
    api_slug: 'last_refreshed',
    type: 'timestamp',
    description: 'Last successful SiteFinder to Attio refresh.',
    aliases: ['sitefinder_synced_at'],
  },
];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': SITEFINDER_URL,
      'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-sync-token',
    },
  });
}

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] || null;
  return value || null;
}

function ccsNumber(projectId: string) {
  return projectId.replace(/^site/, '');
}

function sitefinderProjectUrl(projectId: string) {
  return `${SITEFINDER_URL}/?project=${encodeURIComponent(projectId)}`;
}

function ccsSourceUrl(projectId: string) {
  return `https://portal.ccscheme.org.uk/api/searchwebapi/getsiteposterdetails/${ccsNumber(projectId)}/null`;
}

function timingLabel(value: string | null | undefined) {
  return ({
    completing_0_3m: 'Completing 0–3 months',
    decorating_3_9m: 'Decorating 3–9 months',
    monitor_9_18m: 'Monitor 9–18 months',
    early_over_18m: 'Early >18 months',
    overdue: 'Past end date',
    unknown: 'Unknown',
  } as Record<string, string>)[value || 'unknown'] || 'Unknown';
}

function programmeLabel(value: string | null | undefined) {
  return ({
    early: 'Early',
    mid: 'Mid',
    late: 'Late',
    closed: 'Closed',
    unknown: 'Unknown',
  } as Record<string, string>)[value || 'unknown'] || 'Unknown';
}

function splitName(fullName: string | null) {
  const clean = String(fullName || '').trim();
  if (!clean) return null;
  const parts = clean.split(/\s+/);
  return {
    first_name: parts[0],
    last_name: parts.slice(1).join(' '),
    full_name: clean,
  };
}

function safeNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function deriveEnrichment(project: ProjectRow): Enrichment {
  const existing = firstRelation(project.ccs_project_enrichment) || {};
  const start = project.site_start_date ? new Date(`${project.site_start_date}T00:00:00Z`) : null;
  const end = project.site_end_date ? new Date(`${project.site_end_date}T00:00:00Z`) : null;
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const monthsRemaining = end
    ? Math.round((end.getTime() - today.getTime()) / (30.4375 * 86_400_000))
    : null;

  let programmeStage = 'unknown';
  if (project.site_closed || (end && end < today)) programmeStage = 'closed';
  else if (start && end && end > start) {
    if (today <= start) programmeStage = 'early';
    else {
      const progress = (today.getTime() - start.getTime()) / (end.getTime() - start.getTime());
      programmeStage = progress < 0.33 ? 'early' : progress < 0.67 ? 'mid' : 'late';
    }
  }

  let gsdTiming = 'unknown';
  if (end) {
    if (end < today) gsdTiming = 'overdue';
    else if (monthsRemaining !== null && monthsRemaining <= 3) gsdTiming = 'completing_0_3m';
    else if (monthsRemaining !== null && monthsRemaining <= 9) gsdTiming = 'decorating_3_9m';
    else if (monthsRemaining !== null && monthsRemaining <= 18) gsdTiming = 'monitor_9_18m';
    else gsdTiming = 'early_over_18m';
  }

  const details = project.detail_data || {};
  const registrationValue = details.AllRegistrations;
  const mapUrl = project.latitude === null || project.longitude === null
    ? null
    : `https://www.google.com/maps/search/?api=1&query=${project.latitude},${project.longitude}`;

  return {
    ...existing,
    programme_stage: programmeStage,
    gsd_timing: gsdTiming,
    months_remaining: monthsRemaining,
    map_url: mapUrl,
    ccs_rating: String(details.PerformanceLevel || existing.ccs_rating || '').trim() || null,
    complaints_count: safeNumber(details.NumberOfComplaints) ?? existing.complaints_count ?? null,
    registration_count: Array.isArray(registrationValue)
      ? registrationValue.length
      : existing.registration_count ?? null,
    has_alerts: safeBoolean(details.Alerts),
    has_news: safeBoolean(details.News),
    is_ultra_site: safeBooleanWithFallback(details.UltraSite, project.source_data?.UltraSite),
    classification_method: existing.classification_method || 'ccs_deterministic_v1',
  };
}

async function digest(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function ensureProjectAttributes(
  attio: AttioClient,
  object: string,
  current: AttioAttribute[],
) {
  const attributes = [...current];
  const warnings: string[] = [];
  for (const definition of PROJECT_ATTRIBUTES) {
    if (findAttribute(attributes, [definition.api_slug, definition.title, ...(definition.aliases || [])])) {
      continue;
    }
    try {
      const { aliases: _aliases, ...apiDefinition } = definition;
      attributes.push(await attio.createAttribute(object, apiDefinition));
    } catch (error) {
      warnings.push(`Could not create ${definition.title}: ${errorMessage(error)}`);
    }
  }
  return { attributes, warnings };
}

async function ensureReferenceAttribute(
  attio: AttioClient,
  object: string,
  attributes: AttioAttribute[],
  definition: AttributeDefinition,
  allowedObject: string,
) {
  const existing = findAttribute(
    attributes,
    [definition.api_slug, definition.title, ...(definition.aliases || [])],
  );
  if (existing?.type === 'record-reference') return { attribute: existing, warning: null };
  try {
    const { aliases: _aliases, ...apiDefinition } = definition;
    const attribute = await attio.createAttribute(object, {
      ...apiDefinition,
      type: 'record-reference',
      config: { record_reference: { allowed_objects: [allowedObject] } },
    });
    attributes.push(attribute);
    return { attribute, warning: null };
  } catch (error) {
    return { attribute: null, warning: `Could not create ${definition.title}: ${errorMessage(error)}` };
  }
}

async function ensureProjectStatuses(
  attio: AttioClient,
  object: string,
  attributes: AttioAttribute[],
) {
  const stage = findAttribute(attributes, ['stage']);
  if (!stage || stage.type !== 'status') return [];
  const warnings: string[] = [];
  try {
    const current = await attio.listStatuses(object, stage.api_slug);
    const titles = new Set(current.map(status => status.title.toLowerCase()));
    for (const title of [
      'Completing 0–3 months',
      'Decorating 3–9 months',
      'Monitor 9–18 months',
      'Early >18 months',
      'Past end date',
      'Unknown',
    ]) {
      if (!titles.has(title.toLowerCase())) {
        await attio.createStatus(object, stage.api_slug, title);
      }
    }
  } catch (error) {
    warnings.push(`Could not prepare honest Project stages: ${errorMessage(error)}`);
  }
  return warnings;
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
    const number = safeNumber(value);
    if (number !== null) values[attribute.api_slug] = number;
    return;
  }
  if (attribute.type === 'checkbox') {
    values[attribute.api_slug] = Boolean(value);
    return;
  }
  if (attribute.type === 'date') {
    values[attribute.api_slug] = String(value).slice(0, 10);
    return;
  }
  if (attribute.type === 'timestamp') {
    values[attribute.api_slug] = new Date(String(value)).toISOString();
    return;
  }
  if (attribute.type === 'text' || attribute.type === 'status' || attribute.type === 'select') {
    values[attribute.api_slug] = String(value);
  }
}

function putReference(
  values: Record<string, unknown>,
  attributes: AttioAttribute[],
  aliases: string[],
  targetObject: string,
  targetRecordId: string | null,
  textFallback: string | null,
) {
  const matching = attributes.filter(attribute => findAttribute([attribute], aliases));
  const attribute = matching.find(candidate => candidate.type === 'record-reference')
    || matching.find(candidate => candidate.type === 'text');
  if (!attribute?.is_writable) return;
  if (attribute.type === 'record-reference' && targetRecordId) {
    values[attribute.api_slug] = recordReference(targetObject, targetRecordId);
  } else if (attribute.type === 'text' && textFallback) {
    values[attribute.api_slug] = textFallback;
  }
}

async function ensureSelectValues(
  attio: AttioClient,
  object: string,
  attributes: AttioAttribute[],
  values: Record<string, unknown>,
) {
  for (const attribute of attributes) {
    if (attribute.type !== 'select' || !(attribute.api_slug in values)) continue;
    const requested = String(values[attribute.api_slug] || '').trim();
    if (!requested) continue;
    const options = await attio.listSelectOptions(object, attribute.api_slug);
    const existing = options.find(option => option.title.toLowerCase() === requested.toLowerCase());
    if (existing) {
      values[attribute.api_slug] = existing.title;
    } else {
      const created = await attio.createSelectOption(object, attribute.api_slug, requested);
      values[attribute.api_slug] = created.title;
    }
  }
}

async function findLink(
  db: DbClient,
  entityType: string,
  sourceKey: string,
) {
  const { data } = await db
    .from('attio_sync_links')
    .select('attio_record_id,attio_web_url')
    .eq('entity_type', entityType)
    .eq('source_key', sourceKey)
    .maybeSingle();
  return data as LinkRow | null;
}

async function saveLink(
  db: DbClient,
  input: {
    entityType: string;
    sourceKey: string;
    sourceName?: string | null;
    projectId?: string | null;
    objectSlug: string;
    recordId?: string | null;
    webUrl?: string | null;
    sitefinderUrl?: string | null;
    sourceHash?: string | null;
    status: 'synced' | 'error';
    error?: string | null;
  },
) {
  const now = new Date().toISOString();
  const { data: existing } = input.status === 'error'
    ? await db.from('attio_sync_links')
      .select('project_id,attio_record_id,attio_web_url,source_hash,synced_at')
      .eq('entity_type', input.entityType)
      .eq('source_key', input.sourceKey)
      .maybeSingle()
    : { data: null };
  const { error } = await db.from('attio_sync_links').upsert({
    entity_type: input.entityType,
    source_key: input.sourceKey,
    source_name: input.sourceName || null,
    project_id: input.projectId ?? existing?.project_id ?? null,
    attio_object_slug: input.objectSlug,
    attio_record_id: input.recordId ?? existing?.attio_record_id ?? null,
    attio_web_url: input.webUrl ?? existing?.attio_web_url ?? null,
    sitefinder_url: input.sitefinderUrl || null,
    source_hash: input.sourceHash ?? existing?.source_hash ?? null,
    sync_status: input.status,
    sync_error: input.error || null,
    last_attempted_at: now,
    synced_at: input.status === 'synced' ? now : existing?.synced_at ?? null,
    updated_at: now,
  }, { onConflict: 'entity_type,source_key' });
  if (error) throw error;
}

async function resolveCompany(
  db: DbClient,
  attio: AttioClient,
  project: ProjectRow,
  name: string | null,
  sourceId: unknown,
) {
  const cleanName = String(name || '').trim();
  if (!cleanName) return null;
  const sourceKey = sourceId
    ? `ccs-company:${String(sourceId)}`
    : `company-name:${normaliseSlug(cleanName)}`;
  const mapped = await findLink(db, 'company', sourceKey);
  if (mapped?.attio_record_id) return mapped;

  const existing = await attio.queryRecords('companies', { name: cleanName }, 2);
  const record = existing[0] || await attio.createRecord('companies', { name: cleanName });
  await saveLink(db, {
    entityType: 'company',
    sourceKey,
    sourceName: cleanName,
    projectId: null,
    objectSlug: 'companies',
    recordId: record.id.record_id,
    webUrl: record.web_url,
    sitefinderUrl: sitefinderProjectUrl(project.project_id),
    status: 'synced',
  });
  return { attio_record_id: record.id.record_id, attio_web_url: record.web_url || null };
}

async function resolvePerson(
  db: DbClient,
  attio: AttioClient,
  project: ProjectRow,
  companyRecordId: string | null,
) {
  const email = String(project.marker_email || '').trim().toLowerCase();
  if (!email) return null;
  const sourceKey = `email:${email}`;
  const mapped = await findLink(db, 'person', sourceKey);
  if (mapped?.attio_record_id) return mapped;

  const personValues: Record<string, unknown> = { email_addresses: [email] };
  const name = splitName(project.site_manager_name);
  if (name) personValues.name = name;
  if (companyRecordId) personValues.company = recordReference('companies', companyRecordId);

  const record = await attio.assertRecord('people', 'email_addresses', personValues);
  await saveLink(db, {
    entityType: 'person',
    sourceKey,
    sourceName: project.site_manager_name || email,
    projectId: null,
    objectSlug: 'people',
    recordId: record.id.record_id,
    webUrl: record.web_url,
    sitefinderUrl: sitefinderProjectUrl(project.project_id),
    status: 'synced',
  });
  return { attio_record_id: record.id.record_id, attio_web_url: record.web_url || null };
}

async function findProjectRecord(
  attio: AttioClient,
  object: string,
  attribute: AttioAttribute,
  projectId: string,
) {
  const number = ccsNumber(projectId);
  const primaryValue = attribute.type === 'number' ? Number(number) : number;
  let records = await attio.queryRecords(object, { [attribute.api_slug]: primaryValue }, 2);
  if (!records.length && attribute.type !== 'number') {
    records = await attio.queryRecords(object, { [attribute.api_slug]: projectId }, 2);
  }
  return records[0] || null;
}

async function upsertProjectRecord(
  attio: AttioClient,
  object: string,
  project: ProjectRow,
  enrichment: Enrichment,
  attributes: AttioAttribute[],
  contractor: LinkRow | null,
  client: LinkRow | null,
  person: LinkRow | null,
) {
  const values: Record<string, unknown> = {};
  put(values, attributes, ['name', 'project'], project.project_name);
  put(values, attributes, ['ccs_site_id', 'ccs id', 'ccs number'], ccsNumber(project.project_id));
  put(values, attributes, ['stage'], timingLabel(enrichment.gsd_timing));
  put(values, attributes, ['gsd_timing'], timingLabel(enrichment.gsd_timing));
  put(values, attributes, ['programme_stage'], programmeLabel(enrichment.programme_stage));
  put(values, attributes, ['months_remaining', 'months remaining'], enrichment.months_remaining);
  put(values, attributes, ['start_date', 'site_start_date'], project.site_start_date);
  put(values, attributes, ['end_date', 'site_end_date'], project.site_end_date);
  put(values, attributes, ['address', 'project_address'], project.address);
  put(values, attributes, ['local_authority'], project.local_authority);
  put(values, attributes, ['site_closed'], project.site_closed);
  put(values, attributes, ['first_seen'], project.first_seen_at);
  put(values, attributes, ['last_seen'], project.last_seen_at);
  put(values, attributes, ['last_visit_date'], project.last_visit_date);
  put(values, attributes, ['last_refreshed', 'sitefinder_synced_at'], new Date().toISOString());
  put(values, attributes, ['sitefinder_url', 'sitefinder link'], sitefinderProjectUrl(project.project_id));
  put(values, attributes, ['map_url', 'map link', 'google maps'], enrichment.map_url);
  put(values, attributes, ['ccs_source_url', 'sitefinder_source_url'], ccsSourceUrl(project.project_id));
  put(values, attributes, ['project_summary', 'summary'], project.summary);
  put(values, attributes, ['site_manager_job_title'], project.site_manager_job_title);
  put(values, attributes, ['site_contact_email'], project.marker_email);
  put(values, attributes, ['site_contact_phone'], project.site_manager_phone);
  put(values, attributes, ['ccs_rating'], enrichment.ccs_rating);
  put(values, attributes, ['complaints_count'], enrichment.complaints_count);
  put(values, attributes, ['registration_count'], enrichment.registration_count);
  put(values, attributes, ['has_ccs_alerts'], enrichment.has_alerts);
  put(values, attributes, ['has_ccs_news'], enrichment.has_news);
  put(values, attributes, ['is_ultra_site'], enrichment.is_ultra_site);
  put(values, attributes, ['sector'], enrichment.sector);
  put(values, attributes, ['work_type'], enrichment.work_type);
  put(values, attributes, ['fit_out_state'], enrichment.fit_out_state || 'unknown');
  put(values, attributes, ['new_build_housing_state'], enrichment.new_build_housing_state || 'unknown');
  put(values, attributes, ['classification_confidence'], enrichment.classification_confidence);
  put(
    values,
    attributes,
    ['classification_evidence'],
    (enrichment.classification_evidence || []).join(' · '),
  );

  putReference(
    values,
    attributes,
    ['main_contractor', 'main contractor', 'sitefinder_main_contractor'],
    'companies',
    contractor?.attio_record_id || null,
    project.main_contractor,
  );
  putReference(
    values,
    attributes,
    ['client', 'client_name', 'sitefinder_client'],
    'companies',
    client?.attio_record_id || null,
    project.client,
  );
  putReference(
    values,
    attributes,
    ['site_contacts', 'site_contact', 'sitefinder_contacts'],
    'people',
    person?.attio_record_id || null,
    project.site_manager_name,
  );

  const idAttribute = findAttribute(attributes, ['ccs_site_id', 'ccs id', 'ccs number']);
  if (!idAttribute) throw new Error('Projects object has no CCS Site ID attribute');
  await ensureSelectValues(attio, object, attributes, values);
  const existing = await findProjectRecord(attio, object, idAttribute, project.project_id);

  try {
    return existing
      ? await attio.updateRecord(object, existing.id.record_id, optionalValues(values))
      : await attio.createRecord(object, optionalValues(values));
  } catch (error) {
    const stageAttribute = findAttribute(attributes, ['stage']);
    if (!(error instanceof AttioError) || !stageAttribute || !(stageAttribute.api_slug in values)) {
      throw error;
    }
    const withoutStage = { ...values };
    delete withoutStage[stageAttribute.api_slug];
    return existing
      ? await attio.updateRecord(object, existing.id.record_id, optionalValues(withoutStage))
      : await attio.createRecord(object, optionalValues(withoutStage));
  }
}

async function syncProject(
  db: DbClient,
  attio: AttioClient,
  projectObject: string,
  attributes: AttioAttribute[],
  project: ProjectRow,
) {
  const enrichment = deriveEnrichment(project);
  const detail = project.detail_data || {};
  const contractor = await resolveCompany(
    db,
    attio,
    project,
    project.main_contractor,
    project.source_data?.MainContractorId,
  );
  const client = await resolveCompany(
    db,
    attio,
    project,
    project.client,
    project.source_data?.ClientId,
  );
  const person = await resolvePerson(
    db,
    attio,
    project,
    contractor?.attio_record_id || null,
  );

  const sourceHash = await digest({
    project: {
      project_id: project.project_id,
      project_name: project.project_name,
      main_contractor: project.main_contractor,
      client: project.client,
      local_authority: project.local_authority,
      address: project.address,
      site_manager_name: project.site_manager_name,
      site_manager_job_title: project.site_manager_job_title,
      site_manager_phone: project.site_manager_phone,
      marker_email: project.marker_email,
      site_start_date: project.site_start_date,
      site_end_date: project.site_end_date,
      site_closed: project.site_closed,
      summary: project.summary,
      last_visit_date: project.last_visit_date,
    },
    ccs: {
      performance: detail.PerformanceLevel,
      complaints: detail.NumberOfComplaints,
      registrations: detail.AllRegistrations,
      alerts: detail.Alerts,
      news: detail.News,
      ultraSite: detail.UltraSite,
    },
    enrichment,
  });

  const record = await upsertProjectRecord(
    attio,
    projectObject,
    project,
    enrichment,
    attributes,
    contractor,
    client,
    person,
  );
  await saveLink(db, {
    entityType: 'project',
    sourceKey: project.project_id,
    sourceName: project.project_name,
    projectId: project.project_id,
    objectSlug: projectObject,
    recordId: record.id.record_id,
    webUrl: record.web_url,
    sitefinderUrl: sitefinderProjectUrl(project.project_id),
    sourceHash,
    status: 'synced',
  });

  const now = new Date().toISOString();
  const { error: enrichmentError } = await db.from('ccs_project_enrichment').upsert({
    project_id: project.project_id,
    ...enrichment,
    updated_at: now,
  }, { onConflict: 'project_id' });
  if (enrichmentError) throw enrichmentError;

  return record;
}

async function loadProjects(
  db: DbClient,
  body: JsonRecord,
) {
  const requestedIds = Array.isArray(body.project_ids)
    ? body.project_ids.map(value => String(value)).filter(value => /^site\d+$/.test(value)).slice(0, MAX_BATCH_SIZE)
    : [];
  let query = db.from('ccs_projects').select(`
    project_id, project_name, main_contractor, client, local_authority,
    latitude, longitude, first_seen_at, last_seen_at, last_changed_at,
    is_active, source_data, address, site_manager_name, site_manager_job_title,
    site_manager_phone, marker_email, site_start_date, site_end_date, site_closed,
    summary, last_visit_date, detail_data,
    ccs_project_enrichment (*)
  `).order('project_id');

  if (requestedIds.length) {
    query = query.in('project_id', requestedIds);
  } else {
    const offset = Math.max(0, Number(body.offset) || 0);
    const limit = Math.min(MAX_BATCH_SIZE, Math.max(1, Number(body.limit) || 10));
    query = query.range(offset, offset + limit - 1);
  }
  const { data, error } = await query;
  if (error) throw error;
  return data as ProjectRow[];
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return json({ ok: true });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const attioToken = Deno.env.get('ATTIO_ACCESS_TOKEN');
  const syncToken = Deno.env.get('CCS_SYNC_TOKEN');
  if (!supabaseUrl || !anonKey || !serviceKey || !attioToken || !syncToken) {
    return json({ error: 'SiteFinder Attio sync is not fully configured' }, 503);
  }

  const internalRequest = req.headers.get('x-sync-token') === syncToken;
  if (!internalRequest) {
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
  }

  let body: JsonRecord;
  try {
    body = await req.json() as JsonRecord;
  } catch {
    return json({ error: 'Invalid request body' }, 400);
  }

  const action = String(body.action || 'sync');
  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const attio = new AttioClient(attioToken);

  try {
    const objects = await attio.listObjects();
    const projectObject = objects.find(object =>
      object.api_slug === 'projects'
      || normaliseSlug(object.singular_noun) === 'project'
      || normaliseSlug(object.plural_noun) === 'projects'
    )?.api_slug;
    if (!projectObject) throw new Error('Attio Projects object was not found');

    const initialAttributes = await attio.listAttributes(projectObject);
    if (action === 'inspect') {
      return json({
        ok: true,
        project_object: projectObject,
        objects: objects.map(object => ({
          api_slug: object.api_slug,
          singular_noun: object.singular_noun,
          plural_noun: object.plural_noun,
        })),
        project_attributes: initialAttributes.map(attribute => ({
          title: attribute.title,
          api_slug: attribute.api_slug,
          type: attribute.type,
          is_writable: attribute.is_writable,
          is_multiselect: attribute.is_multiselect,
          has_relationship: Boolean((attribute as { relationship?: unknown }).relationship),
        })),
      });
    }
    if (action !== 'sync') return json({ error: 'Unknown action' }, 400);

    const ensured = await ensureProjectAttributes(attio, projectObject, initialAttributes);
    const warnings = [...ensured.warnings];
    const attributes = ensured.attributes;
    warnings.push(...await ensureProjectStatuses(attio, projectObject, attributes));

    const contractorReference = await ensureReferenceAttribute(
      attio,
      projectObject,
      attributes,
      {
        title: 'Main Contractor Company',
        api_slug: 'sitefinder_main_contractor',
        type: 'record-reference',
        description: 'Attio company delivering the project.',
        aliases: ['main_contractor'],
      },
      'companies',
    );
    if (contractorReference.warning) warnings.push(contractorReference.warning);

    const clientReference = await ensureReferenceAttribute(
      attio,
      projectObject,
      attributes,
      {
        title: 'Client Company',
        api_slug: 'sitefinder_client',
        type: 'record-reference',
        description: 'Attio company commissioning the project.',
        aliases: ['client', 'client_name'],
      },
      'companies',
    );
    if (clientReference.warning) warnings.push(clientReference.warning);

    const contactReference = await ensureReferenceAttribute(
      attio,
      projectObject,
      attributes,
      {
        title: 'Site Contact Records',
        api_slug: 'sitefinder_contacts',
        type: 'record-reference',
        description: 'People published as contacts for this CCS site.',
        is_multiselect: true,
        aliases: ['site_contacts', 'site_contact'],
      },
      'people',
    );
    if (contactReference.warning) warnings.push(contactReference.warning);

    const projects = await loadProjects(db, body);
    let synced = 0;
    const failures: Array<{ project_id: string; error: string }> = [];
    for (const project of projects) {
      try {
        await syncProject(db, attio, projectObject, attributes, project);
        synced++;
      } catch (error) {
        const message = errorMessage(error);
        failures.push({ project_id: project.project_id, error: message });
        await saveLink(db, {
          entityType: 'project',
          sourceKey: project.project_id,
          sourceName: project.project_name,
          projectId: project.project_id,
          objectSlug: projectObject,
          sitefinderUrl: sitefinderProjectUrl(project.project_id),
          status: 'error',
          error: message,
        }).catch(() => undefined);
      }
    }

    const offset = Math.max(0, Number(body.offset) || 0);
    return json({
      ok: failures.length === 0,
      project_object: projectObject,
      requested: projects.length,
      synced,
      failed: failures.length,
      failures,
      warnings,
      next_offset: Array.isArray(body.project_ids) ? null : offset + projects.length,
      complete: projects.length < Math.min(MAX_BATCH_SIZE, Math.max(1, Number(body.limit) || 10)),
    }, failures.length ? 207 : 200);
  } catch (error) {
    return json({ error: errorMessage(error) }, 500);
  }
});
