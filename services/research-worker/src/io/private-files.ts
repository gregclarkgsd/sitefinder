import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { CompanySeed, CrmCompanySnapshot } from "../types.js";
import {
  canonicalDomain,
  normalizeHostname,
  stableId,
} from "../lib/normalize.js";
import {
  openPrivateOutputFile,
  preparePrivateOutputDirectory,
  privateOutputFile,
  type PrivateOutputDirectory,
  unlinkOpenedPrivateOutputFile,
} from "./private-data-boundary.js";

const companySeedSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  domain: z.string().min(1),
  websiteUrl: z.url().optional(),
  apolloSearchDomain: z.string().trim().min(1).max(253).optional(),
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

const crmCompanySnapshotSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1),
  domain: z.string().trim().min(1).optional(),
  websiteUrl: z.url().optional(),
  source: z.enum(["attio", "pipedrive"]),
  sourceRecordId: z.string().min(1),
  labels: z.array(z.string()).optional(),
});

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function loadCompanySeeds(path: string): Promise<CompanySeed[]> {
  const input = await readJson<unknown>(path);
  const rows = Array.isArray(input)
    ? input
    : input && typeof input === "object" && Array.isArray((input as { data?: unknown }).data)
      ? (input as { data: unknown[] }).data
      : null;
  if (!rows) throw new Error("Company input must be a JSON array or { data: [] }");

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
    const apolloSearchDomain = parsed.apolloSearchDomain
      ? normalizeHostname(parsed.apolloSearchDomain)
      : undefined;
    if (parsed.apolloSearchDomain && !apolloSearchDomain) {
      throw new Error(
        `Invalid Apollo search domain at input row ${index + 1}`,
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
      ...(apolloSearchDomain ? { apolloSearchDomain } : {}),
      source: parsed.source,
      ...(parsed.sourceRecordId
        ? { sourceRecordId: parsed.sourceRecordId }
        : {}),
      ...(sourceIds ? { sourceIds } : {}),
      ...(parsed.companyNumber ? { companyNumber: parsed.companyNumber } : {}),
      ...(parsed.postcode ? { postcode: parsed.postcode } : {}),
      ...(parsed.latitude !== undefined ? { latitude: parsed.latitude } : {}),
      ...(parsed.longitude !== undefined ? { longitude: parsed.longitude } : {}),
      ...(parsed.labels ? { labels: parsed.labels } : {}),
    };
  });
}

export async function loadCrmCompanySnapshots(
  path: string,
): Promise<CrmCompanySnapshot[]> {
  const input = await readJson<unknown>(path);
  const rows = Array.isArray(input)
    ? input
    : input &&
        typeof input === "object" &&
        Array.isArray((input as { data?: unknown }).data)
      ? (input as { data: unknown[] }).data
      : null;
  if (!rows) {
    throw new Error("CRM company snapshot must be a JSON array or { data: [] }");
  }
  return rows.map((row, index) => {
    const parsed = crmCompanySnapshotSchema.parse(row);
    const domain = parsed.domain ? canonicalDomain(parsed.domain) : null;
    if (parsed.domain && !domain) {
      throw new Error(`Invalid CRM company domain at row ${index + 1}`);
    }
    if (
      domain &&
      parsed.websiteUrl &&
      canonicalDomain(parsed.websiteUrl) !== domain
    ) {
      throw new Error(
        `CRM company website does not match its domain at row ${index + 1}`,
      );
    }
    return {
      id: parsed.id,
      name: parsed.name,
      source: parsed.source,
      sourceRecordId: parsed.sourceRecordId,
      ...(domain ? { domain } : {}),
      ...(parsed.websiteUrl ? { websiteUrl: parsed.websiteUrl } : {}),
      ...(parsed.labels ? { labels: parsed.labels } : {}),
    };
  });
}

export async function writePrivateJson(
  output: PrivateOutputDirectory,
  relativeFile: string,
  value: unknown,
): Promise<void> {
  const { handle } = await openPrivateOutputFile(output, relativeFile);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

export async function writePrivateJsonLines(
  output: PrivateOutputDirectory,
  relativeFile: string,
  values: unknown[],
): Promise<void> {
  const body = values.map((value) => JSON.stringify(value)).join("\n");
  const { handle } = await openPrivateOutputFile(output, relativeFile);
  try {
    await handle.writeFile(body ? `${body}\n` : "", "utf8");
  } finally {
    await handle.close();
  }
}

export async function withOutputLock<T>(
  output: PrivateOutputDirectory,
  action: () => Promise<T>,
): Promise<T> {
  await preparePrivateOutputDirectory(output);
  const lockPath = privateOutputFile(output, ".enrichment.lock");
  let handle;
  try {
    ({ handle } = await openPrivateOutputFile(
      output,
      ".enrichment.lock",
    ));
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Another enrichment run owns ${lockPath}`);
    }
    throw error;
  }

  try {
    return await action();
  } finally {
    try {
      await unlinkOpenedPrivateOutputFile(output, lockPath, handle);
    } catch {
      // If the directory or lock identity changed, leave the file in place.
      // Removing a pathname that no longer names our handle is less safe.
    }
    await handle.close();
  }
}
