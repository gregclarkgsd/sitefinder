import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.110.7";
import {
  bestLiveSitesContact,
  captureClassificationSnapshot,
  chooseLiveSitesMatch,
  classifyLiveSitesProject,
  normaliseLiveSitesProject,
  preserveReviewedLiveSitesMatch,
  requireLiveSitesConflictReview,
  restoreClassificationSnapshot,
  sourceConflicts,
} from "../_shared/livesites.js";

const SITEFINDER_URL = "https://gsd-sitefinder.onrender.com";
const PILOT_LIMIT = 50;
const BULK_BATCH_LIMIT = 250;

type JsonRecord = Record<string, unknown>;
type DbClient = any;
type NormalisedProject = JsonRecord & {
  livesites_site_id: string;
  project_name: string;
  contacts: JsonRecord[];
  raw_data: JsonRecord;
};

type CandidateProject = {
  project_id: string;
  project_name: string;
  main_contractor: string | null;
  client: string | null;
  local_authority: string | null;
  address: string | null;
  site_start_date: string | null;
  site_end_date: string | null;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": SITEFINDER_URL,
      "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    },
  });
}

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    1000,
  );
}

async function digest(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(
    new Uint8Array(hash),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function loadCandidateProjects(db: DbClient) {
  const projects: CandidateProject[] = [];
  const pageSize = 1000;
  for (let from = 0;; from += pageSize) {
    const { data, error } = await db
      .from("ccs_projects")
      .select(`
        project_id, project_name, main_contractor, client, local_authority,
        address, site_start_date, site_end_date
      `)
      .eq("is_active", true)
      .range(from, from + pageSize - 1);
    if (error) throw error;
    projects.push(...(data || []));
    if (!data || data.length < pageSize) return projects;
  }
}

function projectRow(project: NormalisedProject, sourceHash: string) {
  return {
    livesites_site_id: project.livesites_site_id,
    source_url: project.source_url,
    project_name: project.project_name,
    project_type: project.project_type,
    project_description: project.project_description,
    live_status: project.live_status,
    address: project.address,
    postcode: project.postcode,
    location: project.location,
    local_authority: project.local_authority,
    contract_value_gbp: project.contract_value_gbp,
    unit_count: project.unit_count,
    unit_type: project.unit_type,
    main_contractor: project.main_contractor,
    client: project.client,
    site_start_date: project.site_start_date,
    site_end_date: project.site_end_date,
    trades_required: project.trades_required,
    painting_and_decorating_required: project.painting_and_decorating_required,
    image_url: project.image_url,
    latitude: project.latitude,
    longitude: project.longitude,
    is_viewed: project.is_viewed,
    is_saved: project.is_saved,
    source_notes: project.source_notes,
    source_hash: sourceHash,
    raw_data: project.raw_data,
    source_verified_at: project.source_verified_at,
    last_imported_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

async function enrichMatchedProject(
  db: DbClient,
  project: NormalisedProject,
  candidate: CandidateProject,
  conflicts: string[],
) {
  const classification = classifyLiveSitesProject(project);
  const contact = bestLiveSitesContact(project.contacts);
  const { data: existing, error: existingError } = await db
    .from("ccs_project_enrichment")
    .select(`
      sector, work_type, fit_out_state, new_build_housing_state,
      classification_confidence, classification_evidence, classification_sources,
      classification_method, researched_at, livesites_previous_classification
    `)
    .eq("project_id", candidate.project_id)
    .maybeSingle();
  if (existingError) throw existingError;

  const sources = Array.isArray(existing?.classification_sources)
    ? existing.classification_sources.filter((source: JsonRecord) =>
      source?.source_system !== "livesites" ||
      source?.livesites_site_id !== project.livesites_site_id
    )
    : [];
  sources.push({
    source_system: "livesites",
    livesites_site_id: project.livesites_site_id,
    source_url: project.source_url,
    verified_at: project.source_verified_at || null,
  });

  const evidence = [
    ...new Set([
      ...(Array.isArray(existing?.classification_evidence)
        ? existing.classification_evidence
        : []),
      ...classification.classification_evidence,
    ]),
  ];
  const now = new Date().toISOString();
  const liveSitesClassified = classification.classification_confidence !== null;
  const existingMethod = String(existing?.classification_method || "");
  const classificationMethod = liveSitesClassified &&
      (!existingMethod || existingMethod === "ccs_deterministic_v1")
    ? existingMethod
      ? "ccs_plus_livesites_deterministic_v1"
      : classification.classification_method
    : existingMethod || classification.classification_method;
  const previousClassification = captureClassificationSnapshot(existing || {});
  const update = {
    project_id: candidate.project_id,
    livesites_site_id: project.livesites_site_id,
    livesites_url: project.source_url,
    livesites_live_status: project.live_status,
    contract_value_gbp: project.contract_value_gbp,
    project_type: project.project_type,
    livesites_project_description: project.project_description,
    unit_count: project.unit_count,
    unit_type: project.unit_type,
    trades_required: project.trades_required,
    painting_and_decorating_required: project.painting_and_decorating_required,
    livesites_image_url: project.image_url,
    livesites_contact_name: contact?.full_name || null,
    livesites_contact_job_title: contact?.job_title || null,
    livesites_contact_phone: contact?.phone || null,
    livesites_contact_email: contact?.email || null,
    livesites_contact_email_verified: contact?.email_verified ?? null,
    livesites_verified_at: project.source_verified_at || null,
    source_conflicts: conflicts,
    sector: existing?.sector || classification.sector,
    work_type: existing?.work_type || classification.work_type,
    fit_out_state:
      existing?.fit_out_state && existing.fit_out_state !== "unknown"
        ? existing.fit_out_state
        : classification.fit_out_state,
    new_build_housing_state: existing?.new_build_housing_state &&
        existing.new_build_housing_state !== "unknown"
      ? existing.new_build_housing_state
      : classification.new_build_housing_state,
    classification_confidence: existing?.classification_confidence ??
      classification.classification_confidence,
    classification_evidence: evidence,
    classification_sources: sources,
    classification_method: classificationMethod,
    livesites_previous_classification: previousClassification,
    researched_at: now,
    updated_at: now,
  };
  const { error } = await db
    .from("ccs_project_enrichment")
    .upsert(update, { onConflict: "project_id" });
  if (error) throw error;
}

async function clearLiveSitesEnrichment(
  db: DbClient,
  livesitesSiteId: string,
) {
  const { data: existing, error: existingError } = await db
    .from("ccs_project_enrichment")
    .select(`
      project_id, sector, work_type, fit_out_state, new_build_housing_state,
      classification_confidence, classification_evidence, classification_sources,
      classification_method, researched_at, livesites_previous_classification
    `)
    .eq("livesites_site_id", livesitesSiteId)
    .maybeSingle();
  if (existingError) throw existingError;
  if (!existing) return;

  const restoredClassification = restoreClassificationSnapshot(existing);
  const now = new Date().toISOString();
  const update = {
    project_id: existing.project_id,
    livesites_site_id: null,
    livesites_url: null,
    livesites_live_status: null,
    contract_value_gbp: null,
    project_type: null,
    livesites_project_description: null,
    unit_count: null,
    unit_type: null,
    trades_required: [],
    painting_and_decorating_required: null,
    livesites_image_url: null,
    livesites_contact_name: null,
    livesites_contact_job_title: null,
    livesites_contact_phone: null,
    livesites_contact_email: null,
    livesites_contact_email_verified: null,
    livesites_verified_at: null,
    source_conflicts: [],
    ...restoredClassification,
    updated_at: now,
  };
  const { error } = await db
    .from("ccs_project_enrichment")
    .update(update)
    .eq("project_id", existing.project_id);
  if (error) throw error;
}

async function importProject(
  db: DbClient,
  project: NormalisedProject,
  candidateProjects: CandidateProject[],
) {
  const sourceHash = await digest(project.raw_data);
  const scoredMatch = chooseLiveSitesMatch(project, candidateProjects);
  const scoredCandidate = scoredMatch.project_id
    ? candidateProjects.find((item) =>
      item.project_id === scoredMatch.project_id
    ) || null
    : null;
  const scoredConflicts = scoredCandidate
    ? sourceConflicts(project, scoredCandidate)
    : [];
  const calculatedMatch = requireLiveSitesConflictReview(
    scoredMatch,
    scoredConflicts,
  );
  const { data: existingMatch, error: existingMatchError } = await db
    .from("livesites_project_matches")
    .select(`
      project_id, match_status, match_score, match_method, match_evidence
    `)
    .eq("livesites_site_id", project.livesites_site_id)
    .maybeSingle();
  if (existingMatchError) throw existingMatchError;
  const match = preserveReviewedLiveSitesMatch(
    calculatedMatch,
    existingMatch,
  );
  const candidate = match.project_id
    ? candidateProjects.find((item) => item.project_id === match.project_id) ||
      null
    : null;
  const conflicts = candidate ? sourceConflicts(project, candidate) : [];

  const { error: projectError } = await db
    .from("livesites_projects")
    .upsert(projectRow(project, sourceHash), {
      onConflict: "livesites_site_id",
    });
  if (projectError) throw projectError;

  const contactTimestamp = new Date().toISOString();
  const { error: deactivateContactsError } = await db
    .from("livesites_contacts")
    .update({
      is_active: false,
      updated_at: contactTimestamp,
    })
    .eq("livesites_site_id", project.livesites_site_id)
    .eq("is_active", true);
  if (deactivateContactsError) throw deactivateContactsError;

  const contacts = project.contacts.map((contact: JsonRecord) => ({
    livesites_site_id: project.livesites_site_id,
    source_contact_key: contact.source_contact_key,
    full_name: contact.full_name,
    job_title: contact.job_title,
    phone: contact.phone,
    email: contact.email,
    email_verified: contact.email_verified,
    company_name: contact.company_name,
    verified_at: contact.verified_at,
    is_active: true,
    raw_data: contact.raw_data,
    last_imported_at: contactTimestamp,
    updated_at: contactTimestamp,
  }));
  if (contacts.length) {
    const { error: contactError } = await db
      .from("livesites_contacts")
      .upsert(contacts, { onConflict: "livesites_site_id,source_contact_key" });
    if (contactError) throw contactError;
  }

  const confirmedMatch =
    ["auto_confirmed", "confirmed"].includes(match.status) && candidate;
  if (
    !confirmedMatch ||
    (existingMatch?.project_id &&
      existingMatch.project_id !== match.project_id)
  ) {
    await clearLiveSitesEnrichment(db, project.livesites_site_id);
  }

  const { error: matchError } = await db
    .from("livesites_project_matches")
    .upsert({
      livesites_site_id: project.livesites_site_id,
      project_id: match.project_id,
      match_status: match.status,
      match_score: match.score,
      match_method: match.method,
      match_evidence: match.evidence,
      source_conflicts: conflicts,
      updated_at: new Date().toISOString(),
    }, { onConflict: "livesites_site_id" });
  if (matchError) throw matchError;

  if (confirmedMatch) {
    await enrichMatchedProject(db, project, candidate, conflicts);
  }

  return {
    livesites_site_id: project.livesites_site_id,
    project_name: project.project_name,
    match_status: match.status,
    project_id: match.project_id,
    match_score: match.score,
    source_conflicts: conflicts,
  };
}

async function reviewProjectMatch(
  db: DbClient,
  reviewerId: string,
  body: JsonRecord,
) {
  const livesitesSiteId = String(body.livesites_site_id || "").trim();
  const decision = String(body.decision || "");
  const requestedProjectId = String(body.project_id || "").trim();
  if (!livesitesSiteId || !["confirm", "reject"].includes(decision)) {
    throw new Error(
      "LiveSites site ID and confirm/reject decision are required",
    );
  }
  if (body.confirm !== "REVIEW-LIVESITES-MATCH") {
    throw new Error("Set confirm to REVIEW-LIVESITES-MATCH");
  }

  const [{ data: storedProject, error: projectError }, {
    data: existingMatch,
    error: matchError,
  }] = await Promise.all([
    db.from("livesites_projects")
      .select("raw_data")
      .eq("livesites_site_id", livesitesSiteId)
      .single(),
    db.from("livesites_project_matches")
      .select("project_id, match_score, match_evidence")
      .eq("livesites_site_id", livesitesSiteId)
      .single(),
  ]);
  if (projectError || !storedProject) {
    throw new Error("Stored LiveSites project was not found");
  }
  if (matchError || !existingMatch) {
    throw new Error("LiveSites match candidate was not found");
  }

  const project = normaliseLiveSitesProject(
    storedProject.raw_data,
  ) as NormalisedProject;
  const projectId = requestedProjectId ||
    String(existingMatch.project_id || "");
  let candidate: CandidateProject | null = null;
  if (decision === "confirm") {
    if (!/^site\d+$/.test(projectId)) {
      throw new Error("A valid SiteFinder project is required to confirm");
    }
    const { data, error } = await db
      .from("ccs_projects")
      .select(`
        project_id, project_name, main_contractor, client, local_authority,
        address, site_start_date, site_end_date
      `)
      .eq("project_id", projectId)
      .single();
    if (error || !data) throw new Error("SiteFinder project was not found");
    candidate = data;
  }

  await clearLiveSitesEnrichment(db, livesitesSiteId);
  const conflicts = candidate ? sourceConflicts(project, candidate) : [];
  const now = new Date().toISOString();
  const status = decision === "confirm" ? "confirmed" : "rejected";
  const { error: updateError } = await db
    .from("livesites_project_matches")
    .update({
      project_id: projectId || existingMatch.project_id || null,
      match_status: status,
      match_method: "manual_review",
      match_evidence: {
        ...(existingMatch.match_evidence || {}),
        manual_decision: decision,
      },
      source_conflicts: conflicts,
      reviewed_by: reviewerId,
      reviewed_at: now,
      updated_at: now,
    })
    .eq("livesites_site_id", livesitesSiteId);
  if (updateError) throw updateError;

  if (candidate) {
    await enrichMatchedProject(db, project, candidate, conflicts);
  }
  return {
    ok: true,
    livesites_site_id: livesitesSiteId,
    project_id: projectId || existingMatch.project_id || null,
    match_status: status,
    match_score: existingMatch.match_score,
    source_conflicts: conflicts,
    reviewed_at: now,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const publishableKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !publishableKey || !serviceKey) {
    return json({ error: "LiveSites import is not fully configured" }, 503);
  }

  const authorization = req.headers.get("Authorization") || "";
  const userClient = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  const email = String(userData.user?.email || "").toLowerCase();
  if (userError || !email.endsWith("@gsdecorating.com")) {
    return json({ error: "Authorised GSD account required" }, 403);
  }

  let body: JsonRecord;
  try {
    body = await req.json() as JsonRecord;
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  const action = String(body.action || "validate");
  const mode = body.mode === "bulk" ? "bulk" : "pilot";
  if (!["validate", "import", "review"].includes(action)) {
    return json({ error: "Unknown action" }, 400);
  }
  const db = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  if (action === "review") {
    try {
      return json(
        await reviewProjectMatch(
          db,
          String(userData.user?.id || ""),
          body,
        ),
      );
    } catch (error) {
      return json({ error: errorMessage(error) }, 400);
    }
  }

  const suppliedProjects = Array.isArray(body.projects) ? body.projects : [];
  const limit = mode === "pilot" ? PILOT_LIMIT : BULK_BATCH_LIMIT;
  if (!suppliedProjects.length) {
    return json({ error: "At least one project is required" }, 400);
  }
  if (suppliedProjects.length > limit) {
    return json({
      error: `${mode} imports are limited to ${limit} projects per request`,
    }, 400);
  }
  if (
    action === "import" &&
    body.confirm !== `IMPORT-LIVESITES-${mode.toUpperCase()}`
  ) {
    return json({
      error: `Set confirm to IMPORT-LIVESITES-${mode.toUpperCase()}`,
    }, 400);
  }

  const projects: NormalisedProject[] = [];
  const validationErrors: Array<{ index: number; error: string }> = [];
  const seenIds = new Set<string>();
  suppliedProjects.forEach((input, index) => {
    try {
      const project = normaliseLiveSitesProject(input) as NormalisedProject;
      const siteId = String(project.livesites_site_id);
      if (seenIds.has(siteId)) {
        throw new Error(`Duplicate LiveSites site ID ${siteId}`);
      }
      seenIds.add(siteId);
      projects.push(project);
    } catch (error) {
      validationErrors.push({ index, error: errorMessage(error) });
    }
  });
  if (validationErrors.length) {
    return json({
      ok: false,
      requested: suppliedProjects.length,
      validated: projects.length,
      validation_errors: validationErrors,
    }, 422);
  }

  let candidates: CandidateProject[];
  try {
    candidates = await loadCandidateProjects(db);
  } catch (error) {
    return json({ error: errorMessage(error) }, 500);
  }
  const projectIds = projects.map((project) => project.livesites_site_id);
  const { data: existingMatches, error: existingMatchesError } = await db
    .from("livesites_project_matches")
    .select(`
      livesites_site_id, project_id, match_status, match_score,
      match_method, match_evidence
    `)
    .in("livesites_site_id", projectIds);
  if (existingMatchesError) {
    return json({ error: errorMessage(existingMatchesError) }, 500);
  }
  const existingMatchesBySiteId = new Map(
    (existingMatches || []).map((match: JsonRecord) => [
      String(match.livesites_site_id),
      match,
    ]),
  );
  const preview = projects.map((project) => {
    const match = preserveReviewedLiveSitesMatch(
      chooseLiveSitesMatch(project, candidates),
      existingMatchesBySiteId.get(project.livesites_site_id),
    );
    const candidate = match.project_id
      ? candidates.find((item) => item.project_id === match.project_id) || null
      : null;
    return {
      livesites_site_id: project.livesites_site_id,
      project_name: project.project_name,
      match_status: match.status,
      project_id: match.project_id,
      match_score: match.score,
      source_conflicts: candidate ? sourceConflicts(project, candidate) : [],
      classification: classifyLiveSitesProject(project),
      painting_and_decorating_required:
        project.painting_and_decorating_required,
    };
  });
  if (action === "validate") {
    return json({
      ok: true,
      dry_run: true,
      mode,
      requested: projects.length,
      candidate_projects: candidates.length,
      preview,
    });
  }

  const { data: run, error: runError } = await db
    .from("livesites_import_runs")
    .insert({
      mode,
      status: "importing",
      dry_run: false,
      requested_count: projects.length,
      validated_count: projects.length,
      requested_by: userData.user?.id || null,
    })
    .select("id")
    .single();
  if (runError) return json({ error: errorMessage(runError) }, 500);

  const results: JsonRecord[] = [];
  const failures: Array<{ livesites_site_id: string; error: string }> = [];
  for (const project of projects) {
    try {
      results.push(await importProject(db, project, candidates));
    } catch (error) {
      failures.push({
        livesites_site_id: String(project.livesites_site_id),
        error: errorMessage(error),
      });
    }
  }
  const matched = results.filter((result) =>
    ["auto_confirmed", "confirmed"].includes(String(result.match_status))
  ).length;
  const review = results.filter((result) =>
    result.match_status === "review"
  ).length;
  const unmatched = results.filter((result) =>
    result.match_status === "unmatched"
  ).length;
  const status = failures.length
    ? (results.length ? "partial" : "error")
    : "completed";
  await db.from("livesites_import_runs").update({
    status,
    imported_count: results.length,
    matched_count: matched,
    review_count: review,
    unmatched_count: unmatched,
    error_count: failures.length,
    completed_at: new Date().toISOString(),
  }).eq("id", run.id);

  return json({
    ok: failures.length === 0,
    run_id: run.id,
    mode,
    requested: projects.length,
    imported: results.length,
    matched,
    review,
    unmatched,
    failed: failures.length,
    results,
    failures,
  }, failures.length ? 207 : 200);
});
