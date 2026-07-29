import type {
  AttioPersonSnapshot,
  CrmCompanySnapshot,
} from "../types.js";
import { canonicalDomain, collapseWhitespace } from "../lib/normalize.js";
import { fetchJson } from "../lib/http.js";

interface AttioRecord {
  id: {
    record_id: string;
  };
  values: Record<string, unknown>;
  web_url?: string;
}

interface AttioListResponse {
  data: AttioRecord[];
}

type ValueObject = Record<string, unknown>;

function valueArray(
  values: Record<string, unknown>,
  attribute: string,
): ValueObject[] {
  const raw = values[attribute];
  return Array.isArray(raw)
    ? raw.filter(
        (item): item is ValueObject => Boolean(item && typeof item === "object"),
      )
    : [];
}

function firstString(
  values: Record<string, unknown>,
  attribute: string,
  fields: string[] = ["value"],
): string {
  const item = valueArray(values, attribute)[0];
  if (!item) return "";
  for (const field of fields) {
    const value = item[field];
    if (typeof value === "string" && value.trim()) return collapseWhitespace(value);
  }
  return "";
}

function attioName(values: Record<string, unknown>): string {
  const name = valueArray(values, "name")[0];
  if (!name) return "";
  const full = name["full_name"] ?? name["value"];
  if (typeof full === "string" && full.trim()) return collapseWhitespace(full);
  return collapseWhitespace(
    [name["first_name"], name["last_name"]]
      .filter((part): part is string => typeof part === "string")
      .join(" "),
  );
}

function attioEmails(values: Record<string, unknown>): string[] {
  return [
    ...new Set(
      valueArray(values, "email_addresses")
        .map((item) => item["email_address"] ?? item["value"])
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

export class AttioReader {
  readonly #token: string;
  readonly #fetchImpl: typeof fetch;

  constructor(token: string, fetchImpl: typeof fetch = fetch) {
    this.#token = token;
    this.#fetchImpl = fetchImpl;
  }

  async listRecords(objectSlug: string): Promise<AttioRecord[]> {
    const records: AttioRecord[] = [];
    const limit = 500;
    for (let offset = 0; ; offset += limit) {
      const response = await fetchJson<AttioListResponse>(
        `https://api.attio.com/v2/objects/${encodeURIComponent(objectSlug)}/records/query`,
        {
          method: "POST",
          redirect: "error",
          headers: {
            authorization: `Bearer ${this.#token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ limit, offset }),
        },
        { fetchImpl: this.#fetchImpl },
      );
      records.push(...response.data);
      if (response.data.length < limit) return records;
    }
  }

  async snapshotCompanies(): Promise<CrmCompanySnapshot[]> {
    const records = await this.listRecords("companies");
    return records.flatMap((record) => {
      const name = firstString(record.values, "name");
      const domains = valueArray(record.values, "domains")
        .map((item) => item["domain"] ?? item["value"])
        .filter((value): value is string => typeof value === "string")
        .map(canonicalDomain)
        .filter((value): value is string => value !== null);
      const domain = domains[0];
      if (!name) return [];
      return [
        {
          id: `attio:${record.id.record_id}`,
          name,
          source: "attio" as const,
          sourceRecordId: record.id.record_id,
          ...(domain
            ? { domain, websiteUrl: `https://${domain}` }
            : {}),
        },
      ];
    });
  }

  async snapshotPeople(): Promise<AttioPersonSnapshot[]> {
    const records = await this.listRecords("people");
    return records.map((record) => ({
      recordId: record.id.record_id,
      name: attioName(record.values),
      emails: attioEmails(record.values),
      jobTitle: firstString(record.values, "job_title", ["value", "option_title"]),
      companyRecordIds: valueArray(record.values, "company")
        .map((item) => item["target_record_id"])
        .filter((value): value is string => typeof value === "string"),
    }));
  }
}
