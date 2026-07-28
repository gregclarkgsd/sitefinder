const SECTOR_RULES = [
  {
    label: "Care & Healthcare",
    pattern:
      /\b(hospital|health(?:care)? centre|medical centre|clinic|care home|nursing home|hospice)\b/i,
  },
  {
    label: "Education",
    pattern:
      /\b(school|academy|college|university|nursery|education centre|student accommodation)\b/i,
  },
  {
    label: "Residential",
    pattern:
      /\b(homes?|housing|flats?|apartments?|dwellings?|residential|almshouse)\b/i,
  },
  {
    label: "Commercial Office",
    pattern: /\b(office|offices|headquarters|workspace|business centre)\b/i,
  },
  {
    label: "Retail",
    pattern: /\b(retail|shop|shops|shopping centre|supermarket|store)\b/i,
  },
  {
    label: "Hotel & Leisure",
    pattern: /\b(hotel|leisure|stadium|sports centre|gym|cinema|theatre)\b/i,
  },
  {
    label: "Public & Civic",
    pattern:
      /\b(council|civic|courthouse|court building|police station|fire station|library)\b/i,
  },
  {
    label: "Industrial & Logistics",
    pattern:
      /\b(warehouse|distribution centre|logistics|industrial|factory|manufacturing)\b/i,
  },
];

const WORK_TYPE_RULES = [
  {
    label: "Fit Out",
    pattern: /\b(fit[ -]?out|interior fit|internal fit)\b/i,
  },
  {
    label: "Refurbishment",
    pattern:
      /\b(refurbishment|refurbish(?:ment|ed|ing)?|renovation|restoration|remodelling)\b/i,
  },
  {
    label: "Redevelopment",
    pattern:
      /\b(redevelopment|replacement development|demolition and rebuild|regeneration)\b/i,
  },
  {
    label: "Extension",
    pattern: /\bextensions?\b/i,
  },
  {
    label: "New Build",
    pattern:
      /\b(new[ -]?build|new construction|new development|construction of)\b/i,
  },
];

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function findRule(rules, text) {
  for (const rule of rules) {
    const match = text.match(rule.pattern);
    if (match) return { label: rule.label, evidence: match[0] };
  }
  return null;
}

export function postcodeFromAddress(value) {
  const match = cleanText(value).toUpperCase().match(
    /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/,
  );
  if (!match) return null;
  return match[1].replace(/\s+/g, "").replace(/(.+)(\d[A-Z]{2})$/, "$1 $2");
}

export function classifyCcsProject(input) {
  const fields = [
    ["project name", cleanText(input.project_name)],
    ["CCS summary", cleanText(input.summary)],
  ].filter(([, text]) => text);
  const combined = fields.map(([, text]) => text).join(" ");
  const sector = findRule(SECTOR_RULES, combined);
  const workType = findRule(WORK_TYPE_RULES, combined);
  const evidence = [];

  if (sector) {
    evidence.push(
      `CCS text contains “${sector.evidence}” (${sector.label})`,
    );
  }
  if (workType) {
    evidence.push(
      `CCS text contains “${workType.evidence}” (${workType.label})`,
    );
  }

  let newBuildHousingState = "unknown";
  if (sector?.label && sector.label !== "Residential") {
    newBuildHousingState = "no";
  } else if (
    sector?.label === "Residential" &&
    ["New Build", "Redevelopment"].includes(workType?.label)
  ) {
    newBuildHousingState = "yes";
  } else if (
    sector?.label === "Residential" &&
    ["Fit Out", "Refurbishment", "Extension"].includes(workType?.label)
  ) {
    newBuildHousingState = "no";
  }

  const classifiedFields = [sector, workType].filter(Boolean).length;
  return {
    sector: sector?.label || null,
    work_type: workType?.label || null,
    fit_out_state: workType?.label === "Fit Out" ? "yes" : "unknown",
    new_build_housing_state: newBuildHousingState,
    classification_confidence: classifiedFields === 2
      ? 0.9
      : classifiedFields === 1
      ? 0.78
      : null,
    classification_evidence: evidence,
    classification_sources: evidence.length
      ? [{
        source_system: "ccs",
        fields: fields.map(([field]) => field),
      }]
      : [],
    classification_method: "ccs_text_deterministic_v2",
  };
}
