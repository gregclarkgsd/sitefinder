import {
  canonicalDomain,
  isBusinessEmail,
  normalizeCompanyName,
  stableId,
} from "../lib/normalize.js";
import type {
  IdentityResolutionManifest,
  ReviewedIdentityResolution,
} from "./identity-resolution.js";

export type CompanyUniverseSource =
  | "attio"
  | "pipedrive"
  | "file"
  | "sitefinder_contractor"
  | "sitefinder_client";

export interface CompanyUniverseInputRow {
  sourceId: string;
  name: string;
  domain?: string | null;
  websiteUrl?: string | null;
  companyNumber?: string | null;
}

export interface CompanyUniverseInputs {
  attio?: readonly CompanyUniverseInputRow[];
  pipedrive?: readonly CompanyUniverseInputRow[];
  file?: readonly CompanyUniverseInputRow[];
  sitefinderContractors?: readonly CompanyUniverseInputRow[];
  sitefinderClients?: readonly CompanyUniverseInputRow[];
}

export interface CompanySourceRecord {
  source: CompanyUniverseSource;
  sourceId: string;
  sourceKey: string;
  name: string;
  normalizedName: string;
  rawDomain: string | null;
  rawWebsiteUrl: string | null;
  domains: string[];
  mergeDomain: string | null;
  rawCompanyNumber: string | null;
  companyNumber: string | null;
  legalForm: string | null;
}

export interface UniverseCompany {
  id: string;
  preferredName: string;
  normalizedNames: string[];
  domains: string[];
  mergeDomains: string[];
  companyNumbers: string[];
  sourceIds: Record<CompanyUniverseSource, string[]>;
  sourceRecords: CompanySourceRecord[];
  approvedIdentityResolutionKeys: string[];
}

export type CompanyUniverseReviewKind =
  | "domainless"
  | "row_domain_conflict"
  | "shared_domain_identity_conflict"
  | "shared_domain_legal_form_conflict"
  | "shared_domain_partial_company_number"
  | "duplicate_source_id"
  | "missing_name"
  | "name_only_match"
  | "merged_name_conflict"
  | "company_number_conflict"
  | "domain_conflict"
  | "reviewed_identity_conflict";

export interface CompanyUniverseReviewItem {
  id: string;
  kind: CompanyUniverseReviewKind;
  message: string;
  companyIds: string[];
  sourceKeys: string[];
  normalizedName: string | null;
  domains: string[];
  companyNumbers: string[];
}

export interface CompanyUniverseResult {
  companies: UniverseCompany[];
  reviewQueue: CompanyUniverseReviewItem[];
  summary: {
    inputRows: number;
    companies: number;
    mergedCompanies: number;
    reviewItems: number;
    domainlessRows: number;
    nameOnlyMatches: number;
    identityMappings: number;
    mappedSiteFinderIdentities: number;
    unmappedSiteFinderIdentities: number;
    identityResolutionConflicts: number;
  };
}

const SOURCES: readonly CompanyUniverseSource[] = [
  "attio",
  "pipedrive",
  "file",
  "sitefinder_contractor",
  "sitefinder_client",
];

const SOURCE_RANK: Readonly<Record<CompanyUniverseSource, number>> = {
  attio: 0,
  sitefinder_client: 1,
  sitefinder_contractor: 2,
  pipedrive: 3,
  file: 4,
};

interface IndexedSourceRecord extends CompanySourceRecord {
  index: number;
  approvedIdentityResolutionKeys: string[];
}

class DisjointSet {
  readonly #parents: number[];
  readonly #ranks: number[];

  constructor(size: number) {
    this.#parents = Array.from({ length: size }, (_, index) => index);
    this.#ranks = Array.from({ length: size }, () => 0);
  }

  find(index: number): number {
    const parent = this.#parents[index];
    if (parent === undefined) throw new Error(`Unknown company row ${index}`);
    if (parent !== index) this.#parents[index] = this.find(parent);
    return this.#parents[index] ?? index;
  }

