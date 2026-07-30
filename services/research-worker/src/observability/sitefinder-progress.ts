import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  assertPublicHttpUrl,
  type DnsLookup,
} from "../lib/public-url.js";
import type { HeldCleanupMatch } from "../policy/apply-cleanup-policy.js";
import type { SiteFinderDiscoveryComparison } from "../comparison/discovery-comparison.js";
import type { EnrichmentRun } from "../pipeline/enrich.js";
import type { EnrichmentProgressEvent } from "../pipeline/enrich.js";
import type {
  CompanySeed,
  ContactCandidate,
  EnrichedCompany,
  Evidence,
} from "../types.js";

interface PublisherOptions {
  endpoint: string;
  token: string;
  fetchImpl?: typeof fetch;
  lookup?: DnsLookup;
  timeoutMs?: number;
  controlPollMs?: number;
  runId?: string;
  initialSequence?: number;
}

interface StartOptions {
  name: string;
  source: "attio" | "pipedrive" | "file";
  companies: CompanySeed[];
  configuration: Record<string, unknown>;
}

type RunControlStatus =
  | "queued"
  | "running"
  | "paused"
  | "stopping"
  | "completed"
  | "failed"
  | "cancelled";

const runControlStatuses = new Set<RunControlStatus>([
  "queued",
  "running",
  "paused",
  "stopping",
  "completed",
  "failed",
  "cancelled",
]);

const queueClaimSchema = z
  .object({
    claimed: z.literal(true),
    run: z
      .object({
        id: z.uuid(),
        name: z.string().trim().min(1).max(120),
        requestedSources: z
          .array(
            z.enum([
              "website",
              "apollo",
              "companiesHouse",
              "procurement",
            ]),
          )
          .min(1)
          .max(4),
        apolloMaxPeople: z.number().int().min(1).max(25),
        procurementDays: z.number().int().min(0).max(365),
        companies: z
          .array(
            z
              .object({
                companyId: z.string().trim().min(1).max(240),
                companyName: z.string().trim().min(1).max(240),
                domain: z
                  .string()
                  .min(3)
                  .max(253)
                  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u),
                apolloSearchDomain: z
                  .string()
                  .min(3)
                  .max(253)
                  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u)
                  .optional(),
              })
              .strict(),
          )
          .min(1)
          .max(25),
      })
      .strict(),
  })
  .strict();

const emptyQueueSchema = z.object({
  claimed: z.literal(false),
}).strict();

export type ClaimedResearchRun = z.infer<typeof queueClaimSchema>["run"];
export type ResearchSource = ClaimedResearchRun["requestedSources"][number];

export class SiteFinderQueueClient {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly lookup: DnsLookup | undefined;
  private readonly timeoutMs: number;

  constructor(options: PublisherOptions) {
    this.endpoint = assertEndpointIsSafe(options.endpoint);
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.lookup = options.lookup;
    this.timeoutMs = options.timeoutMs ?? 12_000;
  }

  private async assertEndpointHostIsPublic(): Promise<void> {
    const url = new URL(this.endpoint);
    const localPreview =
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost");
    if (localPreview) return;
    if (this.lookup) {
      await assertPublicHttpUrl(url, this.lookup);
      return;
    }
    await assertPublicHttpUrl(url);
  }

  async claim(
    workerId: string,
    availableSources: ResearchSource[],
  ): Promise<ClaimedResearchRun | undefined> {
    const claimUrl = new URL("/api/research/worker/claim", this.endpoint);
    await this.assertEndpointHostIsPublic();
    const response = await this.fetchImpl(claimUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ workerId, availableSources }),
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(
        `Research queue endpoint returned HTTP ${response.status}`,
      );
    }
    const body = await response.json();
    const empty = emptyQueueSchema.safeParse(body);
    if (empty.success) return undefined;
    return queueClaimSchema.parse(body).run;
  }
}

