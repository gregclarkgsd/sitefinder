const UK_POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i;
const MATCH_STOP_WORDS = new Set([
  "and",
  "at",
  "building",
  "development",
  "phase",
  "project",
  "redevelopment",
  "site",
  "the",
]);

function cleanText(value) {
  const clean = String(value ?? "").replace(/\s+/g, " ").trim();
  return clean || null;
}

function firstValue(record, keys) {
  for (const key of keys) {
    const value = record?.[key];
    if (value !== null && value !== undefined && String(value).trim() !== "") {
      return value;
    }
  }
  return null;
}

export function normaliseName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(limited|ltd|plc|llp|group|holdings|uk)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalisePostcode(value) {
  const match = String(value ?? "").toUpperCase().match(UK_POSTCODE);
  if (!match) return null;
  const compact = match[1].replace(/\s+/g, "");
  return compact.length > 3
    ? `${compact.slice(0, -3)} ${compact.slice(-3)}`
    : compact;
}

export function parseCurrencyGbp(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  const clean = String(value).toLowerCase().replace(/[£,\s]/g, "");
  const match = clean.match(/^(\d+(?:\.\d+)?)(m|million|k|thousand)?$/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return null;
  if (match[2] === "m" || match[2] === "million") return amount * 1_000_000;
  if (match[2] === "k" || match[2] === "thousand") return amount * 1_000;
  return amount;
}

export function parseDate(value) {
  const clean = cleanText(value);
  if (!clean) return null;
  const uk = clean.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (uk) {
    return `${uk[3]}-${uk[2].padStart(2, "0")}-${uk[1].padStart(2, "0")}`;
  }
  const iso = clean.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : null;
}

function parseTimestamp(value) {
  const clean = cleanText(value);
  if (!clean) return null;
  const dateOnly = parseDate(clean);
  if (dateOnly) return `${dateOnly}T00:00:00.000Z`;
  const timestamp = new Date(clean);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

function safeHttpsUrl(value, allowedHosts = null) {
  const clean = cleanText(value);
  if (!clean) return null;
  try {
    const url = new URL(clean);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (allowedHosts && !allowedHosts.includes(url.hostname.toLowerCase()))
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function normaliseTrades(value) {
  const values = Array.isArray(value)
    ? value
    : String(value ?? "").split(/[,;|]/);
  return [...new Set(values.map(cleanText).filter(Boolean))];
}

function inferUnits(projectType, explicitCount, explicitType) {
  const count = Number(explicitCount);
  if (
    explicitCount !== null && explicitCount !== undefined &&
    explicitCount !== "" &&
    Number.isInteger(count) && count >= 0
  ) {
    return { unit_count: count, unit_type: cleanText(explicitType) };
  }
  const match = String(projectType ?? "").match(/\b(\d{1,5})\s+(.+)$/);
  if (!match) return { unit_count: null, unit_type: cleanText(explicitType) };
  return {
    unit_count: Number(match[1]),
    unit_type: cleanText(explicitType) || cleanText(match[2]),
  };
}

function contactKey(contact, index) {
  const email = cleanText(firstValue(contact, ["email", "verified_email"]))
    ?.toLowerCase();
  if (email) return `email:${email}`;
  const phone = String(
    firstValue(contact, ["phone", "mobile", "direct_mobile"]) ?? "",
  )
    .replace(/[^0-9+]/g, "");
  if (phone) return `phone:${phone}`;
  const name = normaliseName(
    firstValue(contact, ["full_name", "name", "contact_name"]),
  );
  return name ? `name:${name}` : `contact:${index + 1}`;
}

function normaliseContacts(input) {
  const supplied = firstValue(input, ["contacts", "site_contacts"]);
  const contacts = Array.isArray(supplied) ? supplied : [];
  if (
    !contacts.length && firstValue(input, [
      "contact_name",
      "site_manager_name",
      "contact_email",
      "verified_email",
      "contact_phone",
      "direct_mobile",
    ])
  ) {
    contacts.push({
      full_name: firstValue(input, ["contact_name", "site_manager_name"]),
      job_title: firstValue(input, [
        "contact_job_title",
        "site_manager_job_title",
      ]),
      phone: firstValue(input, ["contact_phone", "direct_mobile"]),
      email: firstValue(input, ["contact_email", "verified_email"]),
      email_verified: firstValue(input, [
        "contact_email_verified",
        "email_verified",
      ]),
      company_name: firstValue(input, ["contact_company", "main_contractor"]),
    });
  }
  return contacts.map((contact, index) => ({
    source_contact_key: contactKey(contact, index),
    full_name: cleanText(
      firstValue(contact, ["full_name", "name", "contact_name"]),
    ),
    job_title: cleanText(
      firstValue(contact, ["job_title", "role", "contact_job_title"]),
    ),
    phone: cleanText(firstValue(contact, ["phone", "mobile", "direct_mobile"])),
    email: cleanText(firstValue(contact, ["email", "verified_email"]))
      ?.toLowerCase() || null,
    email_verified:
      firstValue(contact, ["email_verified", "verified"]) === true,
    company_name: cleanText(firstValue(contact, ["company_name", "company"])),
    verified_at: parseTimestamp(
      firstValue(contact, ["verified_at", "email_verified_at"]),
    ),
    raw_data: contact,
  }));
}

export function normaliseLiveSitesProject(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("LiveSites project must be an object");
  }
  const livesitesSiteId = cleanText(firstValue(input, [
    "livesites_site_id",
    "site_id",
    "siteid",
    "id",
  ]));
  const projectName = cleanText(
    firstValue(input, ["project_name", "name", "project"]),
  );
  if (!livesitesSiteId) throw new Error("LiveSites site ID is required");
  if (!projectName) {
    throw new Error(
      `Project name is required for LiveSites ${livesitesSiteId}`,
    );
  }

  const projectType = cleanText(firstValue(input, [
    "project_type",
    "project_overview",
    "overview",
    "size_label",
  ]));
  const units = inferUnits(
    projectType,
    firstValue(input, ["unit_count", "units"]),
    firstValue(input, ["unit_type", "units_type"]),
  );
  const address = cleanText(firstValue(input, ["address", "full_address"]));
  const postcode = normalisePostcode(
    firstValue(input, ["postcode"]) || address,
  );
  const trades = normaliseTrades(
    firstValue(input, ["trades_required", "trades"]),
  );
  const suppliedSourceUrl = firstValue(input, ["source_url", "livesites_url"]);
  const sourceUrl = safeHttpsUrl(suppliedSourceUrl, [
    "livesites.co.uk",
    "www.livesites.co.uk",
  ]) ||
    `https://livesites.co.uk/projects?siteid=${
      encodeURIComponent(livesitesSiteId)
    }`;
  if (
    suppliedSourceUrl && !safeHttpsUrl(suppliedSourceUrl, [
      "livesites.co.uk",
      "www.livesites.co.uk",
    ])
  ) {
    throw new Error(`Invalid LiveSites source URL for ${livesitesSiteId}`);
  }

  return {
    livesites_site_id: livesitesSiteId,
    source_url: sourceUrl,
    project_name: projectName,
    project_type: projectType,
    project_description: cleanText(
      firstValue(input, ["project_description", "description", "summary"]),
    ),
    live_status: cleanText(firstValue(input, ["live_status", "status"])),
    address,
    postcode,
    location: cleanText(
      firstValue(input, ["location", "town", "city", "region"]),
    ),
    local_authority: cleanText(
      firstValue(input, ["local_authority", "authority"]),
    ),
    contract_value_gbp: parseCurrencyGbp(firstValue(input, [
      "contract_value_gbp",
      "contract_value",
      "value",
    ])),
    unit_count: units.unit_count,
    unit_type: units.unit_type,
    main_contractor: cleanText(
      firstValue(input, ["main_contractor", "contractor"]),
    ),
    client: cleanText(firstValue(input, ["client", "client_company"])),
    site_start_date: parseDate(
      firstValue(input, ["site_start_date", "start_date", "start"]),
    ),
    site_end_date: parseDate(
      firstValue(input, ["site_end_date", "end_date", "end"]),
    ),
    trades_required: trades,
    painting_and_decorating_required: trades.length
      ? trades.some((trade) =>
        normaliseName(trade).includes("painting and decorating")
      )
      : null,
    image_url: safeHttpsUrl(
      firstValue(input, ["image_url", "project_image_url"]),
    ),
    latitude: Number.isFinite(Number(input.latitude))
      ? Number(input.latitude)
      : null,
    longitude: Number.isFinite(Number(input.longitude))
      ? Number(input.longitude)
      : null,
    is_viewed: typeof input.is_viewed === "boolean" ? input.is_viewed : null,
    is_saved: typeof input.is_saved === "boolean" ? input.is_saved : null,
    source_notes: cleanText(firstValue(input, ["source_notes", "notes"])),
    source_verified_at: parseTimestamp(
      firstValue(input, ["source_verified_at", "verified_at", "exported_at"]),
    ),
    contacts: normaliseContacts(input),
    raw_data: input,
  };
}

function containsAny(value, terms) {
  return terms.some((term) => value.includes(term));
}

export function classifyLiveSitesProject(project) {
  const type = normaliseName(project.project_type);
  const description = normaliseName(project.project_description);
  const combined = `${type} ${description}`.trim();
  const evidence = [];

  let sector = null;
  const sectorRules = [
    ["Residential", [
      "apartment",
      "flat",
      "home",
      "house",
      "housing",
      "residential",
      "almshouse",
    ]],
    ["Education", ["academy", "college", "education", "school", "university"]],
    ["Healthcare", ["care home", "health", "hospital", "hospice", "medical"]],
    ["Commercial Office", ["commercial office", "office"]],
    ["Retail", ["retail", "shop", "shopping", "supermarket"]],
    ["Hospitality", ["hotel", "hospitality", "restaurant"]],
    ["Industrial & Logistics", [
      "factory",
      "industrial",
      "logistics",
      "self storage",
      "warehouse",
    ]],
    ["Leisure", ["cinema", "convention centre", "gym", "leisure", "stadium"]],
    ["Infrastructure", [
      "airport",
      "bridge",
      "highway",
      "infrastructure",
      "rail",
    ]],
  ];
  for (const [label, terms] of sectorRules) {
    if (containsAny(combined, terms)) {
      sector = label;
      evidence.push(`LiveSites project type supports sector: ${label}`);
      break;
    }
  }

  let workType = null;
  const workRules = [
    ["Fit Out", ["fit out", "fitout"]],
    ["Refurbishment", ["refurb", "renovation"]],
    ["Extension", ["extension"]],
    ["Conversion", ["conversion"]],
    ["Redevelopment", ["redevelopment", "replacement development"]],
    ["New Build", [
      "new build",
      "new building",
      "new development",
      "new school",
      "new warehouse",
    ]],
  ];
  for (const [label, terms] of workRules) {
    if (containsAny(combined, terms)) {
      workType = label;
      evidence.push(`LiveSites project type supports work type: ${label}`);
      break;
    }
  }

  let fitOutState = "unknown";
  if (["Fit Out", "Refurbishment", "Conversion"].includes(workType)) {
    fitOutState = "yes";
    evidence.push(
      "LiveSites explicitly describes fit-out, refurbishment or conversion work",
    );
  } else if (workType === "New Build") {
    fitOutState = "no";
    evidence.push("LiveSites explicitly describes a new-build project");
  }

  let newBuildHousingState = "unknown";
  if (
    sector === "Residential" &&
    ["New Build", "Redevelopment"].includes(workType)
  ) {
    newBuildHousingState = "yes";
    evidence.push(
      "LiveSites describes residential development or replacement development",
    );
  } else if (sector && sector !== "Residential") {
    newBuildHousingState = "no";
    evidence.push(`LiveSites identifies the project as ${sector}, not housing`);
  } else if (
    sector === "Residential" &&
    ["Fit Out", "Refurbishment", "Conversion", "Extension"].includes(workType)
  ) {
    newBuildHousingState = "no";
    evidence.push(
      `LiveSites identifies residential ${workType.toLowerCase()} rather than new-build housing`,
    );
  }

  const explicitSignals =
    [sector, workType, project.painting_and_decorating_required === true]
      .filter(Boolean).length;
  return {
    sector,
    work_type: workType,
    fit_out_state: fitOutState,
    new_build_housing_state: newBuildHousingState,
    classification_confidence: explicitSignals
      ? Math.min(0.98, 0.72 + explicitSignals * 0.08)
      : null,
    classification_evidence: evidence,
    classification_method: "livesites_deterministic_v1",
  };
}

function matchTokens(value) {
  return new Set(
    normaliseName(value)
      .split(" ")
      .filter((token) => token.length > 1 && !MATCH_STOP_WORDS.has(token)),
  );
}

function similarity(left, right) {
  const leftName = normaliseName(left);
  const rightName = normaliseName(right);
  if (!leftName || !rightName) return 0;
  if (leftName === rightName) return 1;
  if (leftName.includes(rightName) || rightName.includes(leftName)) return 0.88;
  const a = matchTokens(leftName);
  const b = matchTokens(rightName);
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  const union = new Set([...a, ...b]).size;
  return union ? intersection / union : 0;
}

function dateCloseness(left, right) {
  const leftDate = parseDate(left);
  const rightDate = parseDate(right);
  if (!leftDate || !rightDate) return 0;
  const difference = Math.abs(
    new Date(`${leftDate}T00:00:00Z`).getTime() -
      new Date(`${rightDate}T00:00:00Z`).getTime(),
  ) / 86_400_000;
  if (difference <= 14) return 1;
  if (difference <= 60) return 0.7;
  if (difference <= 120) return 0.35;
  return 0;
}

export function scoreLiveSitesMatch(source, candidate) {
  const sourcePostcode = normalisePostcode(source.postcode || source.address);
  const candidatePostcode = normalisePostcode(
    candidate.postcode || candidate.address,
  );
  const postcodeExact = Boolean(
    sourcePostcode && candidatePostcode && sourcePostcode === candidatePostcode,
  );
  const nameSimilarity = similarity(
    source.project_name,
    candidate.project_name,
  );
  const contractorSimilarity = similarity(
    source.main_contractor,
    candidate.main_contractor,
  );
  const localAuthoritySimilarity = similarity(
    source.local_authority,
    candidate.local_authority,
  );
  const startSimilarity = dateCloseness(
    source.site_start_date,
    candidate.site_start_date,
  );
  const endSimilarity = dateCloseness(
    source.site_end_date,
    candidate.site_end_date,
  );

  const score = Math.min(
    1,
    (postcodeExact ? 0.45 : 0) +
      nameSimilarity * 0.25 +
      contractorSimilarity * 0.20 +
      startSimilarity * 0.04 +
      endSimilarity * 0.04 +
      localAuthoritySimilarity * 0.02,
  );
  return {
    project_id: candidate.project_id,
    score: Number(score.toFixed(4)),
    postcode_exact: postcodeExact,
    name_similarity: Number(nameSimilarity.toFixed(4)),
    contractor_similarity: Number(contractorSimilarity.toFixed(4)),
    start_date_similarity: Number(startSimilarity.toFixed(4)),
    end_date_similarity: Number(endSimilarity.toFixed(4)),
    local_authority_similarity: Number(localAuthoritySimilarity.toFixed(4)),
  };
}

export function chooseLiveSitesMatch(source, candidates) {
  const ranked = candidates
    .map((candidate) => ({
      candidate,
      ...scoreLiveSitesMatch(source, candidate),
    }))
    .filter((result) => result.score > 0)
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  const second = ranked[1];
  if (!best) {
    return {
      status: "unmatched",
      project_id: null,
      score: 0,
      method: "no_candidate",
      evidence: {},
    };
  }
  const margin = Number((best.score - (second?.score || 0)).toFixed(4));
  const autoConfirmed = best.postcode_exact && best.score >= 0.78 &&
    margin >= 0.12;
  return {
    status: autoConfirmed
      ? "auto_confirmed"
      : best.score >= 0.55
      ? "review"
      : "unmatched",
    project_id: autoConfirmed || best.score >= 0.55 ? best.project_id : null,
    score: best.score,
    method: autoConfirmed
      ? "postcode_name_contractor_dates_v1"
      : "candidate_scoring_v1",
    evidence: {
      postcode_exact: best.postcode_exact,
      name_similarity: best.name_similarity,
      contractor_similarity: best.contractor_similarity,
      start_date_similarity: best.start_date_similarity,
      end_date_similarity: best.end_date_similarity,
      local_authority_similarity: best.local_authority_similarity,
      score_margin: margin,
      second_candidate_project_id: second?.project_id || null,
      second_candidate_score: second?.score || null,
    },
  };
}

export function requireLiveSitesConflictReview(match, conflicts) {
  if (match.status !== "auto_confirmed" || !conflicts?.length) return match;
  return {
    ...match,
    status: "review",
    method: "source_conflict_review_v1",
    evidence: {
      ...match.evidence,
      source_conflicts: [...conflicts],
    },
  };
}

export function preserveReviewedLiveSitesMatch(calculated, existing) {
  if (
    !existing ||
    !["confirmed", "rejected"].includes(String(existing.match_status))
  ) {
    return calculated;
  }
  return {
    status: String(existing.match_status),
    project_id: existing.project_id || null,
    score: existing.match_score ?? calculated.score,
    method: existing.match_method || "manual_review",
    evidence: existing.match_evidence || calculated.evidence,
    manually_reviewed: true,
  };
}

export function captureClassificationSnapshot(existing = {}) {
  return existing.livesites_previous_classification || {
    sector: existing.sector ?? null,
    work_type: existing.work_type ?? null,
    fit_out_state: existing.fit_out_state || "unknown",
    new_build_housing_state: existing.new_build_housing_state || "unknown",
    classification_confidence: existing.classification_confidence ?? null,
    classification_evidence: existing.classification_evidence || [],
    classification_sources: existing.classification_sources || [],
    classification_method: existing.classification_method ||
      "ccs_deterministic_v1",
    researched_at: existing.researched_at ?? null,
  };
}

export function restoreClassificationSnapshot(existing = {}) {
  const snapshot = existing.livesites_previous_classification;
  if (snapshot) {
    return {
      ...snapshot,
      livesites_previous_classification: null,
    };
  }
  const liveSitesClassified = String(existing.classification_method || "")
    .includes("livesites");
  return {
    sector: liveSitesClassified ? null : existing.sector ?? null,
    work_type: liveSitesClassified ? null : existing.work_type ?? null,
    fit_out_state: liveSitesClassified
      ? "unknown"
      : existing.fit_out_state || "unknown",
    new_build_housing_state: liveSitesClassified
      ? "unknown"
      : existing.new_build_housing_state || "unknown",
    classification_confidence: liveSitesClassified
      ? null
      : existing.classification_confidence ?? null,
    classification_evidence: liveSitesClassified
      ? []
      : existing.classification_evidence || [],
    classification_sources: liveSitesClassified
      ? (Array.isArray(existing.classification_sources)
        ? existing.classification_sources.filter((source) =>
          source?.source_system !== "livesites"
        )
        : [])
      : existing.classification_sources || [],
    classification_method: liveSitesClassified
      ? "ccs_deterministic_v1"
      : existing.classification_method || "ccs_deterministic_v1",
    researched_at: existing.researched_at ?? null,
    livesites_previous_classification: null,
  };
}

export function sourceConflicts(source, candidate) {
  const conflicts = [];
  const compare = (field, left, right, threshold = 0.55) => {
    if (
      cleanText(left) && cleanText(right) && similarity(left, right) < threshold
    ) conflicts.push(field);
  };
  compare("project_name", source.project_name, candidate.project_name);
  compare("main_contractor", source.main_contractor, candidate.main_contractor);
  compare("client", source.client, candidate.client);
  if (
    source.site_start_date &&
    candidate.site_start_date &&
    dateCloseness(source.site_start_date, candidate.site_start_date) === 0
  ) conflicts.push("site_start_date");
  if (
    source.site_end_date &&
    candidate.site_end_date &&
    dateCloseness(source.site_end_date, candidate.site_end_date) === 0
  ) conflicts.push("site_end_date");
  return conflicts;
}

export function bestLiveSitesContact(contacts) {
  return [...(contacts || [])].sort((left, right) => {
    const score = (contact) =>
      (contact.email_verified ? 8 : 0) +
      (contact.email ? 4 : 0) +
      (contact.phone ? 2 : 0) +
      (normaliseName(contact.job_title).includes("site manager") ? 1 : 0);
    return score(right) - score(left);
  })[0] || null;
}
