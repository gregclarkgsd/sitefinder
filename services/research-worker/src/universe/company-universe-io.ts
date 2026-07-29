import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  captureImmutableInput,
  parseCapturedJson,
  type ImmutableInput,
} from "../io/immutable-input.js";
import { canonicalDomain } from "../lib/normalize.js";
import type { CompanySeed } from "../types.js";
import type {
  CompanyUniverseInputRow,
  CompanyUniverseInputs,
  CompanyUniverseResult,
  CompanyUniverseReviewKind,
  UniverseCompany,
} from "./company-universe.js";

type JsonObject = Record<string, unknown>;

const companyRowSchema = z
  .object({
    id: z.string().trim().min(1).optional(),
    sourceRecordId: z.string().trim().min(1).optional(),
    sourceId: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1),
    domain: z.string().trim().min(1).nullable().optional(),
    websiteUrl: z.string().trim().min(1).nullable().optional(),
    companyNumber: z.string().trim().min(1).nullable().optional(),
  })
  .passthrough()
  .refine(
    (row) => Boolean(row.sourceRecordId || row.sourceId || row.id),
    "Company row requires sourceRecordId, sourceId or id",
  );

function rowsFromJson(input: unknown): unknown[] {
  if (Array.isArray(input)) return input;
  if (
    input &&
    typeof input === "object" &&
    Array.isArray((input as { data?: unknown }).data)
  ) {
    return (input as { data: unknown[] }).data;
  }
  throw new Error("Company input must be a JSON array or { data: [] }");
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${path}: ${error.message}`);
    }
    throw error;
  }
}

export async function loadCompanyUniverseRows(
  path: string,
): Promise<CompanyUniverseInputRow[]> {
  return parseCompanyUniverseRows(await readJson(path));
}

export function parseCompanyUniverseRows(
  input: unknown,
): CompanyUniverseInputRow[] {
  return rowsFromJson(input).map((row, index) => {
    const parsed = companyRowSchema.safeParse(row);
    if (!parsed.success) {
      throw new Error(
        `Invalid company input row ${index + 1}: ${parsed.error.issues[0]?.message ?? "unknown validation error"}`,
      );
    }
    const sourceId =
      parsed.data.sourceRecordId ?? parsed.data.sourceId ?? parsed.data.id;
    if (!sourceId) {
      throw new Error(`Invalid company input row ${index + 1}: missing source ID`);
    }
    return {
      sourceId,
      name: parsed.data.name,
      ...(parsed.data.domain ? { domain: parsed.data.domain } : {}),
      ...(parsed.data.websiteUrl
        ? { websiteUrl: parsed.data.websiteUrl }
        : {}),
      ...(parsed.data.companyNumber
        ? { companyNumber: parsed.data.companyNumber }
        : {}),
    };
  });
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function firstText(row: JsonObject, keys: readonly string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" || typeof value === "number") {
      const text = String(value).trim();
      if (text) return text;
    }
  }
  return "";
}

interface SiteFinderRows {
  contractors: CompanyUniverseInputRow[];
  clients: CompanyUniverseInputRow[];
}

export async function loadSiteFinderCompanyRows(
  path: string,
): Promise<SiteFinderRows> {
  return parseSiteFinderCompanyRows(await readJson(path));
}

export function parseSiteFinderCompanyRows(input: unknown): SiteFinderRows {
  const contractors: CompanyUniverseInputRow[] = [];
  const clients: CompanyUniverseInputRow[] = [];
  const contractorIdentities = new Set<string>();
  const clientIdentities = new Set<string>();
  for (const [index, raw] of rowsFromJson(input).entries()) {
    const row = objectValue(raw);
    const source = objectValue(row["source_data"]);
    const contractorId =
      firstText(row, ["MainContractorId", "main_contractor_id"]) ||
      firstText(source, ["MainContractorId"]);
    const contractorName =
      firstText(row, ["MainContractor", "main_contractor"]) ||
      firstText(source, ["MainContractor"]);
    const clientId =
      firstText(row, ["ClientId", "client_id"]) ||
      firstText(source, ["ClientId"]);
    const clientName =
      firstText(row, ["Client", "client"]) || firstText(source, ["Client"]);

    if (contractorId && contractorName) {
      const identity = `${contractorId}\u0000${contractorName}`;
      if (!contractorIdentities.has(identity)) {
        contractorIdentities.add(identity);
        contractors.push({ sourceId: contractorId, name: contractorName });
      }
    } else if (contractorId || contractorName) {
      throw new Error(
        `SiteFinder row ${index + 1} has an incomplete main-contractor identity`,
      );
    }
    if (clientId && clientName) {
      const identity = `${clientId}\u0000${clientName}`;
      if (!clientIdentities.has(identity)) {
        clientIdentities.add(identity);
        clients.push({ sourceId: clientId, name: clientName });
      }
    } else if (clientId || clientName) {
      throw new Error(
        `SiteFinder row ${index + 1} has an incomplete client identity`,
      );
    }
  }
  return { contractors, clients };
}

export interface CompanyUniverseInputPaths {
  attioCompanies?: string;
  pipedriveCompanies?: string;
  fileCompanies?: string;
  sitefinderProjects?: string;
}

export type CapturedCompanyUniverseInputs = Partial<
  Record<keyof CompanyUniverseInputPaths, ImmutableInput>
>;

export async function captureCompanyUniverseInputs(
  paths: CompanyUniverseInputPaths,
): Promise<CapturedCompanyUniverseInputs> {
  const entries = await Promise.all(
    Object.entries(paths).map(async ([kind, path]) => [
      kind,
      await captureImmutableInput(path),
    ] as const),
  );
  return Object.fromEntries(entries) as CapturedCompanyUniverseInputs;
}

export function parseCapturedCompanyUniverseInputs(
  captured: CapturedCompanyUniverseInputs,
): CompanyUniverseInputs {
  const attio = captured.attioCompanies
    ? parseCompanyUniverseRows(parseCapturedJson(captured.attioCompanies))
    : undefined;
  const pipedrive = captured.pipedriveCompanies
    ? parseCompanyUniverseRows(parseCapturedJson(captured.pipedriveCompanies))
    : undefined;
  const file = captured.fileCompanies
    ? parseCompanyUniverseRows(parseCapturedJson(captured.fileCompanies))
    : undefined;
  const sitefinder = captured.sitefinderProjects
    ? parseSiteFinderCompanyRows(
        parseCapturedJson(captured.sitefinderProjects),
      )
    : undefined;
  return {
    ...(attio ? { attio } : {}),
    ...(pipedrive ? { pipedrive } : {}),
    ...(file ? { file } : {}),
    ...(sitefinder
      ? {
          sitefinderContractors: sitefinder.contractors,
          sitefinderClients: sitefinder.clients,
        }
      : {}),
  };
}

export async function loadCompanyUniverseInputs(
  paths: CompanyUniverseInputPaths,
): Promise<CompanyUniverseInputs> {
  return parseCapturedCompanyUniverseInputs(
    await captureCompanyUniverseInputs(paths),
  );
}

const BLOCKING_REVIEW_KINDS = new Set<CompanyUniverseReviewKind>([
  "row_domain_conflict",
  "shared_domain_identity_conflict",
  "shared_domain_legal_form_conflict",
  "shared_domain_partial_company_number",
  "duplicate_source_id",
  "missing_name",
  "merged_name_conflict",
  "company_number_conflict",
  "domain_conflict",
  "reviewed_identity_conflict",
]);

function websiteFor(company: UniverseCompany, domain: string): string {
  for (const record of company.sourceRecords) {
    if (!record.rawWebsiteUrl) continue;
    if (canonicalDomain(record.rawWebsiteUrl) !== domain) continue;
    try {
      const url = new URL(
        /^[a-z][a-z0-9+.-]*:\/\//iu.test(record.rawWebsiteUrl)
          ? record.rawWebsiteUrl
          : `https://${record.rawWebsiteUrl}`,
      );
      if (url.protocol === "https:" || url.protocol === "http:") {
        return url.toString();
      }
    } catch {
      // The normalized domain remains usable as the conservative fallback.
    }
  }
  return `https://${domain}`;
}

