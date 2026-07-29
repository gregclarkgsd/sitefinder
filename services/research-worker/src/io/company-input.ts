import { z } from "zod";
import { canonicalDomain, stableId } from "../lib/normalize.js";
import type { CompanySeed } from "../types.js";
import { parseCapturedJson, type ImmutableInput } from "./immutable-input.js";

const companySeedSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  domain: z.string().min(1),
  websiteUrl: z.url().optional(),
  source: z.enum(["attio", "pipedrive", "file"]).default("file"),
  sourceRecordId: z.string().optional(),
  sourceIds: z
    .object({
      attio: z.array(z.string().min(1)).optional(),
      pipedrive: z.array(z.string().min(1)).optional(),
      file: z.array(z.string().min(1)).optional(),
      sitefinder_contractor: z.array(z.string().min(1)).optional(),
      sitefinder_client: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  companyNumber: z.string().optional(),
  postcode: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  labels: z.array(z.string()).optional(),
});

export function parseCapturedCompanySeeds(
  captured: ImmutableInput,
): CompanySeed[] {
  const input = parseCapturedJson(captured);
  const rows = Array.isArray(input)
    ? input
    : input &&
        typeof input === "object" &&
        Array.isArray((input as { data?: unknown }).data)
      ? (input as { data: unknown[] }).data
      : null;
  if (!rows) {
    throw new Error("Company input must be a JSON array or { data: [] }");
  }
  return rows.map((row, index) => {
    const parsed = companySeedSchema.parse(row);
    const domain = canonicalDomain(parsed.domain);
    if (!domain) throw new Error(`Invalid domain at input row ${index + 1}`);
    const websiteUrl = parsed.websiteUrl ?? `https://${domain}`;
    if (canonicalDomain(websiteUrl) !== domain) {
      throw new Error(
        `Website domain does not match company domain at input row ${index + 1}`,
      );
    }
    const sourceIds = parsed.sourceIds
      ? {
          ...(parsed.sourceIds.attio
            ? { attio: parsed.sourceIds.attio }
            : {}),
          ...(parsed.sourceIds.pipedrive
            ? { pipedrive: parsed.sourceIds.pipedrive }
            : {}),
          ...(parsed.sourceIds.file ? { file: parsed.sourceIds.file } : {}),
          ...(parsed.sourceIds.sitefinder_contractor
            ? {
                sitefinder_contractor:
                  parsed.sourceIds.sitefinder_contractor,
              }
            : {}),
          ...(parsed.sourceIds.sitefinder_client
            ? { sitefinder_client: parsed.sourceIds.sitefinder_client }
            : {}),
        }
      : undefined;
    return {
      id: parsed.id ?? stableId(parsed.source, parsed.name, domain),
      name: parsed.name.trim(),
      domain,
      websiteUrl,
      source: parsed.source,
      ...(parsed.sourceRecordId
        ? { sourceRecordId: parsed.sourceRecordId }
        : {}),
      ...(sourceIds ? { sourceIds } : {}),
      ...(parsed.companyNumber ? { companyNumber: parsed.companyNumber } : {}),
      ...(parsed.postcode ? { postcode: parsed.postcode } : {}),
      ...(parsed.latitude !== undefined ? { latitude: parsed.latitude } : {}),
      ...(parsed.longitude !== undefined
        ? { longitude: parsed.longitude }
        : {}),
      ...(parsed.labels ? { labels: parsed.labels } : {}),
    };
  });
}
