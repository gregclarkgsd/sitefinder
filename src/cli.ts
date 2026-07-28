import "dotenv/config";
import { readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { loadConfig, requireSecret } from "./config.js";
import { AttioReader } from "./crm/attio.js";
import { PipedriveReader } from "./crm/pipedrive.js";
import {
  loadCompanySeeds,
  readJson,
  withOutputLock,
  writePrivateJson,
} from "./io/private-files.js";
import { writeEnrichmentRun } from "./io/run-output.js";
import { enrichCompanies } from "./pipeline/enrich.js";
import { CompaniesHouseReader } from "./public-data/companies-house.js";
import { reconcilePeople } from "./reconcile.js";
import type {
  AttioPersonSnapshot,
  PipedrivePersonSnapshot,
} from "./types.js";

interface Arguments {
  command?: string;
  flags: Map<string, string | true>;
}

function parseArguments(values: string[]): Arguments {
  const [command, ...rest] = values;
  const flags = new Map<string, string | true>();
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value?.startsWith("--")) {
      throw new Error(`Unexpected argument: ${value ?? ""}`);
    }
    const [rawName = "", inline] = value.slice(2).split("=", 2);
    if (!rawName) throw new Error("Empty flag name");
    if (inline !== undefined) {
      flags.set(rawName, inline);
      continue;
    }
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(rawName, next);
      index += 1;
    } else {
      flags.set(rawName, true);
    }
  }
  return { ...(command ? { command } : {}), flags };
}

function flag(
  args: Arguments,
  name: string,
  options: { required?: boolean; fallback?: string } = {},
): string | undefined {
  const value = args.flags.get(name);
  if (value === true) {
    if (options.required) throw new Error(`--${name} requires a value`);
    return "true";
  }
  if (typeof value === "string") return value;
  if (options.fallback !== undefined) return options.fallback;
  if (options.required) throw new Error(`Missing required flag --${name}`);
  return undefined;
}

function integerFlag(
  args: Arguments,
  name: string,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  const raw = flag(args, name);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new Error(
      `--${name} must be an integer from ${bounds.min} to ${bounds.max}`,
    );
  }
  return value;
}

