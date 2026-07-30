import "dotenv/config";
import { readdir } from "node:fs/promises";
import { CLI_HELP_TEXT } from "./cli-help.js";
import { loadConfig, requireSecret, type AppConfig } from "./config.js";
import { AttioReader } from "./crm/attio.js";
import { PipedriveReader } from "./crm/pipedrive.js";
import {
  privateOutputFile,
  resolvePrivateInputFile,
  resolvePrivateOutputDirectory,
  type PrivateOutputDirectory,
} from "./io/private-data-boundary.js";
import {
  loadCrmCompanySnapshots,
  readJson,
  withOutputLock,
  writePrivateJson,
  writePrivateJsonLines,
} from "./io/private-files.js";
import { parseCapturedCompanySeeds } from "./io/company-input.js";
import { writeCompletionManifest } from "./io/completion-manifest.js";
import { captureImmutableInput } from "./io/immutable-input.js";
import { loadQueueInputManifest } from "./io/queue-input-manifest.js";
import {
  parseCapturedAttioPeople,
  parseCapturedPipedrivePeople,
} from "./io/people-input.js";
import { writeEnrichmentRun } from "./io/run-output.js";
import { verifyPeopleSnapshotInput } from "./io/verified-snapshot-input.js";
import {
  SiteFinderProgressPublisher,
  SiteFinderQueueClient,
  type ClaimedResearchRun,
} from "./observability/sitefinder-progress.js";
import {
  enrichCompanies,
} from "./pipeline/enrich.js";
import {
  partitionCompaniesByCleanupPolicy,
  type HeldCleanupCompany,
} from "./policy/apply-cleanup-policy.js";
import {
  evaluateCleanupPolicy,
  type CleanupDecision,
} from "./policy/cleanup-policy.js";
import { loadVerifiedCleanupApproval } from "./policy/cleanup-approval-manifest.js";
import { selectReviewedPilotCompanies } from "./policy/reviewed-pilot-manifest.js";
import { CompaniesHouseReader } from "./public-data/companies-house.js";
import { ApolloPeopleReader } from "./public-data/apollo.js";
import { reconcilePeople } from "./reconcile.js";
import {
  createCompanyResearchPlan,
  captureCompanyUniverseInputs,
  parseCapturedCompanyUniverseInputs,
  type CompanyUniverseInputPaths,
} from "./universe/company-universe-io.js";
import {
  compileCompanyUniverse,
  parseIdentityResolutionManifest,
  type UniverseCompany,
} from "./universe/index.js";
import type {
  AttioPersonSnapshot,
  CompanySeed,
  PipedrivePersonSnapshot,
} from "./types.js";

interface Arguments {
  command?: string;
  flags: Map<string, string | true>;
}

interface QueueEnrichInvocation {
  runId: string;
  companyIds: string[];
  progress: SiteFinderProgressPublisher;
}

function parseArguments(values: string[]): Arguments {
  const [command, ...rest] = values;
  const flags = new Map<string, string | true>();
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value?.startsWith("--")) {
      throw new Error(`Unexpected argument: ${value ?? ""}`);
    }
    const [rawName = "", inline] = value.slice(2).split("=", 2);
    if (!rawName) throw new Error("Empty flag name");
    if (inline !== undefined) {
      flags.set(rawName, inline);
      continue;
    }
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(rawName, next);
      index += 1;
    } else {
      flags.set(rawName, true);
    }
  }
  return { ...(command ? { command } : {}), flags };
}

function flag(
  args: Arguments,
  name: string,
  options: { required?: boolean; fallback?: string } = {},
): string | undefined {
  const value = args.flags.get(name);
  if (value === true) {
    if (options.required) throw new Error(`--${name} requires a value`);
    return "true";
  }
  if (typeof value === "string") return value;
  if (options.fallback !== undefined) return options.fallback;
  if (options.required) throw new Error(`Missing required flag --${name}`);
  return undefined;
}

function integerFlag(
  args: Arguments,
  name: string,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  const raw = flag(args, name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new Error(
      `--${name} must be an integer from ${bounds.min} to ${bounds.max}`,
    );
  }
  return value;
}

