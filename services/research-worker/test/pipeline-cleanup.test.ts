import assert from "node:assert/strict";
import test from "node:test";
import { enrichCompanies } from "../src/pipeline/enrich.js";
import {
  cleanupDecisionSchema,
} from "../src/policy/cleanup-policy.js";

const publicLookup = (async () => [
  { address: "203.0.113.10", family: 4 as const },
]) as never;

test("the core enrichment pipeline rejects an empty cleanup context", async () => {
  await assert.rejects(
    enrichCompanies([], {
      crawl: {
        maxPages: 1,
        maxPdfs: 0,
        delayMs: 0,
        timeoutMs: 1_000,
        userAgent: "GSD-Sales-Enrichment-Test/1.0",
      },
      cleanupDecisions: [],
      attioPeople: [],
      pipedrivePeople: [],
      concurrency: 1,
      procurementDays: 0,
    }),
    /requires a non-empty, verified cleanup decision ledger/u,
  );
});

test("the enrichment pipeline withholds a quarantined discovery before progress publication", async () => {
  const published: Array<{ kind: string; contacts?: number; held?: number }> = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input
          : input.url,
    );
    if (url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nAllow: /", { status: 200 });
    }
    if (url.pathname === "/sitemap.xml") {
      return new Response("Not found", { status: 404 });
    }
    return new Response(
      `<article class="team-member">
        <h2>Example Person</h2>
        <p class="role">Commercial Manager</p>
        <a href="mailto:person@example.test">Email</a>
      </article>`,
      { status: 200, headers: { "content-type": "text/html" } },
    );
  }) as typeof fetch;
  const cleanupDecision = cleanupDecisionSchema.parse({
    schemaVersion: 1,
    decisionId: "quarantine-1",
    status: "quarantined",
    classification: "unresolved",
    directive: "hold",
    subject: { kind: "email", email: "person@example.test" },
    reason: "Awaiting a human cleanup decision",
    reviewedBy: "reviewer@example.invalid",
    decidedAt: "2026-07-29T09:00:00.000Z",
  });

  const run = await enrichCompanies(
    [
      {
        id: "company-1",
        name: "Example Build",
        domain: "example.test",
        websiteUrl: "https://example.test/",
        source: "file",
      },
    ],
    {
      crawl: {
        maxPages: 1,
        maxPdfs: 0,
        delayMs: 0,
        timeoutMs: 1_000,
        userAgent: "GSD-Sales-Enrichment-Test/1.0",
        fetchImpl,
        lookup: publicLookup,
      },
      cleanupDecisions: [cleanupDecision],
      attioPeople: [],
      pipedrivePeople: [],
      concurrency: 1,
      procurementDays: 0,
      onProgress: async (event) => {
        published.push({
          kind: event.kind,
          ...(event.kind === "company_completed"
            ? {
                contacts: event.result.contacts.length,
                held: event.heldMatches.length,
              }
            : {}),
        });
      },
    },
  );

  assert.equal(run.contactCount, 0);
  assert.equal(run.heldMatchCount, 1);
  assert.equal(run.status, "completed");
  assert.equal(run.completedCompanyCount, 1);
  assert.equal(run.failedCompanyCount, 0);
  assert.equal(run.companies[0]?.contacts.length, 0);
  assert.ok(
    published.some(
      (event) =>
        event.kind === "company_completed" &&
        event.contacts === 0 &&
        event.held === 1,
    ),
  );
});

test("the run reports failure rather than completion when every company crawl fails", async () => {
  const cleanupDecision = cleanupDecisionSchema.parse({
    schemaVersion: 1,
    decisionId: "unrelated-invalid-address",
    status: "approved",
    classification: "invalid_address",
    directive: "invalid_address",
    subject: { kind: "email", email: "old@example.test" },
    reason: "Reviewed hard bounce from the cleanup ledger",
    reviewedBy: "reviewer@example.invalid",
    decidedAt: "2026-07-29T09:00:00.000Z",
  });
  const run = await enrichCompanies(
    [
      {
        id: "company-failure",
        name: "Failure Build",
        domain: "example.test",
        websiteUrl: "https://different-domain.test/",
        source: "file",
      },
    ],
    {
      crawl: {
        maxPages: 1,
        maxPdfs: 0,
        delayMs: 0,
        timeoutMs: 1_000,
        userAgent: "GSD-Sales-Enrichment-Test/1.0",
      },
      cleanupDecisions: [cleanupDecision],
      attioPeople: [],
      pipedrivePeople: [],
      concurrency: 1,
      procurementDays: 0,
    },
  );

  assert.equal(run.status, "failed");
  assert.equal(run.companyCount, 1);
  assert.equal(run.completedCompanyCount, 0);
  assert.equal(run.failedCompanyCount, 1);
});
