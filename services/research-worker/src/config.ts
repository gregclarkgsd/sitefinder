import { isAbsolute, normalize } from "node:path";
import { z } from "zod";
import { trustedPipedriveBaseUrl } from "./crm/pipedrive-url.js";

const positiveInteger = z.coerce.number().int().positive();
const nonNegativeInteger = z.coerce.number().int().nonnegative();
const optionalSecret = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().min(1).optional(),
);
const absoluteDirectory = z
  .string()
  .trim()
  .min(1)
  .refine(isAbsolute, {
    message: "RESEARCH_PRIVATE_DATA_DIRECTORY must be an absolute path",
  });

const environmentSchema = z.object({
  RESEARCH_PRIVATE_DATA_DIRECTORY: absoluteDirectory,
  ATTIO_API_TOKEN: optionalSecret,
  PIPEDRIVE_API_TOKEN: optionalSecret,
  PIPEDRIVE_API_DOMAIN: z
    .url()
    .default("https://api.pipedrive.com")
    .transform((value, context) => {
      try {
        return trustedPipedriveBaseUrl(value);
      } catch (error) {
        context.addIssue({
          code: "custom",
          message:
            error instanceof Error
              ? error.message
              : "Invalid Pipedrive API base URL",
        });
        return z.NEVER;
      }
    }),
  COMPANIES_HOUSE_API_KEY: optionalSecret,
  APOLLO_API_KEY: optionalSecret,
  RESEARCH_AGENT_INGEST_URL: z.url().optional(),
  RESEARCH_AGENT_INGEST_TOKEN: optionalSecret,
  CRAWLER_CONTACT_URL: z.url().default("https://www.gsdecorating.com/"),
  CRAWLER_MAX_PAGES: positiveInteger.default(12),
  CRAWLER_MAX_PDFS: nonNegativeInteger.default(3),
  CRAWLER_DELAY_MS: positiveInteger.default(800),
  CRAWLER_TIMEOUT_MS: positiveInteger.default(12_000),
});

export interface AppConfig {
  privateDataDirectory: string;
  attioToken?: string;
  pipedriveToken?: string;
  pipedriveApiDomain: string;
  companiesHouseApiKey?: string;
  apolloApiKey?: string;
  researchAgentIngestUrl?: string;
  researchAgentIngestToken?: string;
  crawler: {
    contactUrl: string;
    maxPages: number;
    maxPdfs: number;
    delayMs: number;
    timeoutMs: number;
    userAgent: string;
  };
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const parsed = environmentSchema.parse(environment);
  return {
    privateDataDirectory: normalize(parsed.RESEARCH_PRIVATE_DATA_DIRECTORY),
    ...(parsed.ATTIO_API_TOKEN ? { attioToken: parsed.ATTIO_API_TOKEN } : {}),
    ...(parsed.PIPEDRIVE_API_TOKEN
      ? { pipedriveToken: parsed.PIPEDRIVE_API_TOKEN }
      : {}),
    pipedriveApiDomain: parsed.PIPEDRIVE_API_DOMAIN,
    ...(parsed.COMPANIES_HOUSE_API_KEY
      ? { companiesHouseApiKey: parsed.COMPANIES_HOUSE_API_KEY }
      : {}),
    ...(parsed.APOLLO_API_KEY
      ? { apolloApiKey: parsed.APOLLO_API_KEY }
      : {}),
    ...(parsed.RESEARCH_AGENT_INGEST_URL
      ? { researchAgentIngestUrl: parsed.RESEARCH_AGENT_INGEST_URL }
      : {}),
    ...(parsed.RESEARCH_AGENT_INGEST_TOKEN
      ? { researchAgentIngestToken: parsed.RESEARCH_AGENT_INGEST_TOKEN }
      : {}),
    crawler: {
      contactUrl: parsed.CRAWLER_CONTACT_URL,
      maxPages: parsed.CRAWLER_MAX_PAGES,
      maxPdfs: parsed.CRAWLER_MAX_PDFS,
      delayMs: parsed.CRAWLER_DELAY_MS,
      timeoutMs: parsed.CRAWLER_TIMEOUT_MS,
      userAgent: `GSD-Sales-Enrichment/0.1 (+${parsed.CRAWLER_CONTACT_URL})`,
    },
  };
}

export function requireSecret(
  value: string | undefined,
  environmentName: string,
): string {
  if (!value) {
    throw new Error(
      `${environmentName} is required for this read-only command`,
    );
  }
  return value;
}
