import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.110.7';

const FEED = 'https://ccsfilestore.blob.core.windows.net/constructionmap/live/json/sitemarkers.json';
const TARGET = /London|Essex|Kent|Surrey|Hertfordshire|Berkshire|Buckinghamshire|Hampshire|West Sussex|East Sussex|Oxfordshire|Bedfordshire/i;

async function fingerprint(project: Record<string, unknown>) {
  const tracked = JSON.stringify({
    name: project.Name, contractor: project.MainContractor, client: project.Client,
    authority: project.LaId, latitude: project.Latitude, longitude: project.Longitude,
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tracked));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async request => {
  if (request.headers.get('x-sync-token') !== Deno.env.get('CCS_SYNC_TOKEN')) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const { data: run, error: runError } = await db.from('ccs_sync_runs').insert({ status: 'running' }).select('id').single();
  if (runError) return Response.json({ error: runError.message }, { status: 500 });
  try {
    const response = await fetch(FEED);
    if (!response.ok) throw new Error(`CCS feed returned ${response.status}`);
    const projects = (await response.json()).filter((project: Record<string, unknown>) => TARGET.test([project.Name, project.Client, project.MainContractor, project.LaId].join(' ')));
    const { data: existing, error } = await db.from('ccs_projects').select('project_id,payload_hash,first_seen_at,discovered_after_baseline,last_changed_at');
    if (error) throw error;
    const baseline = existing.length === 0;
    const previous = new Map(existing.map(row => [row.project_id, row]));
    const now = new Date().toISOString();
    let newProjects = 0, changedProjects = 0;
    const rows = [];
    for (const project of projects) {
      const projectId = String(project.Id), before = previous.get(projectId), payloadHash = await fingerprint(project);
      const isNew = !before, changed = Boolean(before && before.payload_hash !== payloadHash);
      if (isNew && !baseline) newProjects++;
      if (changed) changedProjects++;
      rows.push({ project_id: projectId, project_name: project.Name || projectId, main_contractor: project.MainContractor || null, client: project.Client || null, local_authority: project.LaId || null, latitude: project.Latitude || null, longitude: project.Longitude || null, first_seen_at: before?.first_seen_at || now, last_seen_at: now, last_changed_at: isNew || changed ? now : before.last_changed_at, discovered_after_baseline: before?.discovered_after_baseline ?? !baseline, is_active: true, payload_hash: payloadHash, source_data: project });
    }
    const { error: inactiveError } = await db.from('ccs_projects').update({ is_active: false }).eq('is_active', true);
    if (inactiveError) throw inactiveError;
    for (let index = 0; index < rows.length; index += 100) {
      const { error: upsertError } = await db.from('ccs_projects').upsert(rows.slice(index, index + 100), { onConflict: 'project_id' });
      if (upsertError) throw upsertError;
    }
    await db.from('ccs_sync_runs').update({ completed_at: now, status: 'completed', total_projects: projects.length, new_projects: newProjects, changed_projects: changedProjects }).eq('id', run.id);
    return Response.json({ ok: true, baseline, total: projects.length, newProjects, changedProjects });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.from('ccs_sync_runs').update({ completed_at: new Date().toISOString(), status: 'failed', error_message: message }).eq('id', run.id);
    return Response.json({ error: message }, { status: 500 });
  }
});
