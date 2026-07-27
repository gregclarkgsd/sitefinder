import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.110.7';

const MARKERS = 'https://ccsfilestore.blob.core.windows.net/constructionmap/live/json/sitemarkers.json';
const DETAILS = 'https://portal.ccscheme.org.uk/api/searchwebapi/getsiteposterdetails';
const TARGET_AUTHORITY = /London Borough|City of London|Westminster|Royal Borough of (Greenwich|Kensington and Chelsea)|Essex|Kent|Surrey|Hertfordshire|Berkshire|Buckinghamshire|Hampshire|Sussex|Oxfordshire|Bedfordshire|Harlow|Canterbury|Sevenoaks|Elmbridge|Wealden|Arun|Winchester|Oxford City|Luton|Dacorum|Watford|St Albans|Three Rivers|Welwyn|Stevenage|Broxbourne|Basildon|Braintree|Brentwood|Castle Point|Chelmsford|Colchester|Epping Forest|Maldon|Rochford|Southend|Thurrock|Ashford|Dartford|Dover|Folkestone|Gravesham|Maidstone|Medway|Swale|Thanet|Tonbridge|Tunbridge|Epsom|Guildford|Mole Valley|Reigate|Runnymede|Spelthorne|Tandridge|Waverley|Woking|Bracknell|Reading|Slough|Windsor|Wokingham|Milton Keynes|Basingstoke|Eastleigh|Fareham|Gosport|Hart District|Havant|New Forest|Portsmouth|Rushmoor|Southampton|Test Valley|Brighton|Chichester|Crawley|Horsham|Lewes|Mid Sussex|Rother|Worthing|Adur|Cherwell|West Oxfordshire|Vale of White Horse|Bedford Borough|Central Bedfordshire/i;
const DETAIL_CONCURRENCY = 12;

type JsonRecord = Record<string, unknown>;

