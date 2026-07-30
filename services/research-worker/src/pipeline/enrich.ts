import type {
  AttioPersonSnapshot,
  CompanySeed,
  ContactCandidate,
  ContactPoint,
  EnrichedCompany,
  Evidence,
  PipedrivePersonSnapshot,
  ProjectSignal,
} from "../types.js";
import {
  createDiscoveryComparator,
  DISCOVERY_COMPARISON_STATUSES,
  type DiscoveryComparisonStatus,
  type LocalDiscoveryComparison,
  type SiteFinderDiscoveryComparison,
} from "../comparison/discovery-comparison.js";
import {
  crawlCompanyWebsite,
  type CrawlOptions,
  type CrawlProgressEvent,
} from "../crawler/crawl.js";
import {
  applyCleanupPolicyToCompany,
  indexAttioPeopleForCleanup,
  type HeldCleanupCompany,
  type HeldCleanupMatch,
} from "../policy/apply-cleanup-policy.js";
import type { CleanupDecision } from "../policy/cleanup-policy.js";
import { CompaniesHouseReader } from "../public-data/companies-house.js";
import { ApolloPeopleReader } from "../public-data/apollo.js";
import {
  fetchContractsFinderReleases,
  fetchFindATenderReleases,
  matchProcurementReleases,
} from "../public-data/procurement.js";

export interface EnrichmentOptions {
  crawl: CrawlOptions;
  concurrency: number;
  companiesHouse?: CompaniesHouseReader;
  apollo?: ApolloPeopleReader;
  cleanupDecisions: CleanupDecision[];
  attioPeople: AttioPersonSnapshot[];
  pipedrivePeople: PipedrivePersonSnapshot[];
  procurementDays: number;
  fetchImpl?: typeof fetch;
  onProgress?: (
    event: EnrichmentProgressEvent,
  ) => Promise<EnrichmentProgressDecision | void>;
}

export type EnrichmentProgressDecision = "continue" | "stop";

export type EnrichmentProgressEvent =
  | { kind: "company_started"; company: CompanySeed }
  | { kind: "company_skipped"; company: CompanySeed; reason: string }
  | {
      kind: "crawl";
      company: CompanySeed;
      crawl: CrawlProgressEvent;
    }
  | {
      kind: "company_completed";
      company: CompanySeed;
      result: EnrichedCompany;
      heldMatches: HeldCleanupMatch[];
      crmComparisons: SiteFinderDiscoveryComparison[];
    };

export interface EnrichmentRun {
  mode: "read_only";
  status: "completed" | "partial" | "failed" | "cancelled";
  startedAt: string;
  completedAt: string;
  companyCount: number;
  completedCompanyCount: number;
  failedCompanyCount: number;
  skippedCompanyCount: number;
  cancelledCompanyCount: number;
  contactCount: number;
  evidenceCount: number;
  projectSignalCount: number;
  heldMatchCount: number;
  heldMatches: HeldCleanupMatch[];
  heldCompanyCount: number;
  heldCompanies: HeldCleanupCompany[];
  crmComparisonCounts: Record<DiscoveryComparisonStatus, number>;
  crmComparisons: LocalDiscoveryComparison[];
  companies: EnrichedCompany[];
}

function emptyResult(
  company: CompanySeed,
  warning: string,
  crawlStatus: "failed" | "skipped",
): EnrichedCompany {
  return {
    company,
    facts: {},
    contacts: [],
    projects: [],
    website: {
      offices: [],
      sectors: [],
      projectNames: [],
      hiringRoles: [],
      genericEmails: [],
      genericPhones: [],
      socialUrls: [],
    },
    evidence: [],
    pagesVisited: [],
    pagesSkipped: [],
    warnings: [warning],
    crawlStatus,
    completedAt: new Date().toISOString(),
  };
}

async function workerPool<T, R>(
  values: T[],
  concurrency: number,
  task: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, values.length)) },
    async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= values.length) return;
        const value = values[index];
        if (value === undefined) return;
        results[index] = await task(value);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function attachProcurement(
  results: EnrichedCompany[],
  signals: ProjectSignal[],
  evidence: Evidence[],
): void {
  const byCompany = new Map(results.map((result) => [result.company.id, result]));
  for (const signal of signals) byCompany.get(signal.companyId)?.projects.push(signal);
  for (const item of evidence) byCompany.get(item.companyId)?.evidence.push(item);
}

