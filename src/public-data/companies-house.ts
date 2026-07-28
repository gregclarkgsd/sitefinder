import type { CompanyFacts, CompanySeed, Evidence } from "../types.js";
import {
  normalizeCompanyName,
  sameCompanyName,
  stableId,
} from "../lib/normalize.js";
import { fetchJson } from "../lib/http.js";

interface CompaniesHouseAddress {
  address_line_1?: string;
  address_line_2?: string;
  care_of?: string;
  country?: string;
  locality?: string;
  postal_code?: string;
  premises?: string;
  region?: string;
}

interface CompanySearchItem {
  title: string;
  company_number: string;
  company_status?: string;
  address?: CompaniesHouseAddress;
}

interface CompanySearchResponse {
  items?: CompanySearchItem[];
}

interface CompanyProfileResponse {
  company_name: string;
  company_number: string;
  company_status?: string;
  type?: string;
  date_of_creation?: string;
  registered_office_address?: CompaniesHouseAddress;
  sic_codes?: string[];
  accounts?: {
    overdue?: boolean;
  };
}

export interface CompaniesHouseResult {
  facts: CompanyFacts;
  evidence: Evidence[];
  warnings: string[];
}

function formatAddress(address: CompaniesHouseAddress | undefined): string {
  if (!address) return "";
  return [
    address.care_of,
    address.premises,
    address.address_line_1,
    address.address_line_2,
    address.locality,
    address.region,
    address.postal_code,
    address.country,
  ]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(", ");
}

function postcode(value: string | undefined): string {
  return (value ?? "").toUpperCase().replace(/\s+/gu, "");
}

export class CompaniesHouseReader {
  readonly #authorization: string;
  readonly #fetchImpl: typeof fetch;

  constructor(apiKey: string, fetchImpl: typeof fetch = fetch) {
    this.#authorization = `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
    this.#fetchImpl = fetchImpl;
  }

  async #profile(companyNumber: string): Promise<CompanyProfileResponse> {
    return fetchJson<CompanyProfileResponse>(
      `https://api.company-information.service.gov.uk/company/${encodeURIComponent(companyNumber)}`,
      {
        method: "GET",
        headers: {
          authorization: this.#authorization,
          accept: "application/json",
        },
      },
      { fetchImpl: this.#fetchImpl },
    );
  }

  async #resolveCompanyNumber(company: CompanySeed): Promise<{
    companyNumber?: string;
    confidence: number;
    warning?: string;
  }> {
    if (company.companyNumber) {
      return { companyNumber: company.companyNumber, confidence: 1 };
    }

    const url = new URL(
      "https://api.company-information.service.gov.uk/search/companies",
    );
    url.searchParams.set("q", company.name);
    url.searchParams.set("items_per_page", "5");
    const response = await fetchJson<CompanySearchResponse>(
      url,
      {
        method: "GET",
        headers: {
          authorization: this.#authorization,
          accept: "application/json",
        },
      },
      { fetchImpl: this.#fetchImpl },
    );
    const candidates = response.items ?? [];
    const exact = candidates.filter(
      (candidate) =>
        normalizeCompanyName(candidate.title) === normalizeCompanyName(company.name),
    );
    if (exact.length === 1 && exact[0]) {
      return { companyNumber: exact[0].company_number, confidence: 0.96 };
    }

    const postcodeMatch = company.postcode
      ? candidates.filter(
          (candidate) =>
            sameCompanyName(candidate.title, company.name) &&
            postcode(candidate.address?.postal_code) === postcode(company.postcode),
        )
      : [];
    if (postcodeMatch.length === 1 && postcodeMatch[0]) {
      return { companyNumber: postcodeMatch[0].company_number, confidence: 0.94 };
    }

    return {
      confidence: 0,
      warning:
        candidates.length === 0
          ? "No Companies House candidate found"
          : "Companies House match is ambiguous and was not selected",
    };
  }

  async enrich(company: CompanySeed): Promise<CompaniesHouseResult> {
    const resolved = await this.#resolveCompanyNumber(company);
    if (!resolved.companyNumber) {
      return {
        facts: {},
        evidence: [],
        warnings: resolved.warning ? [resolved.warning] : [],
      };
    }

    const profile = await this.#profile(resolved.companyNumber);
    const sourceUrl = `https://find-and-update.company-information.service.gov.uk/company/${encodeURIComponent(profile.company_number)}`;
    const capturedAt = new Date().toISOString();
    const registeredOffice = formatAddress(profile.registered_office_address);
    const facts: CompanyFacts = {
      legalName: profile.company_name,
      companyNumber: profile.company_number,
      ...(profile.company_status
        ? { companyStatus: profile.company_status }
        : {}),
      ...(profile.type ? { companyType: profile.type } : {}),
      ...(profile.date_of_creation
        ? { incorporationDate: profile.date_of_creation }
        : {}),
      ...(registeredOffice ? { registeredOffice } : {}),
      ...(profile.sic_codes ? { sicCodes: profile.sic_codes } : {}),
      ...(profile.accounts?.overdue !== undefined
        ? { accountsOverdue: profile.accounts.overdue }
        : {}),
    };
    const evidence = Object.entries(facts).map(([field, value]): Evidence => ({
      id: stableId(company.id, "companies_house", field),
      companyId: company.id,
      sourceKind: "companies_house",
      sourceUrl,
      capturedAt,
      field,
      value: Array.isArray(value) ? value.join(", ") : String(value),
      confidence: resolved.confidence,
    }));
    return { facts, evidence, warnings: [] };
  }
}