async function digest(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

function markerFields(project: JsonRecord) {
  return {
    name: project.Name,
    contractor: project.MainContractor,
    client: project.Client,
    authority: project.LaId,
    latitude: project.Latitude,
    longitude: project.Longitude,
  };
}

function detailFields(detail: JsonRecord) {
  return {
    address: detail.Address,
    contractor: detail.MainContractor,
    client: detail.Client,
    authority: detail.LocalAuthority,
    managerFirstName: detail.SiteManagerFirstName,
    managerLastName: detail.SiteManagerLastName,
    managerJobTitle: detail.SiteManagerJobTitle,
    managerPhone: detail.SiteManagerPhone,
    email: detail.MarkerEmail,
    startDate: detail.SiteStartDate,
    endDate: detail.SiteEndDate,
    closed: detail.SiteClosed,
    summary: detail.Summary,
    contractorText: detail.ContractorText,
    lastVisitDate: detail.LastVisitDate,
    performanceLevel: detail.PerformanceLevel,
  };
}

async function fetchDetail(projectId: string) {
  const id = projectId.replace(/^site/, '');
  const response = await fetch(`${DETAILS}/${id}/null`, { signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error(`Detail ${id} returned ${response.status}`);
  return await response.json() as JsonRecord;
}

async function concurrentMap<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

async function fetchExistingProjects(db: ReturnType<typeof createClient>) {
  const rows = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db
      .from('ccs_projects')
      .select('project_id,payload_hash,detail_hash,first_seen_at,discovered_after_baseline,last_changed_at,detail_last_checked_at,detail_data')
      .range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) return rows;
  }
}

Deno.serve(async request => {
  if (request.headers.get('x-sync-token') !== Deno.env.get('CCS_SYNC_TOKEN')) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );
  const { data: run, error: runError } = await db
    .from('ccs_sync_runs')
    .insert({ status: 'running' })
    .select('id')
    .single();
  if (runError) return Response.json({ error: runError.message }, { status: 500 });

  try {
    const markerResponse = await fetch(MARKERS, { signal: AbortSignal.timeout(20_000) });
    if (!markerResponse.ok) throw new Error(`CCS marker feed returned ${markerResponse.status}`);
    const allMarkers = await markerResponse.json() as JsonRecord[];
    const projects = allMarkers.filter(project => TARGET_AUTHORITY.test(String(project.LaId || '')));

    const existing = await fetchExistingProjects(db);

    const baseline = existing.length === 0;
    const previous = new Map(existing.map(row => [row.project_id, row]));
    const observedAt = new Date().toISOString();
    let detailProjects = 0;
    let detailErrors = 0;

    const enriched = await concurrentMap(projects, DETAIL_CONCURRENCY, async project => {
      const projectId = String(project.Id);
      try {
        const detail = await fetchDetail(projectId);
        detailProjects++;
        return { project, detail, detailError: null };
      } catch (error) {
        detailErrors++;
        return {
          project,
          detail: previous.get(projectId)?.detail_data as JsonRecord | null || null,
          detailError: error instanceof Error ? error.message : String(error),
        };
      }
    });

    let newProjects = 0;
    let changedProjects = 0;
    const rows = [];

    for (const { project, detail, detailError } of enriched) {
      const projectId = String(project.Id);
      const before = previous.get(projectId);
      const payloadHash = await digest(markerFields(project));
      const detailHash = detail ? await digest(detailFields(detail)) : before?.detail_hash || null;
      const isNew = !before;
      const markerChanged = Boolean(before && before.payload_hash !== payloadHash);
      const detailChanged = Boolean(before?.detail_hash && detailHash && before.detail_hash !== detailHash);
      const changed = markerChanged || detailChanged;
      if (isNew && !baseline) newProjects++;
      if (changed) changedProjects++;

      const managerName = detail
        ? [detail.SiteManagerFirstName, detail.SiteManagerLastName].filter(Boolean).join(' ') || null
        : null;
      rows.push({
        project_id: projectId,
        project_name: project.Name || projectId,
        main_contractor: detail?.MainContractor || project.MainContractor || null,
        client: detail?.Client || project.Client || null,
        local_authority: detail?.LocalAuthority || project.LaId || null,
        latitude: project.Latitude || null,
        longitude: project.Longitude || null,
        first_seen_at: before?.first_seen_at || observedAt,
        last_seen_at: observedAt,
        last_changed_at: isNew || changed ? observedAt : before.last_changed_at,
        discovered_after_baseline: before?.discovered_after_baseline ?? !baseline,
        is_active: true,
        payload_hash: payloadHash,
        source_data: project,
        address: detail?.Address || null,
        site_manager_name: managerName,
        site_manager_job_title: detail?.SiteManagerJobTitle || null,
        site_manager_phone: detail?.SiteManagerPhone || null,
        marker_email: detail?.MarkerEmail || null,
        site_start_date: detail?.SiteStartDate || null,
        site_end_date: detail?.SiteEndDate || null,
        site_closed: detail?.SiteClosed ?? null,
        summary: detail?.Summary || detail?.ContractorText || null,
        last_visit_date: detail?.LastVisitDate || null,
        detail_hash: detailHash,
        detail_last_checked_at: detailError ? before?.detail_last_checked_at || null : observedAt,
        detail_error: detailError,
        detail_data: detail || before?.detail_data || null,
      });
    }

    const { error: inactiveError } = await db
      .from('ccs_projects')
      .update({ is_active: false })
      .eq('is_active', true);
    if (inactiveError) throw inactiveError;

    for (let index = 0; index < rows.length; index += 100) {
      const { error: upsertError } = await db
        .from('ccs_projects')
        .upsert(rows.slice(index, index + 100), { onConflict: 'project_id' });
      if (upsertError) throw upsertError;
    }

    const { error: inactiveScheduleError } = await db
      .from('ccs_project_schedule')
      .update({ is_active: false, updated_at: observedAt })
      .eq('is_active', true);
    if (inactiveScheduleError) throw inactiveScheduleError;

    const scheduleRows = rows.map(row => ({
      project_id: row.project_id,
      site_start_date: row.site_start_date,
      site_end_date: row.site_end_date,
      site_closed: row.site_closed,
      is_active: true,
      updated_at: observedAt,
    }));
    for (let index = 0; index < scheduleRows.length; index += 500) {
      const { error: scheduleError } = await db
        .from('ccs_project_schedule')
        .upsert(scheduleRows.slice(index, index + 500), { onConflict: 'project_id' });
      if (scheduleError) throw scheduleError;
    }

    const completedAt = new Date().toISOString();
    await db.from('ccs_sync_runs').update({
      completed_at: completedAt,
      status: 'completed',
      total_projects: projects.length,
      new_projects: newProjects,
      changed_projects: changedProjects,
      detail_projects: detailProjects,
      detail_errors: detailErrors,
    }).eq('id', run.id);

    return Response.json({
      ok: true,
      baseline,
      total: projects.length,
      newProjects,
      changedProjects,
      detailProjects,
      detailErrors,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.from('ccs_sync_runs').update({
      completed_at: new Date().toISOString(),
      status: 'failed',
      error_message: message,
    }).eq('id', run.id);
    return Response.json({ error: message }, { status: 500 });
  }
});
