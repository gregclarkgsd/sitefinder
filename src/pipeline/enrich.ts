import type {
  CompanySeed,
  EnrichedCompany,
  Evidence,
  ProjectSignal,
} from "../types.js";
import { crawlCompanyWebsite, type CrawlOptions } from "../crawler/crawl.js";
import { CompaniesHouseReader } from "../public-data/companies-house.js";
import {
  fetchContractsFinderReleases,
  fetchFindATenderReleases,
  matchProcurementReleases,
} from "../public-data/procurement.js";

export interface EnrichmentOptions {
  crawl: CrawlOptions;
  concurrency: number;
  companiesHouse?: CompaniesHouseReader;
  procurementDays: number;
  fetchImpl?: typeof fetch;
}

export interface EnrichmentRun {
  mode: "read_only";
  startedAt: string;
  completedAt: string;
  companyCount: number;
  contactCount: number;
  evidenceCount: number;
  projectSignalCount: number;
  companies: EnrichedCompany[];
}

function emptyResult(company: CompanySeed, warning: string): EnrichedCompany {
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

export async function enrichCompanies(
  companies: CompanySeed[],
  options: EnrichmentOptions,
): Promise<EnrichmentRun> {
  const startedAt = new Date().toISOString();
  const results = await workerPool(
    companies,
    options.concurrency,
    async (company) => {
      let result: EnrichedCompany;
      try {
        result = await crawlCompanyWebsite(company, options.crawl);
      } catch (error) {
        result = emptyResult(
          company,
          `Website crawl failed: ${error instanceof Error ? error.message : "unknown error"}`,
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

  return {
    mode: "read_only",
    startedAt,
    completedAt: new Date().toISOString(),
    companyCount: results.length,
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
    companies: results,
  };
}
