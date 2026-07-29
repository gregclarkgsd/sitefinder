import type {
  CrmCompanySnapshot,
  PipedrivePersonSnapshot,
} from "../types.js";
import { canonicalDomain, collapseWhitespace } from "../lib/normalize.js";
import { fetchJson } from "../lib/http.js";
import { trustedPipedriveBaseUrl } from "./pipedrive-url.js";

type JsonObject = Record<string, unknown>;

interface PipedrivePage {
  success: boolean;
  data: JsonObject[];
  additional_data?: {
    next_cursor?: string | null;
    pagination?: {
      next_cursor?: string | null;
      more_items_in_collection?: boolean;
    };
  };
}

function objectValue(value: unknown): JsonObject | null {
  return value && typeof value === "object" ? (value as JsonObject) : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? collapseWhitespace(value) : "";
}

function idValue(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number") return String(value);
  const object = objectValue(value);
  const nested = object?.["value"] ?? object?.["id"];
  return typeof nested === "string" || typeof nested === "number"
    ? String(nested)
    : undefined;
}

function nameValue(value: unknown): string | undefined {
  const object = objectValue(value);
  const nested = object?.["name"];
  return typeof nested === "string" ? collapseWhitespace(nested) : undefined;
}

function contactValues(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      const object = objectValue(item);
      return typeof object?.["value"] === "string" ? object["value"] : "";
    })
    .map((item) => item.trim())
    .filter(Boolean);
}

function labelValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      const object = objectValue(item);
      const label = object?.["label"] ?? object?.["name"];
      return typeof label === "string" ? label : "";
    })
    .map(collapseWhitespace)
    .filter(Boolean);
}

const NOTE_DEPARTED_PATTERN =
  /\b(?:left\s+(?:the\s+)?(?:business|company|organisation|organization|firm|role|position|employment)|retired|departed|moved\s+on|no\s+longer\s+(?:with|at|employed)|do\s+not\s+(?:use|contact))\b/iu;

function noteDepartedSignal(value: unknown): boolean {
  const values = Array.isArray(value) ? value : [value];
  return values.some((item) => {
    const text =
      typeof item === "string"
        ? item
        : typeof objectValue(item)?.["value"] === "string"
          ? String(objectValue(item)?.["value"])
          : "";
    return NOTE_DEPARTED_PATTERN.test(text.slice(0, 10_000));
  });
}

export class PipedriveReader {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #fetchImpl: typeof fetch;

  constructor(
    token: string,
    baseUrl = "https://api.pipedrive.com",
    fetchImpl: typeof fetch = fetch,
  ) {
    this.#token = token;
    this.#baseUrl = trustedPipedriveBaseUrl(baseUrl);
    this.#fetchImpl = fetchImpl;
  }

  async list(endpoint: "persons" | "organizations"): Promise<JsonObject[]> {
    const rows: JsonObject[] = [];
    let cursor: string | undefined;
    do {
      const url = new URL(`/api/v2/${endpoint}`, this.#baseUrl);
      url.searchParams.set("limit", "500");
      if (cursor) url.searchParams.set("cursor", cursor);
      const response = await fetchJson<PipedrivePage>(
        url,
        {
          method: "GET",
          redirect: "error",
          headers: {
            accept: "application/json",
            "x-api-token": this.#token,
          },
        },
        { fetchImpl: this.#fetchImpl },
      );
      if (!response.success) throw new Error(`Pipedrive ${endpoint} request failed`);
      rows.push(...(response.data ?? []));
      cursor =
        response.additional_data?.next_cursor ??
        response.additional_data?.pagination?.next_cursor ??
        undefined;
    } while (cursor);
    return rows;
  }

  async snapshotPeople(): Promise<PipedrivePersonSnapshot[]> {
    const people = await this.list("persons");
    return people.map((person) => {
      const organization = person["org_id"] ?? person["organization_id"];
      const organizationId = idValue(organization);
      const organizationName =
        nameValue(organization) ?? stringValue(person["org_name"]);
      const id = idValue(person["id"]) ?? "";
      return {
        personId: id,
        name: stringValue(person["name"]),
        emails: [
          ...new Set(
            contactValues(person["emails"] ?? person["email"]).map((email) =>
              email.toLowerCase(),
            ),
          ),
        ],
        jobTitle: stringValue(person["job_title"]),
        ...(organizationId ? { organizationId } : {}),
        ...(organizationName ? { organizationName } : {}),
        labels: labelValues(person["labels"] ?? person["label_ids"]),
        ...(noteDepartedSignal(person["notes"] ?? person["note"])
          ? { noteDepartedSignal: true as const }
          : {}),
      };
    });
  }

  async snapshotOrganizations(
    domainFieldKey?: string,
  ): Promise<CrmCompanySnapshot[]> {
    const organizations = await this.list("organizations");
    return organizations.flatMap((organization) => {
      const id = idValue(organization["id"]);
      const name = stringValue(organization["name"]);
      const customFields = objectValue(organization["custom_fields"]);
      const domainInput =
        stringValue(organization["website"]) ||
        stringValue(organization["domain"]) ||
        (domainFieldKey ? stringValue(customFields?.[domainFieldKey]) : "");
      const domain = canonicalDomain(domainInput);
      if (!id || !name) return [];
      return [
        {
          id: `pipedrive:${id}`,
          name,
          source: "pipedrive" as const,
          sourceRecordId: id,
          labels: labelValues(organization["labels"] ?? organization["label_ids"]),
          ...(domain
            ? { domain, websiteUrl: `https://${domain}` }
            : {}),
        },
      ];
    });
  }
}