const contactPointPriority: Record<ContactPoint["status"], number> = {
  public: 5,
  licensed_provider: 4,
  existing: 3,
  inferred: 2,
  unknown: 1,
};

function mergeContactPoints(
  existing: ContactPoint[],
  incoming: ContactPoint[],
): ContactPoint[] {
  const byValue = new Map<string, ContactPoint>();
  for (const point of [...existing, ...incoming]) {
    const key = point.value.trim().toLowerCase();
    if (!key) continue;
    const current = byValue.get(key);
    if (
      !current ||
      contactPointPriority[point.status] >
        contactPointPriority[current.status]
    ) {
      byValue.set(key, point);
    }
  }
  return [...byValue.values()];
}

function mergeApolloContacts(
  existing: ContactCandidate[],
  incoming: ContactCandidate[],
): ContactCandidate[] {
  const merged = [...existing];
  for (const contact of incoming) {
    const index = merged.findIndex(
      (candidate) =>
        candidate.normalizedName === contact.normalizedName &&
        candidate.roleCategory === contact.roleCategory,
    );
    if (index < 0) {
      merged.push(contact);
      continue;
    }
    const current = merged[index]!;
    merged[index] = {
      ...current,
      emails: mergeContactPoints(current.emails, contact.emails),
      phones: mergeContactPoints(current.phones, contact.phones),
      profileUrls: [...new Set([...current.profileUrls, ...contact.profileUrls])],
      evidenceIds: [...new Set([...current.evidenceIds, ...contact.evidenceIds])],
      confidence: Math.max(current.confidence, contact.confidence),
      rolePriority: Math.max(current.rolePriority, contact.rolePriority),
    };
  }
  return merged;
}

