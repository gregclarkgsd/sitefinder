import { setTimeout as delay } from "node:timers/promises";
import { PDFParse } from "pdf-parse";
import robotsParserModule from "robots-parser";
import * as cheerio from "cheerio";
import type {
  CompanySeed,
  ContactCandidate,
  EnrichedCompany,
  Evidence,
  WebsiteSignal,
} from "../types.js";
import { canonicalDomain, stableId } from "../lib/normalize.js";
import {
  decodeUtf8,
  fetchPublicResource,
  type FetchResourceOptions,
} from "../lib/http.js";
import type { DnsLookup } from "../lib/public-url.js";
import { extractHtmlPage, extractPdfText, type PageExtraction } from "./extract.js";

export interface CrawlOptions {
  maxPages: number;
  maxPdfs: number;
  delayMs: number;
  timeoutMs: number;
  userAgent: string;
  fetchImpl?: typeof fetch;
  lookup?: DnsLookup;
  now?: () => Date;
  onProgress?: (
    event: CrawlProgressEvent,
  ) => Promise<"continue" | "stop" | void>;
}

export interface CrawlProgressEvent {
  kind: "robots" | "page" | "pdf";
  message: string;
  sourceUrl: string;
}

const EMPTY_WEBSITE: WebsiteSignal = {
  offices: [],
  sectors: [],
  projectNames: [],
  hiringRoles: [],
  genericEmails: [],
  genericPhones: [],
  socialUrls: [],
};

interface RobotsFile {
  isAllowed(url: string, userAgent?: string): boolean | undefined;
}

const robotsParser = robotsParserModule as unknown as (
  url: string,
  body: string,
) => RobotsFile;

function pageScore(value: string): number {
  const path = new URL(value).pathname.toLowerCase();
  if (/(?:team|people|leadership|management|staff)/u.test(path)) return 100;
  if (/(?:commercial|procurement|supply-chain|supply_chain)/u.test(path)) return 95;
  if (/(?:contact|office|location)/u.test(path)) return 80;
  if (/(?:project|case-stud|portfolio)/u.test(path)) return 75;
  if (/(?:news|insight|press)/u.test(path)) return 65;
  if (/(?:career|vacanc|jobs?)/u.test(path)) return 60;
  if (path === "/" || path === "") return 90;
  return 10;
}

function mergeUnique<T>(left: T[], right: T[]): T[] {
  return [...new Set([...left, ...right])];
}

function mergeWebsite(
  current: WebsiteSignal,
  incoming: WebsiteSignal,
): WebsiteSignal {
  return {
    offices: mergeUnique(current.offices, incoming.offices),
    sectors: mergeUnique(current.sectors, incoming.sectors),
    projectNames: mergeUnique(current.projectNames, incoming.projectNames),
    hiringRoles: mergeUnique(current.hiringRoles, incoming.hiringRoles),
    genericEmails: mergeUnique(current.genericEmails, incoming.genericEmails),
    genericPhones: mergeUnique(current.genericPhones, incoming.genericPhones),
    socialUrls: mergeUnique(current.socialUrls, incoming.socialUrls),
  };
}

function mergeContacts(
  existing: Map<string, ContactCandidate>,
  incoming: ContactCandidate[],
): void {
  for (const contact of incoming) {
    const current = existing.get(contact.id);
    if (!current) {
      existing.set(contact.id, contact);
      continue;
    }
    current.emails = [
      ...new Map(
        [...current.emails, ...contact.emails].map((point) => [point.value, point]),
      ).values(),
    ];
    current.phones = [
      ...new Map(
        [...current.phones, ...contact.phones].map((point) => [point.value, point]),
      ).values(),
    ];
    current.profileUrls = mergeUnique(current.profileUrls, contact.profileUrls);
    current.evidenceIds = mergeUnique(current.evidenceIds, contact.evidenceIds);
    current.confidence = Math.max(current.confidence, contact.confidence);
    if (contact.employmentStatus === "former") current.employmentStatus = "former";
  }
}

function urlsFromSitemap(xml: string, baseUrl: string, domain: string): string[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  return $("loc")
    .map((_, element) => $(element).text().trim())
    .get()
    .flatMap((value) => {
      try {
        const url = new URL(value, baseUrl);
        if (canonicalDomain(url.hostname) !== domain) return [];
        return [url.toString()];
      } catch {
        return [];
      }
    });
}

function createFetchOptions(
  options: CrawlOptions,
  maxBytes: number,
  allowedDomain: string,
): FetchResourceOptions {
  return {
    timeoutMs: options.timeoutMs,
    maxBytes,
    userAgent: options.userAgent,
    allowedDomain,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.lookup ? { lookup: options.lookup } : {}),
  };
}

