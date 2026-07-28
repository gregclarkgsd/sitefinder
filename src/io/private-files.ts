import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { CompanySeed } from "../types.js";
import { canonicalDomain, stableId } from "../lib/normalize.js";

const companySeedSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  domain: z.string().min(1),
  websiteUrl: z.url().optional(),
  source: z.enum(["attio", "pipedrive", "file"]).default("file"),
  sourceRecordId: z.string().optional(),
  companyNumber: z.string().optional(),
  postcode: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
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
    return {
      id: parsed.id ?? stableId(parsed.source, parsed.name, domain),
      name: parsed.name.trim(),
      domain,
      websiteUrl,
      source: parsed.source,
      ...(parsed.sourceRecordId
        ? { sourceRecordId: parsed.sourceRecordId }
        : {}),
      ...(parsed.companyNumber ? { companyNumber: parsed.companyNumber } : {}),
      ...(parsed.postcode ? { postcode: parsed.postcode } : {}),
      ...(parsed.latitude !== undefined ? { latitude: parsed.latitude } : {}),
      ...(parsed.longitude !== undefined ? { longitude: parsed.longitude } : {}),
      ...(parsed.labels ? { labels: parsed.labels } : {}),
    };
  });
}

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const resolved = resolve(path);
  await mkdir(dirname(resolved), { recursive: true, mode: 0o700 });
  const handle = await open(resolved, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

export async function writePrivateJsonLines(
  path: string,
  values: unknown[],
): Promise<void> {
  const body = values.map((value) => JSON.stringify(value)).join("\n");
  const resolved = resolve(path);
  await mkdir(dirname(resolved), { recursive: true, mode: 0o700 });
  const handle = await open(resolved, "w", 0o600);
  try {
    await handle.writeFile(body ? `${body}\n` : "", "utf8");
  } finally {
    await handle.close();
  }
}

export async function withOutputLock<T>(
  outputDirectory: string,
  action: () => Promise<T>,
): Promise<T> {
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const lockPath = resolve(outputDirectory, ".enrichment.lock");
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
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
    await handle.close();
    await rm(lockPath, { force: true });
  }
}