export async function enrichCompanies(
  companies: CompanySeed[],
  options: EnrichmentOptions,
): Promise<EnrichmentRun> {
  if (options.cleanupDecisions.length === 0) {
    throw new Error(
      "Enrichment requires a non-empty, verified cleanup decision ledger",
    );
  }
  const startedAt = new Date().toISOString();
  const heldMatches: HeldCleanupMatch[] = [];
  const crmComparisons: LocalDiscoveryComparison[] = [];
  const discoveryComparator = createDiscoveryComparator(
    options.attioPeople,
    options.pipedrivePeople,
  );
  const cleanupPersonIndex = indexAttioPeopleForCleanup(
    options.attioPeople,
  );
  let stopRequested = false;
  const results = await workerPool(
    companies,
    options.concurrency,
    async (company) => {
      let result: EnrichedCompany;
      if (stopRequested) {
        const reason = "Skipped after the operator requested a safe stop.";
        await options.onProgress?.({
          kind: "company_skipped",
          company,
          reason,
        });
        return emptyResult(company, reason, "skipped");
      }
      try {
        const decision = await options.onProgress?.({
          kind: "company_started",
          company,
        });
        if (decision === "stop") {
          stopRequested = true;
          const reason = "Skipped after the operator requested a safe stop.";
          await options.onProgress?.({
            kind: "company_skipped",
            company,
            reason,
          });
          return emptyResult(company, reason, "skipped");
        }
        result = await crawlCompanyWebsite(company, {
          ...options.crawl,
          ...(options.onProgress
            ? {
                onProgress: async (crawl) =>
                  options.onProgress?.({
                    kind: "crawl",
                    company,
                    crawl,
                  }),
              }
            : {}),
        });
      } catch (error) {
        result = emptyResult(
          company,
          `Website crawl failed: ${error instanceof Error ? error.message : "unknown error"}`,
          "failed",
        );
      }
      if (options.companiesHouse) {
        try {
          const publicFacts = await options.companiesHouse.enrich(company);
          result.facts = { ...result.facts, ...publicFacts.facts };
          result.evidence.push(...publicFacts.evidence);
          result.warnings.push(...publicFacts.warnings);
        } catch (error) {
          result.warnings.push(
            `Companies House lookup failed: ${error instanceof Error ? error.message : "unknown error"}`,
          );
        }
      }
      if (options.apollo) {
        try {
          const licensedPeople = await options.apollo.enrich(company);
          result.contacts = mergeApolloContacts(
            result.contacts,
            licensedPeople.contacts,
          );
          result.evidence.push(...licensedPeople.evidence);
          result.warnings.push(...licensedPeople.warnings);
        } catch (error) {
          result.warnings.push(
            `Apollo lookup failed: ${error instanceof Error ? error.message : "unknown error"}`,
          );
        }
      }
      const policyFiltered = applyCleanupPolicyToCompany(
        result,
        options.cleanupDecisions,
        cleanupPersonIndex,
      );
      result = policyFiltered.result;
      heldMatches.push(...policyFiltered.heldMatches);
      const comparison = discoveryComparator.compare(result.contacts);
      crmComparisons.push(...comparison.local);
      const decision = await options.onProgress?.({
        kind: "company_completed",
        company,
        result,
        heldMatches: policyFiltered.heldMatches,
        crmComparisons: comparison.siteFinder,
      });
      if (decision === "stop") stopRequested = true;
      return result;
    },
  );

  if (options.procurementDays > 0) {
    const to = new Date();
    const from = new Date(to.getTime() - options.procurementDays * 86_400_000);
    const requestOptions = options.fetchImpl
      ? { fetchImpl: options.fetchImpl, maxPages: 20 }
      : { maxPages: 20 };
    try {
      const [fts, contractsFinder] = await Promise.all([
        fetchFindATenderReleases(from, to, requestOptions),
        fetchContractsFinderReleases(from, to, requestOptions),
      ]);
      const ftsMatches = matchProcurementReleases(
        companies,
        fts,
        "find_a_tender",
      );
      const contractsMatches = matchProcurementReleases(
        companies,
        contractsFinder,
        "contracts_finder",
      );
      attachProcurement(results, ftsMatches.signals, ftsMatches.evidence);
      attachProcurement(
        results,
        contractsMatches.signals,
        contractsMatches.evidence,
      );
    } catch (error) {
      for (const result of results) {
        result.warnings.push(
          `Procurement lookup failed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    }
  }

  const completedCompanyCount = results.filter(
    (result) => result.crawlStatus === "completed",
  ).length;
  const skippedCompanyCount = results.filter(
    (result) => result.crawlStatus === "skipped",
  ).length;
  const cancelledCompanyCount = results.filter(
    (result) => result.crawlStatus === "cancelled",
  ).length;
  const failedCompanyCount = results.filter(
    (result) =>
      result.crawlStatus === "failed" ||
      result.crawlStatus === "blocked",
  ).length;
  const status: EnrichmentRun["status"] =
    skippedCompanyCount > 0 || cancelledCompanyCount > 0
      ? "cancelled"
      : results.length > 0 && completedCompanyCount === 0
        ? "failed"
        : failedCompanyCount > 0
          ? "partial"
          : "completed";
  const sortedCrmComparisons = crmComparisons.sort((left, right) =>
    left.candidateId.localeCompare(right.candidateId),
  );
  const crmComparisonCounts = Object.fromEntries(
    DISCOVERY_COMPARISON_STATUSES.map((comparisonStatus) => [
      comparisonStatus,
      sortedCrmComparisons.filter(
        (item) => item.status === comparisonStatus,
      ).length,
    ]),
  ) as Record<DiscoveryComparisonStatus, number>;

  return {
    mode: "read_only",
    status,
    startedAt,
    completedAt: new Date().toISOString(),
    companyCount: results.length,
    completedCompanyCount,
    failedCompanyCount,
    skippedCompanyCount,
    cancelledCompanyCount,
    contactCount: results.reduce(
      (total, result) => total + result.contacts.length,
      0,
    ),
    evidenceCount: results.reduce(
      (total, result) => total + result.evidence.length,
      0,
    ),
    projectSignalCount: results.reduce(
      (total, result) => total + result.projects.length,
      0,
    ),
    heldMatchCount: heldMatches.length,
    heldMatches: heldMatches.sort(
      (left, right) =>
        left.companyId.localeCompare(right.companyId) ||
        (left.contactId ?? "").localeCompare(right.contactId ?? "") ||
        left.id.localeCompare(right.id),
    ),
    heldCompanyCount: 0,
    heldCompanies: [],
    crmComparisonCounts,
    crmComparisons: sortedCrmComparisons,
    companies: results,
  };
}
