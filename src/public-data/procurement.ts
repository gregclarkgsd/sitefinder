import type {
  CompanySeed,
  Evidence,
  ProjectSignal,
} from "../types.js";
import {
  normalizeCompanyName,
  stableId,
} from "../lib/normalize.js";
import { fetchJson } from "../lib/http.js";

type JsonObject = Record<string, unknown>;

export interface OcdsRelease {
  id?: string;
  ocid?: string;
  date?: string;
  tag?: string[];
  buyer?: { id?: string; name?: string };
  parties?: Array<{
    id?: string;
    name?: string;
    roles?: string[];
    contactPoint?: JsonObject;
  }>;
  tender?: {
    title?: string;
    status?: string;
    value?: { amount?: number; currency?: string };
    tenderers?: Array<{ id?: string; name?: string }>;
  };
  awards?: Array<{
    id?: string;
    title?: string;
    status?: string;
    date?: string;
    value?: { amount?: number; currency?: string };
    suppliers?: Array<{ id?: string; name?: string }>;
  }>;
}

interface ReleasePackage {
  releases?: OcdsRelease[];
  links?: {
    next?: string;
  };
  cursor?: string;
}

function exactPartyMatch(company: CompanySeed, name: string | undefined): boolean {
  return Boolean(
    name &&
      normalizeCompanyName(name) &&
      normalizeCompanyName(name) === normalizeCompanyName(company.name),
  );
}

function releaseUrl(
  source: "contracts_finder" | "find_a_tender",
  release: OcdsRelease,
): string {
  if (source === "find_a_tender" && release.id) {
    return `https://www.find-tender.service.gov.uk/Notice/${encodeURIComponent(release.id)}`;
  }
  return release.ocid
    ? `https://www.contractsfinder.service.gov.uk/Notice/${encodeURIComponent(release.ocid)}`
    : "https://www.contractsfinder.service.gov.uk/";
}

function matchedRole(
  company: CompanySeed,
  release: OcdsRelease,
): ProjectSignal["role"] | null {
  if (exactPartyMatch(company, release.buyer?.name)) return "buyer";
  if (
    release.awards?.some((award) =>
      award.suppliers?.some((supplier) => exactPartyMatch(company, supplier.name)),
    )
  ) {
    return "supplier";
  }
  if (
    release.tender?.tenderers?.some((tenderer) =>
      exactPartyMatch(company, tenderer.name),
    )
  ) {
    return "tenderer";
  }
  if (release.parties?.some((party) => exactPartyMatch(company, party.name))) {
    return "mentioned";
  }
  return null;
}

export function matchProcurementReleases(
  companies: CompanySeed[],
  releases: OcdsRelease[],
  sourceKind: "contracts_finder" | "find_a_tender",
): { signals: ProjectSignal[]; evidence: Evidence[] } {
  const signals: ProjectSignal[] = [];
  const evidence: Evidence[] = [];

  for (const company of companies) {
    for (const release of releases) {
      const role = matchedRole(company, release);
      if (!role) continue;
      const award = release.awards?.[0];
      const title = award?.title ?? release.tender?.title ?? "Untitled procurement";
      const sourceUrl = releaseUrl(sourceKind, release);
      const id = stableId(company.id, sourceKind, release.ocid ?? release.id ?? title);
      const itemEvidence: Evidence = {
        id: stableId(id, "evidence"),
        companyId: company.id,
        sourceKind,
        sourceUrl,
        capturedAt: new Date().toISOString(),
        field: "procurement_activity",
        value: `${role}: ${title}`,
        confidence: 0.94,
      };
      evidence.push(itemEvidence);
      const signal: ProjectSignal = {
        id,
        companyId: company.id,
        sourceKind,
        title,
        role,
        sourceUrl,
        evidenceIds: [itemEvidence.id],
        confidence: 0.94,
      };
      const stage = award?.status ?? release.tender?.status;
      const publishedAt = award?.date ?? release.date;
      const value = award?.value?.amount ?? release.tender?.value?.amount;
      const currency = award?.value?.currency ?? release.tender?.value?.currency;
      if (stage) signal.stage = stage;
      if (publishedAt) signal.publishedAt = publishedAt;
      if (value !== undefined) signal.value = value;
      if (currency) signal.currency = currency;
      signals.push(signal);
    }
  }
  return { signals, evidence };
}

export async function fetchFindATenderReleases(
  updatedFrom: Date,
  updatedTo: Date,
  options: { fetchImpl?: typeof fetch; maxPages?: number } = {},
): Promise<OcdsRelease[]> {
  const releases: OcdsRelease[] = [];
  const maxPages = options.maxPages ?? 20;
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(
      "https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages",
    );
    url.searchParams.set("updatedFrom", updatedFrom.toISOString().slice(0, 19));
    url.searchParams.set("updatedTo", updatedTo.toISOString().slice(0, 19));
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetchJson<ReleasePackage>(
      url,
      { method: "GET", headers: { accept: "application/json" } },
      options.fetchImpl ? { fetchImpl: options.fetchImpl } : {},
    );
    releases.push(...(response.releases ?? []));
    cursor = response.cursor;
    if (!cursor) break;
  }
  return releases;
}

export async function fetchContractsFinderReleases(
  publishedFrom: Date,
  publishedTo: Date,
  options: { fetchImpl?: typeof fetch; maxPages?: number } = {},
): Promise<OcdsRelease[]> {
  const releases: OcdsRelease[] = [];
  const maxPages = options.maxPages ?? 20;
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(
      "https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search",
    );
    url.searchParams.set("publishedFrom", publishedFrom.toISOString());
    url.searchParams.set("publishedTo", publishedTo.toISOString());
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetchJson<ReleasePackage>(
      url,
      { method: "GET", headers: { accept: "application/json" } },
      options.fetchImpl ? { fetchImpl: options.fetchImpl } : {},
    );
    releases.push(...(response.releases ?? []));
    const next = response.links?.next;
    cursor = response.cursor;
    if (!cursor && !next) break;
    if (next && !cursor) {
      const nextUrl = new URL(next);
      cursor = nextUrl.searchParams.get("cursor") ?? undefined;
    }
    if (!cursor) break;
  }
  return releases;
}