function enabled(args: Arguments, name: string): boolean {
  const value = args.flags.get(name);
  return value === true || value === "true" || value === "yes" || value === "1";
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

async function commandOutput(
  config: AppConfig,
  args: Arguments,
  fallback: string,
): Promise<PrivateOutputDirectory> {
  return resolvePrivateOutputDirectory({
    privateDataDirectory: config.privateDataDirectory,
    requestedDirectory: flag(args, "output", { fallback }) ?? "",
  });
}

async function privateInput(
  output: PrivateOutputDirectory,
  args: Arguments,
  name: string,
  options: { required?: boolean } = {},
): Promise<string | undefined> {
  const requested = flag(
    args,
    name,
    options.required ? { required: true } : {},
  );
  return requested
    ? resolvePrivateInputFile(output.rootDirectory, requested)
    : undefined;
}

async function assertOutputDirectoryIsEmpty(
  output: PrivateOutputDirectory,
): Promise<void> {
  try {
    const entries = await readdir(output.path);
    if (entries.length > 0) {
      throw new Error(`Output directory is not empty: ${output.relativePath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function rejectWriteFlags(args: Arguments): void {
  const forbidden = ["write", "write-attio", "sync", "apply"];
  const requested = forbidden.find((name) => args.flags.has(name));
  if (requested) {
    throw new Error(
      `--${requested} is unavailable: Phase 1 is structurally read-only`,
    );
  }
}

function researchSource(
  companies: Array<{ source: "attio" | "pipedrive" | "file" }>,
): "attio" | "pipedrive" | "file" {
  const first = companies[0]?.source;
  return first && companies.every((company) => company.source === first)
    ? first
    : "file";
}

async function snapshotAttio(args: Arguments): Promise<void> {
  const config = loadConfig();
  const reader = new AttioReader(
    requireSecret(config.attioToken, "ATTIO_API_TOKEN"),
  );
  const output = await commandOutput(
    config,
    args,
    `snapshots/attio-${timestamp()}`,
  );
  await assertOutputDirectoryIsEmpty(output);
  await withOutputLock(output, async () => {
    const [companies, people] = await Promise.all([
      reader.snapshotCompanies(),
      reader.snapshotPeople(),
    ]);
    const companiesWithDomains = companies.filter(
      (company) => company.domain,
    ).length;
    await Promise.all([
      writePrivateJson(output, "companies.json", companies),
      writePrivateJson(output, "people.json", people),
      writePrivateJson(output, "summary.json", {
        mode: "read_only",
        source: "attio",
        companies: companies.length,
        companiesWithDomains,
        companiesWithoutDomains: companies.length - companiesWithDomains,
        people: people.length,
        capturedAt: new Date().toISOString(),
      }),
    ]);
    await writeCompletionManifest(
      output,
      ["companies.json", "people.json", "summary.json"],
      {
        kind: "operational_read_only_snapshot",
        source: "attio",
        deletionSafety: "not_a_complete_deletion_safe_attio_backup",
        notice:
          "Operational read-only API snapshot only. NOT a complete deletion-safe Attio backup.",
        counts: {
          companies: companies.length,
          companiesWithDomains,
          companiesWithoutDomains: companies.length - companiesWithDomains,
          people: people.length,
        },
      },
    );
    console.log(
      JSON.stringify({
        mode: "read_only",
        companies: companies.length,
        companiesWithDomains,
        companiesWithoutDomains: companies.length - companiesWithDomains,
        people: people.length,
        output: output.relativePath,
      }),
    );
  });
}

async function snapshotPipedrive(args: Arguments): Promise<void> {
  const config = loadConfig();
  const reader = new PipedriveReader(
    requireSecret(config.pipedriveToken, "PIPEDRIVE_API_TOKEN"),
    config.pipedriveApiDomain,
  );
  const output = await commandOutput(
    config,
    args,
    `snapshots/pipedrive-${timestamp()}`,
  );
  await assertOutputDirectoryIsEmpty(output);
  await withOutputLock(output, async () => {
    const [organizations, people] = await Promise.all([
      reader.snapshotOrganizations(flag(args, "domain-field-key")),
      reader.snapshotPeople(),
    ]);
    const companiesWithDomains = organizations.filter(
      (organization) => organization.domain,
    ).length;
    await Promise.all([
      writePrivateJson(output, "companies.json", organizations),
      writePrivateJson(output, "people.json", people),
      writePrivateJson(output, "summary.json", {
        mode: "read_only",
        source: "pipedrive",
        companies: organizations.length,
        companiesWithDomains,
        companiesWithoutDomains: organizations.length - companiesWithDomains,
        people: people.length,
        capturedAt: new Date().toISOString(),
      }),
    ]);
    await writeCompletionManifest(
      output,
      ["companies.json", "people.json", "summary.json"],
      {
        kind: "operational_read_only_snapshot",
        source: "pipedrive",
        deletionSafety: "not_a_complete_deletion_safe_crm_backup",
        notice:
          "Operational read-only API snapshot only. NOT a complete deletion-safe CRM backup.",
        counts: {
          companies: organizations.length,
          companiesWithDomains,
          companiesWithoutDomains:
            organizations.length - companiesWithDomains,
          people: people.length,
        },
      },
    );
    console.log(
      JSON.stringify({
        mode: "read_only",
        companies: organizations.length,
        companiesWithDomains,
        companiesWithoutDomains: organizations.length - companiesWithDomains,
        people: people.length,
        output: output.relativePath,
      }),
    );
  });
}

async function reconcile(args: Arguments): Promise<void> {
  const config = loadConfig();
  const output = await commandOutput(
    config,
    args,
    `reconciliation/reconciliation-${timestamp()}`,
  );
  const attioPath =
    (await privateInput(output, args, "attio-people", { required: true })) ??
    "";
  const pipedrivePath =
    (await privateInput(output, args, "pipedrive-people", {
      required: true,
    })) ?? "";
  await assertOutputDirectoryIsEmpty(output);
  const [attioPeople, pipedrivePeople] = await Promise.all([
    readJson<AttioPersonSnapshot[]>(attioPath),
    readJson<PipedrivePersonSnapshot[]>(pipedrivePath),
  ]);

  let companyNames = new Map<string, string>();
  const attioCompaniesPath = await privateInput(
    output,
    args,
    "attio-companies",
  );
  if (attioCompaniesPath) {
    const companies = await loadCrmCompanySnapshots(attioCompaniesPath);
    companyNames = new Map(
      companies.flatMap((company) =>
        company.sourceRecordId ? [[company.sourceRecordId, company.name]] : [],
      ),
    );
  }

  await withOutputLock(output, async () => {
    const report = reconcilePeople(attioPeople, pipedrivePeople, companyNames);
    await writePrivateJson(output, "reconciliation.json", report);
    await writePrivateJson(output, "summary.json", {
      mode: "read_only",
      attioPeople: attioPeople.length,
      pipedrivePeople: pipedrivePeople.length,
      ...report.counts,
      output: output.relativePath,
    });
    console.log(
      JSON.stringify({
        mode: "read_only",
        attioPeople: attioPeople.length,
        pipedrivePeople: pipedrivePeople.length,
        ...report.counts,
        output: output.relativePath,
      }),
    );
  });
}

function heldUniverseCompany(
  company: UniverseCompany,
  decisions: CleanupDecision[],
): HeldCleanupCompany | null {
  const outcomes = company.sourceRecords.flatMap((record) => {
    const lookup = {
      ...(record.source === "attio"
        ? { companyAttioRecordId: record.sourceId }
        : {}),
      ...(record.companyNumber
        ? { companyNumber: record.companyNumber }
        : {}),
      ...(record.mergeDomain ? { companyDomain: record.mergeDomain } : {}),
    };
    if (Object.keys(lookup).length === 0) return [];
    const outcome = evaluateCleanupPolicy(decisions, lookup);
    const resolvedInsideCanonicalCompany =
      outcome.disposition === "redirected_match" &&
      Boolean(
        outcome.merge?.companyAttioRecordId &&
          company.sourceIds.attio.includes(
            outcome.merge.companyAttioRecordId,
          ),
      ) &&
      !outcome.merge?.personAttioRecordId &&
      outcome.company === "allow" &&
      outcome.contact === "allow" &&
      outcome.employment === "allow" &&
      outcome.conflicts.length === 0;
    if (resolvedInsideCanonicalCompany) return [];
    return outcome.disposition === "allow" ? [] : [outcome];
  });
  if (outcomes.length === 0) return null;
  const disposition = outcomes.some(
    (outcome) => outcome.disposition === "suppressed_match",
  )
    ? "suppressed_match"
    : outcomes.some((outcome) => outcome.disposition === "hold_for_review")
      ? "hold_for_review"
      : "redirected_match";
  return {
    companyId: company.id,
    name: company.preferredName,
    domain: company.mergeDomains[0] ?? "",
    disposition,
    directives: [...new Set(outcomes.flatMap((outcome) => outcome.directives))],
    matchedDecisionIds: [
      ...new Set(outcomes.flatMap((outcome) => outcome.matchedDecisionIds)),
    ].sort(),
  };
}

async function buildUniverse(args: Arguments): Promise<void> {
  const config = loadConfig();
  const output = await commandOutput(
    config,
    args,
    `universe/universe-${timestamp()}`,
  );
  await assertOutputDirectoryIsEmpty(output);
  const cleanupPath =
    (await privateInput(output, args, "cleanup-decisions", {
      required: true,
    })) ?? "";
  const cleanupManifestPath =
    (await privateInput(output, args, "cleanup-manifest", {
      required: true,
    })) ?? "";
  const identityResolutionsPath = await privateInput(
    output,
    args,
    "identity-resolutions",
  );
  const pathNames = [
    ["attioCompanies", "attio-companies"],
    ["pipedriveCompanies", "pipedrive-companies"],
    ["fileCompanies", "file-companies"],
    ["sitefinderProjects", "sitefinder-projects"],
  ] as const;
  const paths: CompanyUniverseInputPaths = {};
  for (const [property, flagName] of pathNames) {
    const path = await privateInput(output, args, flagName);
    if (path) paths[property] = path;
  }
  if (Object.keys(paths).length === 0) {
    throw new Error(
      "Universe compilation requires at least one company or SiteFinder input",
    );
  }

  const [capturedInputs, cleanupApproval, identityResolutionInput] =
    await Promise.all([
      captureCompanyUniverseInputs(paths),
      loadVerifiedCleanupApproval(cleanupPath, cleanupManifestPath),
      identityResolutionsPath
        ? captureImmutableInput(identityResolutionsPath)
        : Promise.resolve(undefined),
    ]);
  const inputs = parseCapturedCompanyUniverseInputs(capturedInputs);
  const decisions = cleanupApproval.decisions;
  const identityResolutionManifest = identityResolutionInput
    ? parseIdentityResolutionManifest(identityResolutionInput)
    : undefined;
  const universe = compileCompanyUniverse(inputs, identityResolutionManifest);
  const plan = createCompanyResearchPlan(universe);
  const heldBySourceIdentity = universe.companies
    .map((company) => heldUniverseCompany(company, decisions))
    .filter((company): company is HeldCleanupCompany => company !== null);
  const heldIds = new Set(heldBySourceIdentity.map((company) => company.companyId));
  const domainPartition = partitionCompaniesByCleanupPolicy(
    plan.companies.filter((company) => !heldIds.has(company.id)),
    decisions,
  );
  const heldCompanies = [...heldBySourceIdentity, ...domainPartition.held].sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.companyId.localeCompare(right.companyId),
  );
  const manifestEntries = Object.entries(capturedInputs).map(
    ([kind, captured]) => ({
      kind,
      sha256: captured.sha256,
      bytes: captured.byteLength,
    }),
  );
  if (identityResolutionInput) {
    manifestEntries.push({
      kind: "identityResolutions",
      sha256: identityResolutionInput.sha256,
      bytes: identityResolutionInput.byteLength,
    });
  }

  await withOutputLock(output, async () => {
    await Promise.all([
      writePrivateJson(output, "companies.json", domainPartition.allowed),
      writePrivateJsonLines(output, "universe.jsonl", universe.companies),
      writePrivateJson(output, "review.json", universe.reviewQueue),
      writePrivateJsonLines(output, "held-companies.jsonl", heldCompanies),
      writePrivateJson(output, "input-manifest.json", {
        schemaVersion: 1,
        capturedAt: new Date().toISOString(),
        inputs: manifestEntries,
        cleanupApproval: {
          ledgerSha256: cleanupApproval.ledgerInput.sha256,
          manifestSha256: cleanupApproval.manifestInput.sha256,
          decisions: decisions.length,
          approvedBy: cleanupApproval.manifest.approvedBy,
          approvedAt: cleanupApproval.manifest.approvedAt,
        },
        ...(identityResolutionInput && identityResolutionManifest
          ? {
              identityResolutions: {
                sha256: identityResolutionInput.sha256,
                mappings: identityResolutionManifest.resolutions.length,
                reviewedBy: identityResolutionManifest.reviewedBy,
                reviewedAt: identityResolutionManifest.reviewedAt,
                reason: identityResolutionManifest.reason,
              },
            }
          : {}),
      }),
      writePrivateJson(output, "summary.json", {
        mode: "read_only",
        ...universe.summary,
        researchableCompanies: domainPartition.allowed.length,
        identityReviewBlockedCompanies: plan.blockedCompanyIds.length,
        cleanupHeldCompanies: heldCompanies.length,
      }),
    ]);
    await writeCompletionManifest(
      output,
      [
        "companies.json",
        "universe.jsonl",
        "review.json",
        "held-companies.jsonl",
        "input-manifest.json",
        "summary.json",
      ],
      {
        kind: "company_universe",
        counts: {
          inputRows: universe.summary.inputRows,
          canonicalCompanies: universe.summary.companies,
          researchableCompanies: domainPartition.allowed.length,
          reviewItems: universe.summary.reviewItems,
          cleanupHeldCompanies: heldCompanies.length,
          identityMappings: universe.summary.identityMappings,
          mappedSiteFinderIdentities:
            universe.summary.mappedSiteFinderIdentities,
          unmappedSiteFinderIdentities:
            universe.summary.unmappedSiteFinderIdentities,
          identityResolutionConflicts:
            universe.summary.identityResolutionConflicts,
        },
        inputs: {
          cleanupLedgerSha256: cleanupApproval.ledgerInput.sha256,
          cleanupManifestSha256: cleanupApproval.manifestInput.sha256,
          ...(identityResolutionInput
            ? {
                identityResolutionsSha256: identityResolutionInput.sha256,
              }
            : {}),
        },
      },
    );
  });

  console.log(
    JSON.stringify({
      mode: "read_only",
      inputRows: universe.summary.inputRows,
      canonicalCompanies: universe.summary.companies,
      researchableCompanies: domainPartition.allowed.length,
      reviewItems: universe.summary.reviewItems,
      cleanupHeldCompanies: heldCompanies.length,
      identityMappings: universe.summary.identityMappings,
      unmappedSiteFinderIdentities:
        universe.summary.unmappedSiteFinderIdentities,
      output: output.relativePath,
    }),
  );
}

async function enrich(
  args: Arguments,
  invocation?: QueueEnrichInvocation,
): Promise<void> {
  const config = loadConfig();
  const output = await commandOutput(
    config,
    args,
    `enrichment/enrichment-${timestamp()}`,
  );
  const input =
    (await privateInput(output, args, "input", { required: true })) ?? "";
  const cleanupPath =
    (await privateInput(output, args, "cleanup-decisions", {
      required: true,
    })) ?? "";
  const cleanupManifestPath =
    (await privateInput(output, args, "cleanup-manifest", {
      required: true,
    })) ?? "";
  const attioPeoplePath =
    (await privateInput(output, args, "attio-people", {
      required: true,
    })) ?? "";
  const attioSnapshotManifestPath =
    (await privateInput(output, args, "attio-snapshot-manifest", {
      required: true,
    })) ?? "";
  const pipedrivePeoplePath =
    (await privateInput(output, args, "pipedrive-people", {
      required: true,
    })) ?? "";
  const pipedriveSnapshotManifestPath =
    (await privateInput(output, args, "pipedrive-snapshot-manifest", {
      required: true,
    })) ?? "";
  if (args.flags.has("limit") || args.flags.has("confirm-large-run")) {
    throw new Error(
      "Alphabetical --limit selection is disabled; use --company-id or a reviewed --pilot-manifest",
    );
  }
  const requestedId = flag(args, "company-id");
  if (invocation && requestedId) {
    throw new Error("Queued research cannot override its reviewed company IDs");
  }
  const pilotManifestPath = requestedId || invocation
    ? undefined
    : await privateInput(output, args, "pilot-manifest", {
        required: true,
      });
  const [
    companyInput,
    cleanupApproval,
    attioPeopleInput,
    attioSnapshotManifestInput,
    pipedrivePeopleInput,
    pipedriveSnapshotManifestInput,
    pilotManifestInput,
  ] = await Promise.all([
    captureImmutableInput(input),
    loadVerifiedCleanupApproval(cleanupPath, cleanupManifestPath),
    captureImmutableInput(attioPeoplePath),
    captureImmutableInput(attioSnapshotManifestPath),
    captureImmutableInput(pipedrivePeoplePath),
    captureImmutableInput(pipedriveSnapshotManifestPath),
    pilotManifestPath
      ? captureImmutableInput(pilotManifestPath)
      : Promise.resolve(undefined),
  ]);
  const verifiedAttio = verifyPeopleSnapshotInput(
    attioPeopleInput,
    attioSnapshotManifestInput,
    "attio",
  );
  const verifiedPipedrive = verifyPeopleSnapshotInput(
    pipedrivePeopleInput,
    pipedriveSnapshotManifestInput,
    "pipedrive",
  );
  const attioPeople = parseCapturedAttioPeople(verifiedAttio.dataInput);
  const pipedrivePeople = parseCapturedPipedrivePeople(
    verifiedPipedrive.dataInput,
  );
  if (attioPeople.length !== verifiedAttio.expectedPeopleCount) {
    throw new Error(
      "Attio people snapshot count does not match its completion manifest",
    );
  }
  if (pipedrivePeople.length !== verifiedPipedrive.expectedPeopleCount) {
    throw new Error(
      "Pipedrive people snapshot count does not match its completion manifest",
    );
  }
  if (
    Date.parse(verifiedAttio.completedAt) <
    Date.parse(cleanupApproval.manifest.approvedAt)
  ) {
    throw new Error(
      "Attio people snapshot must be captured after cleanup approval",
    );
  }
  const allCompanies = parseCapturedCompanySeeds(companyInput);
  const cleanupDecisions = cleanupApproval.decisions;
  const companyInputHash = companyInput.sha256;
  const cleanupInputHash = cleanupApproval.ledgerInput.sha256;
  const cleanupManifestHash = cleanupApproval.manifestInput.sha256;
  const reviewedPilot = pilotManifestInput
    ? selectReviewedPilotCompanies(
        allCompanies,
        companyInput,
        pilotManifestInput,
      )
    : undefined;
  if (
    reviewedPilot &&
    (reviewedPilot.manifest.attioPeopleSha256 !==
      attioPeopleInput.sha256 ||
      reviewedPilot.manifest.pipedrivePeopleSha256 !==
        pipedrivePeopleInput.sha256)
  ) {
    throw new Error(
      "Reviewed pilot manifest does not match the verified CRM people snapshots",
    );
  }
  let requested: CompanySeed[];
  if (invocation) {
    const uniqueIds = new Set(invocation.companyIds);
    if (uniqueIds.size !== invocation.companyIds.length) {
      throw new Error("Queued research company IDs must be unique");
    }
    const companiesById = new Map(
      allCompanies.map((company) => [company.id, company]),
    );
    requested = invocation.companyIds.flatMap((companyId) => {
      const company = companiesById.get(companyId);
      return company ? [company] : [];
    });
    if (requested.length !== invocation.companyIds.length) {
      throw new Error(
        "Queued company input does not match the reviewed company IDs",
      );
    }
  } else {
    requested = requestedId
      ? allCompanies.filter((company) => company.id === requestedId)
      : (reviewedPilot?.companies ?? []);
  }
  if (requested.length === 0) throw new Error("No companies matched the run");
  if (requestedId && requested.length !== 1) {
    throw new Error(
      `--company-id must identify exactly one company; matched ${requested.length}`,
    );
  }
  const policyPartition = partitionCompaniesByCleanupPolicy(
    requested,
    cleanupDecisions,
  );
  const selected = policyPartition.allowed;
  if (invocation && selected.length !== requested.length) {
    throw new Error(
      "One or more queued companies are withheld by the approved cleanup policy",
    );
  }
  await assertOutputDirectoryIsEmpty(output);

  const companiesHouse = enabled(args, "with-companies-house")
    ? new CompaniesHouseReader(
        requireSecret(
          config.companiesHouseApiKey,
          "COMPANIES_HOUSE_API_KEY",
        ),
      )
    : undefined;
  const apolloMaxPeople = integerFlag(args, "apollo-max-people", 10, {
    min: 1,
    max: 25,
  });
  const apollo = enabled(args, "with-apollo")
    ? new ApolloPeopleReader(
        requireSecret(config.apolloApiKey, "APOLLO_API_KEY"),
        { maxPeople: apolloMaxPeople },
      )
    : undefined;
  const maxPages = integerFlag(args, "max-pages", config.crawler.maxPages, {
    min: 1,
    max: 50,
  });
  const maxPdfs = integerFlag(args, "max-pdfs", config.crawler.maxPdfs, {
    min: 0,
    max: 10,
  });
  const publishProgress = enabled(args, "publish-progress");
  const concurrency = integerFlag(args, "concurrency", publishProgress ? 1 : 2, {
    min: 1,
    max: publishProgress ? 1 : 4,
  });
  const procurementDays = integerFlag(args, "procurement-days", 0, {
    min: 0,
    max: 365,
  });
  const runName = (
    flag(args, "run-name", { fallback: "Main contractor research" }) ?? ""
  ).trim();
  if (!runName || runName.length > 120) {
    throw new Error("--run-name must be between 1 and 120 characters");
  }
  const progress =
    publishProgress && selected.length > 0
      ? invocation?.progress ??
        new SiteFinderProgressPublisher({
          endpoint: requireSecret(
            config.researchAgentIngestUrl,
            "RESEARCH_AGENT_INGEST_URL",
          ),
          token: requireSecret(
            config.researchAgentIngestToken,
            "RESEARCH_AGENT_INGEST_TOKEN",
          ),
        })
      : undefined;

  await withOutputLock(output, async () => {
    try {
      await progress?.start({
        name: runName,
        source: researchSource(selected),
        companies: selected,
        configuration: {
          maxPages,
          maxPdfs,
          concurrency,
          procurementDays,
          companiesHouse: Boolean(companiesHouse),
          apollo: Boolean(apollo),
          ...(apollo ? { apolloMaxPeople } : {}),
          companyInputSha256: companyInputHash,
          cleanupDecisionsSha256: cleanupInputHash,
          cleanupManifestSha256: cleanupManifestHash,
          cleanupDecisionCount: cleanupDecisions.length,
          attioPeopleSha256: attioPeopleInput.sha256,
          pipedrivePeopleSha256: pipedrivePeopleInput.sha256,
          attioPeopleCount: attioPeople.length,
          pipedrivePeopleCount: pipedrivePeople.length,
          selectionMode: invocation
            ? "sitefinder_queue"
            : requestedId
              ? "single_company"
              : "reviewed_pilot",
          ...(pilotManifestInput
            ? {
                pilotManifestSha256: pilotManifestInput.sha256,
                pilotReviewedBy: reviewedPilot?.manifest.reviewedBy,
                pilotReviewedAt: reviewedPilot?.manifest.reviewedAt,
              }
            : {}),
        },
      });
      const run = await enrichCompanies(selected, {
        crawl: {
          maxPages,
          maxPdfs,
          delayMs: config.crawler.delayMs,
          timeoutMs: config.crawler.timeoutMs,
          userAgent: config.crawler.userAgent,
        },
        concurrency,
        ...(companiesHouse ? { companiesHouse } : {}),
        ...(apollo ? { apollo } : {}),
        cleanupDecisions,
        attioPeople,
        pipedrivePeople,
        procurementDays,
        ...(progress
          ? { onProgress: (event) => progress.publish(event) }
          : {}),
      });
      run.heldCompanies = policyPartition.held;
      run.heldCompanyCount = policyPartition.held.length;
      await writeEnrichmentRun(output, run);
      await writePrivateJson(output, "input-manifest.json", {
        schemaVersion: 1,
        capturedAt: new Date().toISOString(),
        companies: {
          sha256: companyInputHash,
          selectedBeforePolicy: requested.length,
          selectedForResearch: selected.length,
          completed: run.completedCompanyCount,
          failed: run.failedCompanyCount,
          skipped: run.skippedCompanyCount,
          cancelled: run.cancelledCompanyCount,
        },
        cleanupDecisions: {
          sha256: cleanupInputHash,
          decisions: cleanupDecisions.length,
          heldCompanies: policyPartition.held.length,
        },
        cleanupApprovalManifest: {
          sha256: cleanupManifestHash,
          approvedBy: cleanupApproval.manifest.approvedBy,
          approvedAt: cleanupApproval.manifest.approvedAt,
        },
        crmSnapshots: {
          attio: {
            peopleSha256: attioPeopleInput.sha256,
            manifestSha256: attioSnapshotManifestInput.sha256,
            people: attioPeople.length,
          },
          pipedrive: {
            peopleSha256: pipedrivePeopleInput.sha256,
            manifestSha256: pipedriveSnapshotManifestInput.sha256,
            people: pipedrivePeople.length,
          },
        },
        selection: invocation
          ? {
              mode: "sitefinder_queue",
              runId: invocation.runId,
              companyIds: invocation.companyIds,
            }
          : requestedId
          ? {
              mode: "single_company",
              companyId: requestedId,
            }
          : {
              mode: "reviewed_pilot",
              manifestSha256: pilotManifestInput?.sha256,
              reviewedBy: reviewedPilot?.manifest.reviewedBy,
              reviewedAt: reviewedPilot?.manifest.reviewedAt,
              purpose: reviewedPilot?.manifest.purpose,
            },
      });
      await progress?.complete(run);
      await writeCompletionManifest(
        output,
        [
          "summary.json",
          "companies.jsonl",
          "contacts.jsonl",
          "evidence.jsonl",
          "projects.jsonl",
          "held-matches.jsonl",
          "held-companies.jsonl",
          "crm-comparisons.jsonl",
          "review.json",
          "input-manifest.json",
        ],
        {
          kind: "enrichment_run",
          counts: {
            companies: run.companyCount,
            contacts: run.contactCount,
            evidence: run.evidenceCount,
            projectSignals: run.projectSignalCount,
            cleanupHeldCompanies: run.heldCompanyCount,
            cleanupHeldMatches: run.heldMatchCount,
            completedCompanies: run.completedCompanyCount,
            failedCompanies: run.failedCompanyCount,
            skippedCompanies: run.skippedCompanyCount,
            cancelledCompanies: run.cancelledCompanyCount,
            alreadyInAttio: run.crmComparisonCounts.already_in_attio,
            pipedriveOnly: run.crmComparisonCounts.pipedrive_only,
            missingFromBoth: run.crmComparisonCounts.missing_from_both,
            crmConflicts:
              run.crmComparisonCounts.conflicting_multiple_matches,
            unverifiableNoEmail:
              run.crmComparisonCounts.unverifiable_no_email,
          },
          inputs: {
            companiesSha256: companyInputHash,
            cleanupLedgerSha256: cleanupInputHash,
            cleanupManifestSha256: cleanupManifestHash,
            attioPeopleSha256: attioPeopleInput.sha256,
            attioSnapshotManifestSha256:
              attioSnapshotManifestInput.sha256,
            pipedrivePeopleSha256: pipedrivePeopleInput.sha256,
            pipedriveSnapshotManifestSha256:
              pipedriveSnapshotManifestInput.sha256,
            ...(pilotManifestInput
              ? { pilotManifestSha256: pilotManifestInput.sha256 }
              : {}),
          },
        },
      );
      console.log(
        JSON.stringify({
          mode: run.mode,
          companies: run.companyCount,
          runStatus: run.status,
          completedCompanies: run.completedCompanyCount,
          failedCompanies: run.failedCompanyCount,
          skippedCompanies: run.skippedCompanyCount,
          cancelledCompanies: run.cancelledCompanyCount,
          contacts: run.contactCount,
          evidence: run.evidenceCount,
          projectSignals: run.projectSignalCount,
          cleanupHeldCompanies: run.heldCompanyCount,
          cleanupHeldMatches: run.heldMatchCount,
          crmComparison: run.crmComparisonCounts,
          progressPublished: Boolean(progress),
          progressFailures: progress?.failureCount ?? 0,
          output: output.relativePath,
        }),
      );
    } catch (error) {
      if (!invocation) await progress?.fail(error);
      throw error;
    }
  });
}

function queueArguments(
  run: ClaimedResearchRun,
  inputPath: string,
  inputs: Awaited<ReturnType<typeof loadQueueInputManifest>>,
): Arguments {
  const flags = new Map<string, string | true>([
    ["input", inputPath],
    ["output", `queue-runs/${run.id}`],
    ["cleanup-decisions", inputs.cleanupDecisions],
    ["cleanup-manifest", inputs.cleanupManifest],
    ["attio-people", inputs.attioPeople],
    ["attio-snapshot-manifest", inputs.attioSnapshotManifest],
    ["pipedrive-people", inputs.pipedrivePeople],
    ["pipedrive-snapshot-manifest", inputs.pipedriveSnapshotManifest],
    ["publish-progress", true],
    ["run-name", run.name],
    ["concurrency", "1"],
    ["apollo-max-people", String(run.apolloMaxPeople)],
    [
      "procurement-days",
      run.requestedSources.includes("procurement")
        ? String(run.procurementDays)
        : "0",
    ],
  ]);
  if (run.requestedSources.includes("apollo")) {
    flags.set("with-apollo", true);
  }
  if (run.requestedSources.includes("companiesHouse")) {
    flags.set("with-companies-house", true);
  }
  return { command: "enrich", flags };
}

async function preflightQueueInputs(
  inputs: Awaited<ReturnType<typeof loadQueueInputManifest>>,
): Promise<void> {
  const [
    cleanupApproval,
    attioPeopleInput,
    attioManifestInput,
    pipedrivePeopleInput,
    pipedriveManifestInput,
  ] = await Promise.all([
    loadVerifiedCleanupApproval(
      inputs.cleanupDecisions,
      inputs.cleanupManifest,
    ),
    captureImmutableInput(inputs.attioPeople),
    captureImmutableInput(inputs.attioSnapshotManifest),
    captureImmutableInput(inputs.pipedrivePeople),
    captureImmutableInput(inputs.pipedriveSnapshotManifest),
  ]);
  const attio = verifyPeopleSnapshotInput(
    attioPeopleInput,
    attioManifestInput,
    "attio",
  );
  const pipedrive = verifyPeopleSnapshotInput(
    pipedrivePeopleInput,
    pipedriveManifestInput,
    "pipedrive",
  );
  const attioPeople = parseCapturedAttioPeople(attio.dataInput);
  const pipedrivePeople = parseCapturedPipedrivePeople(pipedrive.dataInput);
  if (
    attioPeople.length !== attio.expectedPeopleCount ||
    pipedrivePeople.length !== pipedrive.expectedPeopleCount
  ) {
    throw new Error(
      "Queue CRM people snapshots do not match their completion manifests",
    );
  }
  if (
    Date.parse(attio.completedAt) <
    Date.parse(cleanupApproval.manifest.approvedAt)
  ) {
    throw new Error(
      "Queue Attio snapshot must be captured after cleanup approval",
    );
  }
}

async function runQueue(): Promise<void> {
  const config = loadConfig();
  const endpoint = requireSecret(
    config.researchAgentIngestUrl,
    "RESEARCH_AGENT_INGEST_URL",
  );
  const token = requireSecret(
    config.researchAgentIngestToken,
    "RESEARCH_AGENT_INGEST_TOKEN",
  );
  const manifest = requireSecret(
    config.researchQueueInputManifest,
    "RESEARCH_QUEUE_INPUT_MANIFEST",
  );
  const preflightOutput = await resolvePrivateOutputDirectory({
    privateDataDirectory: config.privateDataDirectory,
    requestedDirectory: "queue-runs/preflight",
  });
  const inputs = await loadQueueInputManifest(
    preflightOutput.rootDirectory,
    manifest,
  );
  await preflightQueueInputs(inputs);

  const queue = new SiteFinderQueueClient({ endpoint, token });
  const run = await queue.claim(config.researchWorkerId);
  if (!run) {
    console.log(JSON.stringify({ claimed: false }));
    return;
  }

  const progress = new SiteFinderProgressPublisher({
    endpoint,
    token,
    runId: run.id,
    initialSequence: 1,
  });
  try {
    if (run.requestedSources.includes("apollo")) {
      requireSecret(config.apolloApiKey, "APOLLO_API_KEY");
    }
    if (run.requestedSources.includes("companiesHouse")) {
      requireSecret(
        config.companiesHouseApiKey,
        "COMPANIES_HOUSE_API_KEY",
      );
    }
    const inputOutput = await resolvePrivateOutputDirectory({
      privateDataDirectory: config.privateDataDirectory,
      requestedDirectory: `queue-inputs/${run.id}`,
    });
    await assertOutputDirectoryIsEmpty(inputOutput);
    await writePrivateJson(
      inputOutput,
      "companies.json",
      run.companies.map((company) => ({
        id: company.companyId,
        name: company.companyName,
        domain: company.domain,
        websiteUrl: `https://${company.domain}`,
        ...(company.apolloSearchDomain
          ? { apolloSearchDomain: company.apolloSearchDomain }
          : {}),
        source: "file",
      })),
    );
    await enrich(
      queueArguments(
        run,
        privateOutputFile(inputOutput, "companies.json"),
        inputs,
      ),
      {
        runId: run.id,
        companyIds: run.companies.map((company) => company.companyId),
        progress,
      },
    );
  } catch (error) {
    await progress.fail(error);
    throw error;
  }
}

function printHelp(): void {
  console.log(CLI_HELP_TEXT);
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  rejectWriteFlags(args);
  switch (args.command) {
    case "snapshot-attio":
      await snapshotAttio(args);
      break;
    case "snapshot-pipedrive":
      await snapshotPipedrive(args);
      break;
    case "reconcile":
      await reconcile(args);
      break;
    case "universe":
      await buildUniverse(args);
      break;
    case "enrich":
      await enrich(args);
      break;
    case "run-queue":
      await runQueue();
      break;
    case "help":
    case "--help":
    case undefined:
      printHelp();
      break;
    default:
      throw new Error(`Unknown command: ${args.command}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exitCode = 1;
});