  union(left: number, right: number): void {
    let leftRoot = this.find(left);
    let rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;

    const leftRank = this.#ranks[leftRoot] ?? 0;
    const rightRank = this.#ranks[rightRoot] ?? 0;
    if (leftRank < rightRank) {
      [leftRoot, rightRoot] = [rightRoot, leftRoot];
    }
    this.#parents[rightRoot] = leftRoot;
    if (leftRank === rightRank) this.#ranks[leftRoot] = leftRank + 1;
  }
}

function textOrNull(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

export function normalizeCompanyNumber(
  value: string | null | undefined,
): string | null {
  const compact = (value ?? "").toUpperCase().replace(/[^A-Z0-9]/gu, "");
  if (/^\d{1,8}$/u.test(compact)) return compact.padStart(8, "0");
  return /^[A-Z]{2}\d{6}$/u.test(compact) ? compact : null;
}

function companyLegalForm(value: string): string | null {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .toLowerCase();
  const matches: ReadonlyArray<readonly [RegExp, string]> = [
    [/\b(?:limited|ltd)\b/u, "limited"],
    [/\bplc\b/u, "plc"],
    [/\bllp\b/u, "llp"],
    [/\b(?:incorporated|inc)\b/u, "incorporated"],
  ];
  return matches.find(([pattern]) => pattern.test(normalized))?.[1] ?? null;
}

function normalizedDomain(value: string | null | undefined): string | null {
  const candidate = textOrNull(value);
  const domain = candidate ? canonicalDomain(candidate) : null;
  return domain && isBusinessEmail(`company-domain-check@${domain}`)
    ? domain
    : null;
}

function normalizeDomains(row: CompanyUniverseInputRow): {
  domains: string[];
  mergeDomain: string | null;
} {
  const explicitDomain = normalizedDomain(row.domain);
  const websiteDomain = normalizedDomain(row.websiteUrl);
  return {
    domains: uniqueSorted(
      [explicitDomain, websiteDomain].filter(
        (value): value is string => value !== null,
      ),
    ),
    // An explicit domain wins. A conflicting website is retained for review but
    // is not allowed to bridge two otherwise separate companies.
    mergeDomain: explicitDomain ?? websiteDomain,
  };
}

function flattenInputs(inputs: CompanyUniverseInputs): IndexedSourceRecord[] {
  const groups: Array<
    readonly [CompanyUniverseSource, readonly CompanyUniverseInputRow[]]
  > = [
    ["attio", inputs.attio ?? []],
    ["pipedrive", inputs.pipedrive ?? []],
    ["file", inputs.file ?? []],
    ["sitefinder_contractor", inputs.sitefinderContractors ?? []],
    ["sitefinder_client", inputs.sitefinderClients ?? []],
  ];

  const records: IndexedSourceRecord[] = [];
  for (const [source, rows] of groups) {
    for (const row of rows) {
      const sourceId = row.sourceId.trim();
      if (!sourceId) {
        throw new Error(`${source} company row is missing its source ID`);
      }
      const name = row.name.trim();
      const rawDomain = textOrNull(row.domain);
      const rawWebsiteUrl = textOrNull(row.websiteUrl);
      const rawCompanyNumber = textOrNull(row.companyNumber);
      const { domains, mergeDomain } = normalizeDomains(row);
      records.push({
        index: records.length,
        source,
        sourceId,
        sourceKey: `${source}:${sourceId}`,
        name,
        normalizedName: normalizeCompanyName(name),
        rawDomain,
        rawWebsiteUrl,
        domains,
        mergeDomain,
        rawCompanyNumber,
        companyNumber: normalizeCompanyNumber(rawCompanyNumber),
        legalForm: companyLegalForm(name),
        approvedIdentityResolutionKeys: [],
      });
    }
  }
  return records;
}

function compareRecords(
  left: CompanySourceRecord,
  right: CompanySourceRecord,
): number {
  return (
    SOURCE_RANK[left.source] - SOURCE_RANK[right.source] ||
    left.sourceId.localeCompare(right.sourceId) ||
    left.name.localeCompare(right.name)
  );
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function emptySourceIds(): Record<CompanyUniverseSource, string[]> {
  return {
    attio: [],
    pipedrive: [],
    file: [],
    sitefinder_contractor: [],
    sitefinder_client: [],
  };
}

function companyIdentity(
  records: readonly CompanySourceRecord[],
): string {
  // Source record IDs are the durable anchors in the input systems. Unlike a
  // company number or domain, enriching a record cannot introduce or change
  // this identity, so later facts do not silently change the canonical ID.
  return `source:${records[0]?.sourceKey ?? "unknown"}`;
}

function createCompany(records: readonly IndexedSourceRecord[]): UniverseCompany {
  const sourceRecords: CompanySourceRecord[] = [...records]
    .sort(compareRecords)
    .map(
      ({
        index: _index,
        approvedIdentityResolutionKeys: _approvedKeys,
        ...record
      }) => record,
    );
  const domains = uniqueSorted(sourceRecords.flatMap((record) => record.domains));
  const mergeDomains = uniqueSorted(
    sourceRecords.flatMap((record) =>
      record.mergeDomain ? [record.mergeDomain] : [],
    ),
  );
  const companyNumbers = uniqueSorted(
    sourceRecords.flatMap((record) =>
      record.companyNumber ? [record.companyNumber] : [],
    ),
  );
  const normalizedNames = uniqueSorted(
    sourceRecords.flatMap((record) =>
      record.normalizedName ? [record.normalizedName] : [],
    ),
  );
  const sourceIds = emptySourceIds();
  for (const source of SOURCES) {
    sourceIds[source] = uniqueSorted(
      sourceRecords
        .filter((record) => record.source === source)
        .map((record) => record.sourceId),
    );
  }

  return {
    id: stableId(
      "company-universe",
      companyIdentity(sourceRecords),
    ),
    preferredName:
      sourceRecords.find((record) => record.name)?.name ??
      `[Unnamed ${sourceRecords[0]?.sourceKey ?? "company"}]`,
    normalizedNames,
    domains,
    mergeDomains,
    companyNumbers,
    sourceIds,
    sourceRecords,
    approvedIdentityResolutionKeys: uniqueSorted(
      records.flatMap((record) => record.approvedIdentityResolutionKeys),
    ),
  };
}

function applyReviewedIdentityResolutions(
  records: readonly IndexedSourceRecord[],
  disjointSet: DisjointSet,
  resolutions: readonly ReviewedIdentityResolution[],
): void {
  const recordsBySourceKey = new Map<string, IndexedSourceRecord[]>();
  for (const record of records) {
    const matching = recordsBySourceKey.get(record.sourceKey) ?? [];
    matching.push(record);
    recordsBySourceKey.set(record.sourceKey, matching);
  }

  const seenResolutionKeys = new Set<string>();
  const seenSiteFinderKeys = new Set<string>();
  for (const resolution of resolutions) {
    if (seenResolutionKeys.has(resolution.resolutionKey)) {
      throw new Error(
        `Duplicate identity-resolution key ${resolution.resolutionKey}`,
      );
    }
    seenResolutionKeys.add(resolution.resolutionKey);

    const siteFinderKey =
      `${resolution.sitefinder.source}:${resolution.sitefinder.sourceId}`;
    if (seenSiteFinderKeys.has(siteFinderKey)) {
      throw new Error(
        `SiteFinder identity ${siteFinderKey} has more than one approved CRM mapping`,
      );
    }
    seenSiteFinderKeys.add(siteFinderKey);
    const crmKey = `${resolution.crm.source}:${resolution.crm.sourceId}`;
    const siteFinderRecords = recordsBySourceKey.get(siteFinderKey);
    const crmRecords = recordsBySourceKey.get(crmKey);
    if (!siteFinderRecords?.length) {
      throw new Error(
        `Identity resolution ${resolution.resolutionKey} references missing SiteFinder record ${siteFinderKey}`,
      );
    }
    if (!crmRecords?.length) {
      throw new Error(
        `Identity resolution ${resolution.resolutionKey} references missing CRM record ${crmKey}`,
      );
    }

    for (const record of [...siteFinderRecords, ...crmRecords]) {
      record.approvedIdentityResolutionKeys.push(resolution.resolutionKey);
    }
    for (const siteFinderRecord of siteFinderRecords) {
      for (const crmRecord of crmRecords) {
        disjointSet.union(siteFinderRecord.index, crmRecord.index);
      }
    }
  }
}

function reviewItem(
  kind: CompanyUniverseReviewKind,
  message: string,
  companies: readonly UniverseCompany[],
  records: readonly CompanySourceRecord[],
  normalizedName: string | null = null,
): CompanyUniverseReviewItem {
  const companyIds = uniqueSorted(companies.map((company) => company.id));
  const sourceKeys = uniqueSorted(records.map((record) => record.sourceKey));
  const domains = uniqueSorted(records.flatMap((record) => record.domains));
  const companyNumbers = uniqueSorted(
    records.flatMap((record) =>
      record.companyNumber ? [record.companyNumber] : [],
    ),
  );
  return {
    id: stableId(
      "company-universe-review",
      kind,
      normalizedName ?? "",
      ...companyIds,
      ...sourceKeys,
    ),
    kind,
    message,
    companyIds,
    sourceKeys,
    normalizedName,
    domains,
    companyNumbers,
  };
}

function componentCompanies(
  records: readonly IndexedSourceRecord[],
  disjointSet: DisjointSet,
): UniverseCompany[] {
  const components = new Map<number, IndexedSourceRecord[]>();
  for (const record of records) {
    const root = disjointSet.find(record.index);
    const component = components.get(root) ?? [];
    component.push(record);
    components.set(root, component);
  }
  return [...components.values()]
    .map(createCompany)
    .sort(
      (left, right) =>
        left.preferredName.localeCompare(right.preferredName) ||
        left.id.localeCompare(right.id),
    );
}

function addStrongMatches(
  records: readonly IndexedSourceRecord[],
  disjointSet: DisjointSet,
): void {
  const companyNumberOwners = new Map<string, number>();
  const sourceOwners = new Map<string, number>();
  const recordsByDomain = new Map<string, IndexedSourceRecord[]>();

  for (const record of records) {
    if (record.mergeDomain) {
      const matching = recordsByDomain.get(record.mergeDomain) ?? [];
      matching.push(record);
      recordsByDomain.set(record.mergeDomain, matching);
    }
    if (record.companyNumber) {
      const owner = companyNumberOwners.get(record.companyNumber);
      if (owner === undefined) {
        companyNumberOwners.set(record.companyNumber, record.index);
      } else {
        disjointSet.union(owner, record.index);
      }
    }
    const sourceOwner = sourceOwners.get(record.sourceKey);
    if (sourceOwner === undefined) sourceOwners.set(record.sourceKey, record.index);
    else disjointSet.union(sourceOwner, record.index);
  }

  for (const matching of recordsByDomain.values()) {
    const companyNumbers = uniqueSorted(
      matching.flatMap((record) =>
        record.companyNumber ? [record.companyNumber] : [],
      ),
    );
    const legalForms = uniqueSorted(
      matching.flatMap((record) =>
        record.legalForm ? [record.legalForm] : [],
      ),
    );
    const hasCompanyNumber = matching.some((record) => record.companyNumber);
    const hasMissingCompanyNumber = matching.some(
      (record) => !record.companyNumber,
    );
    // One group domain can serve several legal entities. Conflicting legal
    // forms, conflicting numbers, or a mix of numbered and unnumbered records
    // therefore require an explicit identity decision before any merge.
    if (
      companyNumbers.length > 1 ||
      legalForms.length > 1 ||
      (hasCompanyNumber && hasMissingCompanyNumber)
    ) {
      continue;
    }
    const owner = matching[0];
    if (!owner) continue;
    for (const record of matching.slice(1)) {
      disjointSet.union(owner.index, record.index);
    }
  }
}

function createReviewQueue(companies: readonly UniverseCompany[]): CompanyUniverseReviewItem[] {
  const issues: CompanyUniverseReviewItem[] = [];
  const allRecords = companies.flatMap((company) => company.sourceRecords);
  const companyByRecord = new Map<CompanySourceRecord, UniverseCompany>();
  for (const company of companies) {
    for (const record of company.sourceRecords) {
      companyByRecord.set(record, company);
      if (record.domains.length === 0) {
        issues.push(
          reviewItem(
            "domainless",
            "Source row has no valid domain and must be checked before domain-based enrichment.",
            [company],
            [record],
          ),
        );
      }
      if (record.domains.length > 1) {
        issues.push(
          reviewItem(
            "row_domain_conflict",
            "The row's domain and website resolve to different domains.",
            [company],
            [record],
          ),
        );
      }
      if (!record.normalizedName) {
        issues.push(
          reviewItem(
            "missing_name",
            "Source row has no usable company name.",
            [company],
            [record],
          ),
        );
      }
    }
    if (company.normalizedNames.length > 1) {
      issues.push(
        reviewItem(
          "merged_name_conflict",
          "Strong identifiers merged records whose normalized company names differ.",
          [company],
          company.sourceRecords,
        ),
      );
    }
    if (company.companyNumbers.length > 1) {
      issues.push(
        reviewItem(
          "company_number_conflict",
          "A merged company has more than one normalized company number.",
          [company],
          company.sourceRecords,
        ),
      );
    }
    if (company.domains.length > 1) {
      issues.push(
        reviewItem(
          "domain_conflict",
          "A merged company has more than one normalized domain.",
          [company],
          company.sourceRecords,
        ),
      );
    }
    if (
      company.approvedIdentityResolutionKeys.length > 0 &&
      (company.companyNumbers.length > 1 ||
        company.mergeDomains.length > 1)
    ) {
      issues.push(
        reviewItem(
          "reviewed_identity_conflict",
          "An approved SiteFinder-to-CRM identity mapping produced contradictory strong identifiers and remains blocked for review.",
          [company],
          company.sourceRecords,
        ),
      );
    }
  }

  const recordsBySourceKey = new Map<string, CompanySourceRecord[]>();
  for (const record of allRecords) {
    const matching = recordsBySourceKey.get(record.sourceKey) ?? [];
    matching.push(record);
    recordsBySourceKey.set(record.sourceKey, matching);
  }
  for (const [sourceKey, records] of recordsBySourceKey) {
    if (records.length < 2) continue;
    const matchingCompanies = uniqueSorted(
      records.flatMap((record) => {
        const company = companyByRecord.get(record);
        return company ? [company.id] : [];
      }),
    ).flatMap((companyId) => {
      const company = companies.find((candidate) => candidate.id === companyId);
      return company ? [company] : [];
    });
    issues.push(
      reviewItem(
        "duplicate_source_id",
        `Source record ${sourceKey} appeared more than once.`,
        matchingCompanies,
        records,
      ),
    );
  }

  const recordsByMergeDomain = new Map<string, CompanySourceRecord[]>();
  for (const record of allRecords) {
    if (!record.mergeDomain) continue;
    const matching = recordsByMergeDomain.get(record.mergeDomain) ?? [];
    matching.push(record);
    recordsByMergeDomain.set(record.mergeDomain, matching);
  }
  for (const [domain, records] of recordsByMergeDomain) {
    const companyNumbers = uniqueSorted(
      records.flatMap((record) =>
        record.companyNumber ? [record.companyNumber] : [],
      ),
    );
    const legalForms = uniqueSorted(
      records.flatMap((record) =>
        record.legalForm ? [record.legalForm] : [],
      ),
    );
    const hasCompanyNumber = records.some((record) => record.companyNumber);
    const hasMissingCompanyNumber = records.some(
      (record) => !record.companyNumber,
    );
    const kind =
      companyNumbers.length > 1
        ? "shared_domain_identity_conflict"
        : legalForms.length > 1
          ? "shared_domain_legal_form_conflict"
          : hasCompanyNumber && hasMissingCompanyNumber
            ? "shared_domain_partial_company_number"
            : null;
    if (!kind) continue;
    const matchingCompanies = [
      ...new Map(
        records.flatMap((record) => {
          const company = companyByRecord.get(record);
          return company ? [[company.id, company] as const] : [];
        }),
      ).values(),
    ];
    issues.push(
      reviewItem(
        kind,
        kind === "shared_domain_identity_conflict"
          ? `Domain ${domain} is shared by records with conflicting company numbers; they were not auto-merged.`
          : kind === "shared_domain_legal_form_conflict"
            ? `Domain ${domain} is shared by records with conflicting legal forms; they were not auto-merged.`
            : `Domain ${domain} is shared by numbered and unnumbered records; they were not auto-merged.`,
        matchingCompanies,
        records,
      ),
    );
  }

  const companiesByName = new Map<string, UniverseCompany[]>();
  for (const company of companies) {
    for (const normalizedName of company.normalizedNames) {
      const matching = companiesByName.get(normalizedName) ?? [];
      matching.push(company);
      companiesByName.set(normalizedName, matching);
    }
  }
  for (const [normalizedName, matchingCompanies] of companiesByName) {
    const uniqueCompanies = [
      ...new Map(
        matchingCompanies.map((company) => [company.id, company]),
      ).values(),
    ];
    if (uniqueCompanies.length < 2) continue;
    issues.push(
      reviewItem(
        "name_only_match",
        "Companies share a normalized name but no strong identifier; they were not auto-merged.",
        uniqueCompanies,
        uniqueCompanies.flatMap((company) => company.sourceRecords),
        normalizedName,
      ),
    );
  }

  return issues.sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id),
  );
}