async function readRobots(
  root: URL,
  options: CrawlOptions,
  warnings: string[],
  domain: string,
): Promise<{
  isAllowed: (url: string) => boolean;
  sitemaps: string[];
  rulesStatus: "allowed" | "missing" | "blocked";
}> {
  const robotsUrl = new URL("/robots.txt", root);
  try {
    const response = await fetchPublicResource(
      robotsUrl,
      createFetchOptions(options, 1_000_000, domain),
    );
    if (response.status === 404) {
      return {
        isAllowed: () => true,
        sitemaps: [],
        rulesStatus: "missing",
      };
    }
    if (response.status < 200 || response.status >= 300) {
      warnings.push(`robots.txt returned HTTP ${response.status}`);
      return {
        isAllowed: () => false,
        sitemaps: [],
        rulesStatus: "blocked",
      };
    }
    const text = decodeUtf8(response.body);
    const parsed = robotsParser(robotsUrl.toString(), text);
    const sitemaps = text
      .split(/\r?\n/u)
      .filter((line) => /^sitemap\s*:/iu.test(line))
      .map((line) => line.replace(/^sitemap\s*:/iu, "").trim())
      .filter(Boolean);
    return {
      isAllowed: (url) => parsed.isAllowed(url, options.userAgent) !== false,
      sitemaps,
      rulesStatus: "allowed",
    };
  } catch (error) {
    warnings.push(
      `robots.txt unavailable: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return {
      isAllowed: () => false,
      sitemaps: [],
      rulesStatus: "blocked",
    };
  }
}

async function extractPdf(
  company: CompanySeed,
  url: string,
  body: Uint8Array,
  capturedAt: string,
): Promise<PageExtraction> {
  const parser = new PDFParse({ data: Buffer.from(body) });
  try {
    const result = await parser.getText({ first: 20 });
    return extractPdfText(company, url, result.text, capturedAt);
  } finally {
    await parser.destroy();
  }
}

export async function crawlCompanyWebsite(
  company: CompanySeed,
  options: CrawlOptions,
): Promise<EnrichedCompany> {
  const now = options.now ?? (() => new Date());
  const warnings: string[] = [];
  const pagesVisited: string[] = [];
  const pagesSkipped: Array<{ url: string; reason: string }> = [];
  const evidence: Evidence[] = [];
  const contacts = new Map<string, ContactCandidate>();
  let website: WebsiteSignal = { ...EMPTY_WEBSITE };
  const domain = canonicalDomain(company.domain);
  if (!domain) throw new Error(`Invalid company domain: ${company.domain}`);

  const root = new URL(company.websiteUrl);
  if (canonicalDomain(root.hostname) !== domain) {
    throw new Error(
      `Website domain does not match company domain: ${root.hostname}`,
    );
  }
  const robots = await readRobots(root, options, warnings, domain);
  const robotsDecision = await options.onProgress?.({
    kind: "robots",
    message: {
      allowed:
        "Checked the website rules and confirmed the allowed public paths.",
      missing:
        "No website rules file was published; standard public-page access applies.",
      blocked: "Website rules were unavailable, so the crawl stopped safely.",
    }[robots.rulesStatus],
    sourceUrl: new URL("/robots.txt", root).toString(),
  });
  let controlStopped = robotsDecision === "stop";
  if (controlStopped) {
    warnings.push("Research run was cancelled by the operator.");
  }
  const candidates = new Map<string, number>();
  const queuedPdfs = new Set<string>();
  const seen = new Set<string>();
  candidates.set(root.toString(), pageScore(root.toString()));

  const sitemapQueue = controlStopped
    ? []
    : mergeUnique(
        robots.sitemaps,
        [new URL("/sitemap.xml", root).toString()],
      ).filter((url) => robots.isAllowed(url));
  const seenSitemaps = new Set<string>();
  while (sitemapQueue.length > 0 && seenSitemaps.size < 8) {
    const sitemapUrl = sitemapQueue.shift();
    if (!sitemapUrl || seenSitemaps.has(sitemapUrl)) continue;
    seenSitemaps.add(sitemapUrl);
    if (!robots.isAllowed(sitemapUrl)) {
      pagesSkipped.push({ url: sitemapUrl, reason: "blocked_by_robots" });
      continue;
    }
    if (seenSitemaps.size > 1) await delay(options.delayMs);
    try {
      const response = await fetchPublicResource(
        sitemapUrl,
        createFetchOptions(options, 5_000_000, domain),
      );
      if (response.status >= 200 && response.status < 300) {
        for (const url of urlsFromSitemap(
          decodeUtf8(response.body),
          sitemapUrl,
          domain,
        )) {
          if (new URL(url).pathname.toLowerCase().endsWith(".xml")) {
            if (!seenSitemaps.has(url)) sitemapQueue.push(url);
            continue;
          }
          const score = pageScore(url);
          if (score >= 60) candidates.set(url, score);
        }
      }
    } catch (error) {
      warnings.push(
        `Sitemap skipped: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  let lastRequestAt = 0;
  const waitForRateLimit = async (): Promise<void> => {
    const wait = options.delayMs - (Date.now() - lastRequestAt);
    if (wait > 0) await delay(wait);
    lastRequestAt = Date.now();
  };

  while (!controlStopped && pagesVisited.length < options.maxPages) {
    const next = [...candidates.entries()]
      .filter(([url]) => !seen.has(url))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (!next) break;
    const [url] = next;
    seen.add(url);
    if (!robots.isAllowed(url)) {
      pagesSkipped.push({ url, reason: "blocked_by_robots" });
      continue;
    }

    await waitForRateLimit();
    try {
      const decision = await options.onProgress?.({
        kind: "page",
        message: "Opening an approved public company page.",
        sourceUrl: url,
      });
      if (decision === "stop") {
        controlStopped = true;
        warnings.push("Research run was cancelled by the operator.");
        break;
      }
      const response = await fetchPublicResource(
        url,
        createFetchOptions(options, 5_000_000, domain),
      );
      if (response.status < 200 || response.status >= 300) {
        pagesSkipped.push({ url, reason: `http_${response.status}` });
        continue;
      }
      if (
        !response.contentType.includes("text/html") &&
        !response.contentType.includes("application/xhtml+xml") &&
        response.contentType !== ""
      ) {
        pagesSkipped.push({ url, reason: "unsupported_content_type" });
        continue;
      }

      const finalUrl = response.url;
      seen.add(finalUrl);
      if (pagesVisited.includes(finalUrl)) continue;
      pagesVisited.push(finalUrl);
      const extracted = extractHtmlPage(
        company,
        finalUrl,
        decodeUtf8(response.body),
        now().toISOString(),
      );
      mergeContacts(contacts, extracted.contacts);
      evidence.push(...extracted.evidence);
      website = mergeWebsite(website, extracted.website);
      for (const link of extracted.links) {
        if (!seen.has(link)) candidates.set(link, pageScore(link));
      }
      for (const pdf of extracted.pdfLinks) queuedPdfs.add(pdf);
    } catch (error) {
      pagesSkipped.push({
        url,
        reason: error instanceof Error ? error.message : "crawl_error",
      });
    }
  }

  let parsedPdfs = 0;
  for (const url of [...queuedPdfs].sort((a, b) => pageScore(b) - pageScore(a))) {
    if (controlStopped || parsedPdfs >= options.maxPdfs) break;
    if (!robots.isAllowed(url)) {
      pagesSkipped.push({ url, reason: "blocked_by_robots" });
      continue;
    }
    await waitForRateLimit();
    try {
      const decision = await options.onProgress?.({
        kind: "pdf",
        message: "Reading an approved public company PDF.",
        sourceUrl: url,
      });
      if (decision === "stop") {
        controlStopped = true;
        warnings.push("Research run was cancelled by the operator.");
        break;
      }
      const response = await fetchPublicResource(
        url,
        createFetchOptions(options, 12_000_000, domain),
      );
      if (
        response.status < 200 ||
        response.status >= 300 ||
        !response.contentType.includes("application/pdf")
      ) {
        pagesSkipped.push({ url, reason: `pdf_http_${response.status}` });
        continue;
      }
      const extracted = await extractPdf(
        company,
        response.url,
        response.body,
        now().toISOString(),
      );
      mergeContacts(contacts, extracted.contacts);
      evidence.push(...extracted.evidence);
      website = mergeWebsite(website, extracted.website);
      pagesVisited.push(response.url);
      parsedPdfs += 1;
    } catch (error) {
      pagesSkipped.push({
        url,
        reason: error instanceof Error ? error.message : "pdf_error",
      });
    }
  }

  const crawlStatus =
    controlStopped
      ? "cancelled"
      : robots.rulesStatus === "blocked"
        ? "blocked"
        : pagesVisited.length === 0
          ? "failed"
          : "completed";
  const completedAt = now().toISOString();
  if (pagesVisited.length > 0) {
    evidence.push({
      id: stableId(company.id, company.websiteUrl, "crawl_summary"),
      companyId: company.id,
      sourceKind: "company_website",
      sourceUrl: company.websiteUrl,
      capturedAt: completedAt,
      field: "crawl_summary",
      value: `${pagesVisited.length} pages visited; status ${crawlStatus}`,
      confidence: 1,
    });
  }

  return {
    company,
    facts: {},
    contacts: [...contacts.values()].sort(
      (a, b) => b.rolePriority - a.rolePriority || a.name.localeCompare(b.name),
    ),
    projects: [],
    website,
    evidence,
    pagesVisited,
    pagesSkipped,
    warnings,
    crawlStatus,
    completedAt,
  };
}