function enabled(args: Arguments, name: string): boolean {
  const value = args.flags.get(name);
  return value === true || value === "true" || value === "yes" || value === "1";
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

function workspaceOutput(path: string): string {
  const root = resolve(process.cwd());
  const output = resolve(path);
  const child = relative(root, output);
  if (!child || child.startsWith("..") || child.startsWith("/")) {
    throw new Error("Output must be a child directory of this workspace");
  }
  return output;
}

async function assertOutputDirectoryIsEmpty(path: string): Promise<void> {
  try {
    const entries = await readdir(path);
    if (entries.length > 0) {
      throw new Error(
        `Output directory is not empty: ${relative(process.cwd(), path)}`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function rejectWriteFlags(args: Arguments): void {
  const forbidden = ["write", "write-attio", "sync", "apply"];
  const requested = forbidden.find((name) => args.flags.has(name));
  if (requested) {
    throw new Error(
      `--${requested} is unavailable: Phase 1 is structurally read-only`,
    );
  }
}

async function snapshotAttio(args: Arguments): Promise<void> {
  const config = loadConfig();
  const reader = new AttioReader(
    requireSecret(config.attioToken, "ATTIO_API_TOKEN"),
  );
  const output = workspaceOutput(
    flag(args, "output", {
      fallback: `.private/snapshots/attio-${timestamp()}`,
    }) ?? "",
  );
  await assertOutputDirectoryIsEmpty(output);
  await withOutputLock(output, async () => {
    const [companies, people] = await Promise.all([
      reader.snapshotCompanies(),
      reader.snapshotPeople(),
    ]);
    await Promise.all([
      writePrivateJson(resolve(output, "companies.json"), companies),
      writePrivateJson(resolve(output, "people.json"), people),
      writePrivateJson(resolve(output, "summary.json"), {
        mode: "read_only",
        source: "attio",
        companies: companies.length,
        people: people.length,
        capturedAt: new Date().toISOString(),
      }),
    ]);
    console.log(
      JSON.stringify({
        mode: "read_only",
        companies: companies.length,
        people: people.length,
        output: relative(process.cwd(), output),
      }),
    );
  });
}

async function snapshotPipedrive(args: Arguments): Promise<void> {
  const config = loadConfig();
  const reader = new PipedriveReader(
    requireSecret(config.pipedriveToken, "PIPEDRIVE_API_TOKEN"),
    config.pipedriveApiDomain,
  );
  const output = workspaceOutput(
    flag(args, "output", {
      fallback: `.private/snapshots/pipedrive-${timestamp()}`,
    }) ?? "",
  );
  await assertOutputDirectoryIsEmpty(output);
  await withOutputLock(output, async () => {
    const [organizations, people] = await Promise.all([
      reader.snapshotOrganizations(flag(args, "domain-field-key")),
      reader.snapshotPeople(),
    ]);
    await Promise.all([
      writePrivateJson(resolve(output, "companies.json"), organizations),
      writePrivateJson(resolve(output, "people.json"), people),
      writePrivateJson(resolve(output, "summary.json"), {
        mode: "read_only",
        source: "pipedrive",
        companiesWithDomains: organizations.length,
        people: people.length,
        capturedAt: new Date().toISOString(),
      }),
    ]);
    console.log(
      JSON.stringify({
        mode: "read_only",
        companiesWithDomains: organizations.length,
        people: people.length,
        output: relative(process.cwd(), output),
      }),
    );
  });
}

async function reconcile(args: Arguments): Promise<void> {
  const attioPath = flag(args, "attio-people", { required: true }) ?? "";
  const pipedrivePath =
    flag(args, "pipedrive-people", { required: true }) ?? "";
  const output = workspaceOutput(
    flag(args, "output", {
      fallback: `output/reconciliation-${timestamp()}`,
    }) ?? "",
  );
  await assertOutputDirectoryIsEmpty(output);
  const [attioPeople, pipedrivePeople] = await Promise.all([
    readJson<AttioPersonSnapshot[]>(attioPath),
    readJson<PipedrivePersonSnapshot[]>(pipedrivePath),
  ]);

  let companyNames = new Map<string, string>();
  const attioCompaniesPath = flag(args, "attio-companies");
  if (attioCompaniesPath) {
    const companies = await loadCompanySeeds(attioCompaniesPath);
    companyNames = new Map(
      companies.flatMap((company) =>
        company.sourceRecordId ? [[company.sourceRecordId, company.name]] : [],
      ),
    );
  }

  await withOutputLock(output, async () => {
    const report = reconcilePeople(attioPeople, pipedrivePeople, companyNames);
    await writePrivateJson(resolve(output, "reconciliation.json"), report);
    await writePrivateJson(resolve(output, "summary.json"), {
      mode: "read_only",
      attioPeople: attioPeople.length,
      pipedrivePeople: pipedrivePeople.length,
      ...report.counts,
      output: relative(process.cwd(), output),
    });
    console.log(
      JSON.stringify({
        mode: "read_only",
        attioPeople: attioPeople.length,
        pipedrivePeople: pipedrivePeople.length,
        ...report.counts,
        output: relative(process.cwd(), output),
      }),
    );
  });
}

async function enrich(args: Arguments): Promise<void> {
  const config = loadConfig();
  const input = flag(args, "input", { required: true }) ?? "";
  const output = workspaceOutput(
    flag(args, "output", {
      fallback: `output/enrichment-${timestamp()}`,
    }) ?? "",
  );
  const limit = integerFlag(args, "limit", 50, { min: 1, max: 5_304 });
  if (limit > 250 && flag(args, "confirm-large-run") !== "YES") {
    throw new Error(
      "Runs above 250 companies require --confirm-large-run=YES",
    );
  }
  const allCompanies = await loadCompanySeeds(input);
  const requestedId = flag(args, "company-id");
  const selected = (
    requestedId
      ? allCompanies.filter((company) => company.id === requestedId)
      : allCompanies
  ).slice(0, limit);
  if (selected.length === 0) throw new Error("No companies matched the run");
  await assertOutputDirectoryIsEmpty(output);

  const companiesHouse = enabled(args, "with-companies-house")
    ? new CompaniesHouseReader(
        requireSecret(
          config.companiesHouseApiKey,
          "COMPANIES_HOUSE_API_KEY",
        ),
      )
    : undefined;
  const maxPages = integerFlag(args, "max-pages", config.crawler.maxPages, {
    min: 1,
    max: 50,
  });
  const maxPdfs = integerFlag(args, "max-pdfs", config.crawler.maxPdfs, {
    min: 0,
    max: 10,
  });
  const concurrency = integerFlag(args, "concurrency", 2, {
    min: 1,
    max: 4,
  });
  const procurementDays = integerFlag(args, "procurement-days", 0, {
    min: 0,
    max: 365,
  });

  await withOutputLock(output, async () => {
    const run = await enrichCompanies(selected, {
      crawl: {
        maxPages,
        maxPdfs,
        delayMs: config.crawler.delayMs,
        timeoutMs: config.crawler.timeoutMs,
        userAgent: config.crawler.userAgent,
      },
      concurrency,
      ...(companiesHouse ? { companiesHouse } : {}),
      procurementDays,
    });
    await writeEnrichmentRun(output, run);
    console.log(
      JSON.stringify({
        mode: run.mode,
        companies: run.companyCount,
        contacts: run.contactCount,
        evidence: run.evidenceCount,
        projectSignals: run.projectSignalCount,
        output: relative(process.cwd(), output),
      }),
    );
  });
}

function printHelp(): void {
  console.log(`GSD Sales Enrichment (read-only)

Commands:
  snapshot-attio       Save private Attio company/person snapshots
  snapshot-pipedrive   Save private Pipedrive organisation/person snapshots
  reconcile            Compare private snapshots without writing to either CRM
  enrich               Crawl official company sites and optional public sources

Examples:
  npm run snapshot:attio -- --output .private/snapshots/attio
  npm run snapshot:pipedrive -- --output .private/snapshots/pipedrive
  npm run reconcile -- --attio-people .private/snapshots/attio/people.json \\
    --pipedrive-people .private/snapshots/pipedrive/people.json
  npm run enrich -- --input .private/snapshots/attio/companies.json --limit 50

CRM write flags are intentionally unsupported.`);
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  rejectWriteFlags(args);
  switch (args.command) {
    case "snapshot-attio":
      await snapshotAttio(args);
      break;
    case "snapshot-pipedrive":
      await snapshotPipedrive(args);
      break;
    case "reconcile":
      await reconcile(args);
      break;
    case "enrich":
      await enrich(args);
      break;
    case "help":
    case "--help":
    case undefined:
      printHelp();
      break;
    default:
      throw new Error(`Unknown command: ${args.command}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exitCode = 1;
});