export function compileCompanyUniverse(
  inputs: CompanyUniverseInputs,
  identityResolutionManifest?: IdentityResolutionManifest,
): CompanyUniverseResult {
  const records = flattenInputs(inputs);
  const disjointSet = new DisjointSet(records.length);
  addStrongMatches(records, disjointSet);
  const identityResolutions = identityResolutionManifest?.resolutions ?? [];
  applyReviewedIdentityResolutions(records, disjointSet, identityResolutions);
  const companies = componentCompanies(records, disjointSet);
  const reviewQueue = createReviewQueue(companies);
  const siteFinderIdentities = new Set(
    records
      .filter(
        (record) =>
          record.source === "sitefinder_contractor" ||
          record.source === "sitefinder_client",
      )
      .map((record) => record.sourceKey),
  );
  const mappedSiteFinderIdentities = new Set(
    identityResolutions.map(
      (resolution) =>
        `${resolution.sitefinder.source}:${resolution.sitefinder.sourceId}`,
    ),
  ).size;

  return {
    companies,
    reviewQueue,
    summary: {
      inputRows: records.length,
      companies: companies.length,
      mergedCompanies: companies.filter(
        (company) => company.sourceRecords.length > 1,
      ).length,
      reviewItems: reviewQueue.length,
      domainlessRows: reviewQueue.filter((item) => item.kind === "domainless")
        .length,
      nameOnlyMatches: reviewQueue.filter(
        (item) => item.kind === "name_only_match",
      ).length,
      identityMappings: identityResolutions.length,
      mappedSiteFinderIdentities,
      unmappedSiteFinderIdentities:
        siteFinderIdentities.size - mappedSiteFinderIdentities,
      identityResolutionConflicts: reviewQueue.filter(
        (item) => item.kind === "reviewed_identity_conflict",
      ).length,
    },
  };
}