export interface CompanyResearchPlan {
  companies: CompanySeed[];
  blockedCompanyIds: string[];
}

export function createCompanyResearchPlan(
  result: CompanyUniverseResult,
): CompanyResearchPlan {
  const blocked = new Set(
    result.reviewQueue
      .filter((item) => BLOCKING_REVIEW_KINDS.has(item.kind))
      .flatMap((item) => item.companyIds),
  );
  const companies: CompanySeed[] = [];
  for (const company of result.companies) {
    if (blocked.has(company.id) || company.mergeDomains.length !== 1) continue;
    const domain = company.mergeDomains[0];
    if (!domain) continue;
    const source =
      company.sourceIds.attio.length > 0
        ? "attio"
        : company.sourceIds.pipedrive.length > 0
          ? "pipedrive"
          : "file";
    const sourceRecordId =
      source === "attio"
        ? company.sourceIds.attio[0]
        : source === "pipedrive"
          ? company.sourceIds.pipedrive[0]
          : company.sourceIds.file[0];
    companies.push({
      id: company.id,
      name: company.preferredName,
      domain,
      websiteUrl: websiteFor(company, domain),
      source,
      ...(sourceRecordId ? { sourceRecordId } : {}),
      sourceIds: company.sourceIds,
      ...(company.companyNumbers.length === 1
        ? { companyNumber: company.companyNumbers[0] }
        : {}),
      labels: company.sourceRecords.map((record) => record.sourceKey),
    });
  }
  return {
    companies,
    blockedCompanyIds: [...new Set([
      ...blocked,
      ...result.companies
        .filter((company) => company.mergeDomains.length !== 1)
        .map((company) => company.id),
    ])].sort(),
  };
}