function stableUuid(...values: string[]): string {
  const bytes = createHash("sha256")
    .update(values.join("\u0000"))
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function assertEndpointIsSafe(value: string): string {
  const url = new URL(value);
  const local =
    (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
    url.protocol === "http:";
  if (url.protocol !== "https:" && !local) {
    throw new Error(
      "RESEARCH_AGENT_INGEST_URL must use HTTPS except for local preview",
    );
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/api/research/ingest"
  ) {
    throw new Error(
      "RESEARCH_AGENT_INGEST_URL must be the exact SiteFinder ingestion path",
    );
  }
  return url.toString();
}

function httpsSource(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) {
      return undefined;
    }
    // Page evidence never needs a query string or fragment in the shared
    // control room. Removing both prevents accidental disclosure of signed
    // links, tracking identifiers, search terms, or session material.
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function candidateEvidence(
  result: EnrichedCompany,
  contact: ContactCandidate,
): Evidence | undefined {
  const ids = new Set(contact.evidenceIds);
  return result.evidence.find(
    (item) => ids.has(item.id) && httpsSource(item.sourceUrl),
  );
}

export class SiteFinderProgressPublisher {
  readonly runId: string;
  private readonly endpoint: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly lookup: DnsLookup | undefined;
  private readonly timeoutMs: number;
  private readonly controlPollMs: number;
  private readonly taskIds = new Map<string, string>();
  private sequence: number;
  private companiesChecked = 0;
  private pagesInspected = 0;
  private peopleFound = 0;
  private failures = 0;
  private lastControlStatus: RunControlStatus = "running";

  constructor(options: PublisherOptions) {
    this.runId = options.runId ?? randomUUID();
    this.sequence = options.initialSequence ?? 0;
    if (!z.uuid().safeParse(this.runId).success) {
      throw new Error("Research progress run ID must be a UUID");
    }
    if (!Number.isInteger(this.sequence) || this.sequence < 0) {
      throw new Error("Research progress sequence must be non-negative");
    }
    this.endpoint = assertEndpointIsSafe(options.endpoint);
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.lookup = options.lookup;
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.controlPollMs = options.controlPollMs ?? 2_000;
  }

  get failureCount(): number {
    return this.failures;
  }

  private async send(message: unknown): Promise<void> {
    await this.assertEndpointHostIsPublic();
    let lastStatus = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(message),
          redirect: "error",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        lastStatus = response.status;
        if (response.ok) return;
      } catch {
        lastStatus = 0;
      }
      if (attempt < 2) await delay(250 * (attempt + 1));
    }
    throw new Error(
      lastStatus
        ? `Research progress endpoint returned HTTP ${lastStatus}`
        : "Research progress endpoint was unavailable",
    );
  }

  private async assertEndpointHostIsPublic(): Promise<void> {
    const url = new URL(this.endpoint);
    const localPreview =
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost");
    if (localPreview) return;
    if (this.lookup) {
      await assertPublicHttpUrl(url, this.lookup);
      return;
    }
    await assertPublicHttpUrl(url);
  }

  private async bestEffort(message: unknown): Promise<void> {
    try {
      await this.send(message);
    } catch {
      this.failures += 1;
    }
  }

  private async controlStatus(): Promise<RunControlStatus> {
    const controlUrl = new URL(
      `/api/research/runs/${this.runId}/control`,
      this.endpoint,
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.assertEndpointHostIsPublic();
        const response = await this.fetchImpl(controlUrl, {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${this.token}`,
          },
          redirect: "error",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as { status?: unknown };
        if (
          typeof body.status !== "string" ||
          !runControlStatuses.has(body.status as RunControlStatus)
        ) {
          throw new Error("Invalid research control status");
        }
        this.lastControlStatus = body.status as RunControlStatus;
        return this.lastControlStatus;
      } catch {
        if (attempt < 2) await delay(250 * (attempt + 1));
      }
    }
    // Control is an authorization boundary, not optional telemetry. If its
    // state cannot be confirmed after bounded retries, stop the local run.
    this.failures += 1;
    this.lastControlStatus = "cancelled";
    return this.lastControlStatus;
  }

  private async waitForControl(options: {
    stoppingMeansStop: boolean;
  }): Promise<"continue" | "stop"> {
    while (true) {
      const status = await this.controlStatus();
      if (status === "paused") {
        await delay(this.controlPollMs);
        continue;
      }
      if (
        status === "cancelled" ||
        status === "failed" ||
        (options.stoppingMeansStop && status === "stopping")
      ) {
        return "stop";
      }
      return "continue";
    }
  }

  private taskId(companyId: string): string {
    const existing = this.taskIds.get(companyId);
    if (existing) return existing;
    const created = stableUuid(this.runId, companyId, "task");
    this.taskIds.set(companyId, created);
    return created;
  }

  private async appendEvent(input: {
    taskId?: string;
    eventType:
      | "run"
      | "company"
      | "robots"
      | "page"
      | "pdf"
      | "candidate"
      | "comparison"
      | "warning"
      | "error";
    message: string;
    sourceUrl?: string;
  }): Promise<void> {
    const sourceUrl = httpsSource(input.sourceUrl);
    await this.bestEffort({
      type: "event.append",
      event: {
        runId: this.runId,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        sequence: this.sequence,
        eventType: input.eventType,
        message: input.message,
        ...(sourceUrl ? { sourceUrl } : {}),
        createdAt: new Date().toISOString(),
      },
    });
    this.sequence += 1;
  }

  async start(options: StartOptions): Promise<void> {
    const startedAt = new Date().toISOString();
    await this.send({
      type: "run.upsert",
      run: {
        id: this.runId,
        name: options.name,
        source: options.source,
        status: "running",
        companyLimit: options.companies.length,
        configuration: options.configuration,
        startedAt,
      },
    });
    for (const company of options.companies) {
      await this.send({
        type: "task.upsert",
        task: {
          id: this.taskId(company.id),
          runId: this.runId,
          companyId: company.id,
          companyName: company.name,
          domain: company.domain,
          status: "waiting",
        },
      });
    }
    await this.appendEvent({
      eventType: "run",
      message:
        this.sequence > 0
          ? `Approved local worker started ${options.companies.length} queued companies.`
          : `Queued ${options.companies.length} companies for read-only research.`,
    });
  }

  async publish(
    event: EnrichmentProgressEvent,
  ): Promise<"continue" | "stop"> {
    const taskId = this.taskId(event.company.id);
    if (event.kind === "company_skipped") {
      await this.bestEffort({
        type: "task.upsert",
        task: {
          id: taskId,
          runId: this.runId,
          companyId: event.company.id,
          companyName: event.company.name,
          domain: event.company.domain,
          status: "skipped",
          completedAt: new Date().toISOString(),
        },
      });
      await this.appendEvent({
        taskId,
        eventType: "company",
        message: event.reason,
      });
      return "stop";
    }
    if (event.kind === "company_started") {
      const decision = await this.waitForControl({
        stoppingMeansStop: true,
      });
      if (decision === "stop") return decision;
      await this.bestEffort({
        type: "task.upsert",
        task: {
          id: taskId,
          runId: this.runId,
          companyId: event.company.id,
          companyName: event.company.name,
          domain: event.company.domain,
          status: "running",
          startedAt: new Date().toISOString(),
        },
      });
      await this.appendEvent({
        taskId,
        eventType: "company",
        message: `Started public-source research for ${event.company.name}.`,
        sourceUrl: event.company.websiteUrl,
      });
      return "continue";
    }

    if (event.kind === "crawl") {
      const decision = await this.waitForControl({
        stoppingMeansStop: false,
      });
      if (decision === "stop") return decision;
      if (event.crawl.kind === "page" || event.crawl.kind === "pdf") {
        this.pagesInspected += 1;
      }
      await this.appendEvent({
        taskId,
        eventType: event.crawl.kind,
        message: event.crawl.message,
        sourceUrl: event.crawl.sourceUrl,
      });
      return "continue";
    }

    await this.publishCompanyResult(
      event.result,
      event.heldMatches,
      event.crmComparisons,
    );
    return this.waitForControl({ stoppingMeansStop: true });
  }

  private async publishCompanyResult(
    result: EnrichedCompany,
    heldMatches: HeldCleanupMatch[],
    crmComparisons: SiteFinderDiscoveryComparison[],
  ): Promise<void> {
    const taskId = this.taskId(result.company.id);
    this.companiesChecked += 1;
    this.peopleFound += result.contacts.length;
    const currentUrl = httpsSource(result.pagesVisited.at(-1));
    await this.bestEffort({
      type: "task.upsert",
      task: {
        id: taskId,
        runId: this.runId,
        companyId: result.company.id,
        companyName: result.company.name,
        domain: result.company.domain,
        status:
          result.crawlStatus === "failed" ||
          result.crawlStatus === "blocked"
            ? "failed"
            : result.crawlStatus === "cancelled" ||
                result.crawlStatus === "skipped"
              ? "skipped"
              : result.contacts.length > 0
                ? "review"
                : "completed",
        progress: result.pagesVisited.length,
        pageCount: result.pagesVisited.length,
        contactsFound: result.contacts.length,
        ...(currentUrl ? { currentUrl } : {}),
        ...(result.contacts[0]?.jobTitle
          ? { currentRole: result.contacts[0].jobTitle }
          : {}),
        completedAt: result.completedAt,
      },
    });

    const comparisonByCandidate = new Map(
      crmComparisons.map((comparison) => [
        comparison.candidateId,
        comparison.status,
      ]),
    );
    for (const contact of result.contacts) {
      const evidence = candidateEvidence(result, contact);
      const licensedProfileUrl =
        evidence?.sourceKind === "apollo"
          ? contact.profileUrls
              .map((value) => httpsSource(value))
              .find((value) => value !== undefined)
          : undefined;
      const sourceUrl =
        licensedProfileUrl ??
        httpsSource(evidence?.sourceUrl) ??
        httpsSource(result.company.websiteUrl);
      if (!sourceUrl) {
        await this.appendEvent({
          taskId,
          eventType: "warning",
          message: "A candidate was retained locally because its evidence URL was not HTTPS.",
        });
        continue;
      }
      await this.bestEffort({
        type: "candidate.upsert",
        candidate: {
          id: stableUuid(this.runId, contact.id, "candidate"),
          runId: this.runId,
          taskId,
          externalCandidateId: contact.id,
          companyId: result.company.id,
          name: contact.name,
          jobTitle: contact.jobTitle,
          roleCategory: contact.roleCategory,
          sourceKind: evidence?.sourceKind ?? "company_website",
          sourceUrl,
          ...(evidence?.sourceKind === "apollo"
            ? {
                evidenceExcerpt:
                  "Apollo licensed-provider result. Open the linked profile for independent public verification.",
              }
            : {}),
          crmComparison:
            comparisonByCandidate.get(contact.id) ??
            "conflicting_multiple_matches",
          emailStatus: contact.emails.some(
            (point) => point.status === "public",
          )
            ? "public_email_found"
            : contact.emails.some(
                  (point) => point.status === "licensed_provider",
                )
              ? "licensed_business_email_found"
              : "not_publicly_found",
          confidence: contact.confidence,
        },
      });
      await this.appendEvent({
        taskId,
        eventType: "candidate",
        message: `Saved ${contact.jobTitle} candidate evidence for review.`,
        sourceUrl,
      });
    }

    for (const warning of result.warnings.slice(0, 5)) {
      await this.appendEvent({
        taskId,
        eventType: "warning",
        message: warning.slice(0, 1_000),
      });
    }
    if (heldMatches.length > 0) {
      await this.appendEvent({
        taskId,
        eventType: "comparison",
        message:
          `Cleanup policy held ${heldMatches.length} discovered identity or contact-point match${
            heldMatches.length === 1 ? "" : "es"
          }; none were saved as ordinary candidates.`,
      });
    }
    await this.bestEffort({
      type: "run.status",
      run: {
        id: this.runId,
        status: "running",
        companiesChecked: this.companiesChecked,
        pagesInspected: this.pagesInspected,
        peopleFound: this.peopleFound,
      },
    });
  }

  async complete(run: EnrichmentRun): Promise<void> {
    const controlStatus = await this.controlStatus();
    const stopped =
      controlStatus === "stopping" ||
      controlStatus === "cancelled" ||
      run.status === "cancelled";
    await this.send({
      type: "run.status",
      run: {
        id: this.runId,
        status:
          run.status === "failed"
            ? "failed"
            : stopped
              ? "cancelled"
              : "completed",
        companiesChecked: this.companiesChecked,
        pagesInspected: this.pagesInspected,
        peopleFound: this.peopleFound,
        completedAt: run.completedAt,
      },
    });
  }

  async fail(error: unknown): Promise<void> {
    void error;
    await this.bestEffort({
      type: "run.status",
      run: {
        id: this.runId,
        status: "failed",
        companiesChecked: this.companiesChecked,
        pagesInspected: this.pagesInspected,
        peopleFound: this.peopleFound,
        failureMessage:
          "Research worker stopped. Review the private local run output for details.",
        completedAt: new Date().toISOString(),
      },
    });
  }
}
