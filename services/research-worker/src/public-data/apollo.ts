import { z } from "zod";
import { fetchJson } from "../lib/http.js";
import {
  canonicalDomain,
  isBusinessEmail,
  normalizeHostname,
  normalizeEmail,
  normalizePersonName,
  stableId,
} from "../lib/normalize.js";
import { classifyRoleTitle } from "../lib/roles.js";
import type {
  CompanySeed,
  ContactCandidate,
  Evidence,
} from "../types.js";

const APOLLO_SEARCH_ENDPOINT =
  "https://api.apollo.io/api/v1/mixed_people/api_search";
const APOLLO_ENRICH_ENDPOINT = "https://api.apollo.io/api/v1/people/match";
const APOLLO_RECORD_ROOT = "https://app.apollo.io/";

const targetTitles = [
  "quantity surveyor",
  "commercial manager",
  "commercial director",
  "head of commercial",
  "procurement manager",
  "procurement director",
  "purchasing manager",
  "buyer",
  "supply chain manager",
  "supply chain director",
  "project manager",
  "project director",
  "contracts manager",
  "contract surveyor",
  "site surveyor",
  "estimator",
  "estimating manager",
  "preconstruction manager",
  "site manager",
] as const;

const searchResponseSchema = z
  .object({
    people: z
      .array(
        z
          .object({
            id: z.string().trim().min(1),
            title: z.string().trim().nullable().optional(),
            has_email: z.boolean().optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

const enrichmentResponseSchema = z
  .object({
    person: z
      .object({
        id: z.string().trim().min(1),
        name: z.string().trim().min(1),
        title: z.string().trim().min(1),
        email: z.string().trim().email().nullable().optional(),
        email_status: z.string().trim().nullable().optional(),
        linkedin_url: z.string().trim().nullable().optional(),
        organization: z
          .object({
            primary_domain: z.string().trim().nullable().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export interface ApolloPeopleResult {
  contacts: ContactCandidate[];
  evidence: Evidence[];
  warnings: string[];
}

export interface ApolloPeopleReaderOptions {
  fetchImpl?: typeof fetch;
  maxPeople?: number;
  timeoutMs?: number;
}

function linkedinProfileUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      !["linkedin.com", "www.linkedin.com"].includes(url.hostname.toLowerCase()) ||
      !url.pathname.toLowerCase().startsWith("/in/")
    ) {
      return null;
    }
    url.protocol = "https:";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function apolloRecordUrl(personId: string): string {
  const url = new URL(APOLLO_RECORD_ROOT);
  url.hash = `/people/${encodeURIComponent(personId)}`;
  return url.toString();
}

export class ApolloPeopleReader {
  readonly #apiKey: string;
  readonly #fetchImpl: typeof fetch | undefined;
  readonly #maxPeople: number;
  readonly #timeoutMs: number;

  constructor(apiKey: string, options: ApolloPeopleReaderOptions = {}) {
    const trimmed = apiKey.trim();
    if (!trimmed) throw new Error("Apollo API key cannot be empty");
    this.#apiKey = trimmed;
    this.#fetchImpl = options.fetchImpl;
    this.#maxPeople = Math.max(1, Math.min(options.maxPeople ?? 10, 25));
    this.#timeoutMs = options.timeoutMs ?? 20_000;
  }

  async #request<T>(url: URL, schema: z.ZodType<T>): Promise<T> {
    const response = await fetchJson<unknown>(
      url,
      {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          "x-api-key": this.#apiKey,
        },
      },
      {
        ...(this.#fetchImpl ? { fetchImpl: this.#fetchImpl } : {}),
        timeoutMs: this.#timeoutMs,
        maxBytes: 5_000_000,
      },
    );
    return schema.parse(response);
  }

  async #search(searchDomain: string): Promise<string[]> {
    const url = new URL(APOLLO_SEARCH_ENDPOINT);
    url.searchParams.append("q_organization_domains_list[]", searchDomain);
    url.searchParams.append("contact_email_status[]", "verified");
    for (const title of targetTitles) {
      url.searchParams.append("person_titles[]", title);
    }
    url.searchParams.set("include_similar_titles", "true");
    url.searchParams.set("page", "1");
    url.searchParams.set("per_page", String(this.#maxPeople));

    const response = await this.#request(url, searchResponseSchema);
    return response.people
      .filter(
        (person) =>
          person.has_email === true &&
          Boolean(person.title && classifyRoleTitle(person.title)),
      )
      .map(({ id }) => id)
      .slice(0, this.#maxPeople);
  }

  async #enrichPerson(
    company: CompanySeed,
    searchDomain: string,
    personId: string,
    capturedAt: string,
  ): Promise<{ contact: ContactCandidate; evidence: Evidence[] } | null> {
    const url = new URL(APOLLO_ENRICH_ENDPOINT);
    url.searchParams.set("id", personId);
    url.searchParams.set("domain", searchDomain);
    url.searchParams.set("reveal_personal_emails", "false");
    url.searchParams.set("reveal_phone_number", "false");
    url.searchParams.set("run_waterfall_email", "false");
    url.searchParams.set("run_waterfall_phone", "false");

    const response = await this.#request(url, enrichmentResponseSchema);
    const person = response.person;
    if (!person) return null;
    const role = classifyRoleTitle(person.title);
    const email = person.email ? normalizeEmail(person.email) : "";
    const organizationDomain = canonicalDomain(
      person.organization?.primary_domain ?? "",
    );
    const searchedOrganizationDomain = canonicalDomain(searchDomain);
    if (
      !role ||
      !email ||
      person.email_status?.toLowerCase() !== "verified" ||
      !isBusinessEmail(email) ||
      !organizationDomain ||
      organizationDomain !== searchedOrganizationDomain
    ) {
      return null;
    }

    const sourceUrl = apolloRecordUrl(person.id);
    const roleEvidenceId = stableId(
      company.id,
      "apollo",
      person.id,
      "contact_role",
    );
    const emailEvidenceId = stableId(
      company.id,
      "apollo",
      person.id,
      "licensed_business_email",
    );
    const profileUrl = linkedinProfileUrl(person.linkedin_url);
    const evidence: Evidence[] = [
      {
        id: roleEvidenceId,
        companyId: company.id,
        sourceKind: "apollo",
        sourceUrl,
        capturedAt,
        field: "contact_role",
        value: `${person.name} — ${person.title}`,
        excerpt:
          "Apollo returned this current target role for the exact company domain.",
        confidence: 0.86,
      },
      {
        id: emailEvidenceId,
        companyId: company.id,
        sourceKind: "apollo",
        sourceUrl,
        capturedAt,
        field: "licensed_business_email",
        value: email,
        excerpt:
          "Apollo labelled this business email verified. It is licensed-provider data, not public-source evidence.",
        confidence: 0.86,
      },
    ];

    return {
      contact: {
        id: stableId(company.id, "apollo", person.id),
        companyId: company.id,
        name: person.name,
        normalizedName: normalizePersonName(person.name),
        jobTitle: person.title,
        roleCategory: role.category,
        rolePriority: role.priority,
        employmentStatus: "current",
        emails: [{ value: email, status: "licensed_provider" }],
        phones: [],
        profileUrls: profileUrl ? [profileUrl] : [],
        evidenceIds: [roleEvidenceId, emailEvidenceId],
        confidence: 0.86,
      },
      evidence,
    };
  }

  async enrich(company: CompanySeed): Promise<ApolloPeopleResult> {
    const capturedAt = new Date().toISOString();
    const searchDomain = normalizeHostname(
      company.apolloSearchDomain ?? company.domain,
    );
    if (!searchDomain) {
      throw new Error("Apollo search domain is invalid");
    }
    const personIds = await this.#search(searchDomain);
    const settled = await Promise.allSettled(
      personIds.map((personId) =>
        this.#enrichPerson(company, searchDomain, personId, capturedAt),
      ),
    );
    const contacts: ContactCandidate[] = [];
    const evidence: Evidence[] = [];
    const warnings: string[] = [];
    for (const result of settled) {
      if (result.status === "rejected") {
        warnings.push("Apollo could not enrich one selected target-role person.");
        continue;
      }
      if (!result.value) continue;
      contacts.push(result.value.contact);
      evidence.push(...result.value.evidence);
    }
    return { contacts, evidence, warnings };
  }
}
