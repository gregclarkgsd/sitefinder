import assert from "node:assert/strict";
import test from "node:test";
import {
  SiteFinderProgressPublisher,
  SiteFinderQueueClient,
} from "../src/observability/sitefinder-progress.js";
import type { CompanySeed, EnrichedCompany } from "../src/types.js";

const publicLookup = (async () => [
  { address: "203.0.113.10", family: 4 as const },
]) as never;

const company: CompanySeed = {
  id: "company-1",
  name: "Example Construction",
  domain: "example.com",
  websiteUrl: "https://example.com/",
  source: "attio",
};

function fakeResult(): EnrichedCompany {
  return {
    company,
    facts: {},
    contacts: [
      {
        id: "contact-1",
        companyId: company.id,
        name: "Example Person",
        normalizedName: "example person",
        jobTitle: "Commercial Manager",
        roleCategory: "commercial",
        rolePriority: 90,
        employmentStatus: "current",
        emails: [
          {
            value: "person@example.com",
            status: "licensed_provider",
          },
        ],
        phones: [],
        profileUrls: ["https://www.linkedin.com/in/example-person"],
        evidenceIds: ["evidence-1"],
        confidence: 0.9,
      },
    ],
    projects: [],
    website: {
      offices: [],
      sectors: [],
      projectNames: [],
      hiringRoles: [],
      genericEmails: [],
      genericPhones: [],
      socialUrls: [],
    },
    evidence: [
      {
        id: "evidence-1",
        companyId: company.id,
        sourceKind: "apollo",
        sourceUrl: "https://app.apollo.io/#/people/apollo-person-1",
        capturedAt: "2026-07-28T09:00:00.000Z",
        field: "person",
        value: "Example Person",
        excerpt:
          "Example Person, Commercial Manager, person@example.com, 07123 456789",
        confidence: 0.9,
      },
    ],
    pagesVisited: ["https://example.com/", "https://example.com/team"],
    pagesSkipped: [],
    warnings: [],
    completedAt: "2026-07-28T09:05:00.000Z",
  };
}

test("publishes bounded progress without placing the credential in JSON", async () => {
  const messages: unknown[] = [];
  const authHeaders: string[] = [];
  const publisher = new SiteFinderProgressPublisher({
    endpoint: "https://sitefinder.example/api/research/ingest",
    token: "private-test-token",
    lookup: publicLookup,
    fetchImpl: async (_input, init) => {
      if (init?.method === "GET") {
        return new Response(JSON.stringify({ status: "running" }), {
          status: 200,
        });
      }
      messages.push(JSON.parse(String(init?.body)));
      authHeaders.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    },
  });

  await publisher.start({
    name: "Daily research",
    source: "attio",
    companies: [company],
    configuration: { maxPages: 12 },
  });
  await publisher.publish({ kind: "company_started", company });
  await publisher.publish({
    kind: "crawl",
    company,
    crawl: {
      kind: "page",
      message: "Opening an approved public company page.",
      sourceUrl: "https://example.com/team",
    },
  });
  await publisher.publish({
    kind: "company_completed",
    company,
    result: fakeResult(),
    heldMatches: [],
    crmComparisons: [
      {
        candidateId: "contact-1",
        status: "missing_from_both",
      },
    ],
  });

  const serialized = JSON.stringify(messages);
  assert.equal(serialized.includes("private-test-token"), false);
  assert.equal(serialized.includes("person@example.com"), false);
  assert.equal(serialized.includes("07123 456789"), false);
  assert.equal(serialized.includes("licensed_business_email_found"), true);
  assert.equal(
    serialized.includes("https://www.linkedin.com/in/example-person"),
    true,
  );
  assert.equal(serialized.includes("missing_from_both"), true);
  assert.equal(serialized.includes("not_checked"), false);
  assert.ok(authHeaders.every(value => value === "Bearer private-test-token"));
  assert.ok(messages.some(message => (message as { type?: string }).type === "candidate.upsert"));
  assert.ok(messages.some(message => (message as { type?: string }).type === "event.append"));
});

test("claims and validates the next reviewed SiteFinder queue run", async () => {
  let requestedUrl = "";
  let requestedBody = "";
  const queue = new SiteFinderQueueClient({
    endpoint: "https://sitefinder.example/api/research/ingest",
    token: "private-test-token",
    lookup: publicLookup,
    fetchImpl: async (input, init) => {
      requestedUrl = String(input);
      requestedBody = String(init?.body);
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer private-test-token",
      );
      return new Response(
        JSON.stringify({
          claimed: true,
          run: {
            id: "1ad1603c-5a3f-4bf5-8e23-8b18d1414287",
            name: "Reviewed queue run",
            requestedSources: ["website", "apollo"],
            apolloMaxPeople: 10,
            procurementDays: 30,
            companies: [
              {
                companyId: "company-1",
                companyName: "Example Construction",
                domain: "example.com",
              },
            ],
          },
        }),
        { status: 200 },
      );
    },
  });

  const run = await queue.claim("worker-1");
  assert.equal(
    requestedUrl,
    "https://sitefinder.example/api/research/worker/claim",
  );
  assert.deepEqual(JSON.parse(requestedBody), { workerId: "worker-1" });
  assert.equal(run?.companies[0]?.companyId, "company-1");
});

test("returns no work for an empty queue and rejects malformed claims", async () => {
  let malformed = false;
  const queue = new SiteFinderQueueClient({
    endpoint: "https://sitefinder.example/api/research/ingest",
    token: "private-test-token",
    lookup: publicLookup,
    fetchImpl: async () =>
      new Response(
        JSON.stringify(
          malformed
            ? { claimed: true, run: { id: "not-a-uuid" } }
            : { claimed: false },
        ),
        { status: 200 },
      ),
  });

  assert.equal(await queue.claim("worker-1"), undefined);
  malformed = true;
  await assert.rejects(queue.claim("worker-1"));
});

test("continues a queued run with its original ID and event sequence", async () => {
  const messages: Array<{
    type?: string;
    run?: { id?: string };
    event?: { runId?: string; sequence?: number; message?: string };
  }> = [];
  const runId = "1ad1603c-5a3f-4bf5-8e23-8b18d1414287";
  const publisher = new SiteFinderProgressPublisher({
    endpoint: "https://sitefinder.example/api/research/ingest",
    token: "private-test-token",
    runId,
    initialSequence: 1,
    lookup: publicLookup,
    fetchImpl: async (_input, init) => {
      messages.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    },
  });

  await publisher.start({
    name: "Reviewed queue run",
    source: "file",
    companies: [company],
    configuration: {},
  });

  assert.equal(messages[0]?.run?.id, runId);
  assert.equal(messages.at(-1)?.event?.runId, runId);
  assert.equal(messages.at(-1)?.event?.sequence, 1);
  assert.match(
    messages.at(-1)?.event?.message ?? "",
    /started 1 queued companies/u,
  );
});

test("publishes a policy comparison event without creating a held candidate", async () => {
  const messages: Array<{
    type?: string;
    event?: { eventType?: string; message?: string };
  }> = [];
  const publisher = new SiteFinderProgressPublisher({
    endpoint: "https://sitefinder.example/api/research/ingest",
    token: "private-test-token",
    lookup: publicLookup,
    fetchImpl: async (_input, init) => {
      if (init?.method === "GET") {
        return new Response(JSON.stringify({ status: "running" }), {
          status: 200,
        });
      }
      messages.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    },
  });
  const heldResult = fakeResult();
  heldResult.contacts = [];

  await publisher.start({
    name: "Cleanup-policy test",
    source: "attio",
    companies: [company],
    configuration: {},
  });
  await publisher.publish({
    kind: "company_completed",
    company,
    result: heldResult,
    heldMatches: [
      {
        id: "held-1",
        companyId: company.id,
        contactId: "contact-1",
        kind: "contact",
        disposition: "suppressed_match",
        name: "Example Person",
        jobTitle: "Commercial Manager",
        email: "person@example.com",
        directives: ["do_not_reimport"],
        matchedDecisionIds: ["decision-1"],
        evidenceIds: ["evidence-1"],
      },
    ],
    crmComparisons: [],
  });

  assert.equal(messages.some(message => message.type === "candidate.upsert"), false);
  assert.ok(
    messages.some(
      (message) =>
        message.type === "event.append" &&
        message.event?.eventType === "comparison" &&
        message.event.message?.includes("none were saved as ordinary candidates"),
    ),
  );
  assert.equal(JSON.stringify(messages).includes("person@example.com"), false);
});

test("waits while paused and stops before starting another company", async () => {
  const messages: Array<{ type?: string; task?: { status?: string } }> = [];
  const controlStatuses = ["paused", "running", "stopping"];
  const publisher = new SiteFinderProgressPublisher({
    endpoint: "https://sitefinder.example/api/research/ingest",
    token: "private-test-token",
    lookup: publicLookup,
    controlPollMs: 1,
    fetchImpl: async (_input, init) => {
      if (init?.method === "GET") {
        return new Response(
          JSON.stringify({
            status: controlStatuses.shift() ?? "stopping",
          }),
          { status: 200 },
        );
      }
      messages.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    },
  });

  await publisher.start({
    name: "Controlled research",
    source: "attio",
    companies: [company],
    configuration: {},
  });
  assert.equal(
    await publisher.publish({ kind: "company_started", company }),
    "continue",
  );
  assert.equal(
    await publisher.publish({ kind: "company_started", company }),
    "stop",
  );
  await publisher.publish({
    kind: "company_skipped",
    company,
    reason: "Skipped after the operator requested a safe stop.",
  });
  assert.ok(
    messages.some(
      (message) =>
        message.type === "task.upsert" && message.task?.status === "skipped",
    ),
  );
});

test("fails closed when the control channel cannot be verified", async () => {
  const messages: Array<{ type?: string; task?: { status?: string } }> = [];
  let controlAttempts = 0;
  const publisher = new SiteFinderProgressPublisher({
    endpoint: "https://sitefinder.example/api/research/ingest",
    token: "private-test-token",
    lookup: publicLookup,
    controlPollMs: 1,
    fetchImpl: async (_input, init) => {
      if (init?.method === "GET") {
        controlAttempts += 1;
        throw new Error("control unavailable");
      }
      messages.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    },
  });

  await publisher.start({
    name: "Fail-closed control",
    source: "attio",
    companies: [company],
    configuration: {},
  });
  assert.equal(
    await publisher.publish({ kind: "company_started", company }),
    "stop",
  );
  assert.equal(controlAttempts, 3);
  assert.equal(publisher.failureCount, 1);
  assert.equal(
    messages.some(
      (message) =>
        message.type === "task.upsert" && message.task?.status === "running",
    ),
    false,
  );
});

test("removes URL secrets and private failure details from shared progress", async () => {
  const messages: Array<{
    type?: string;
    event?: { sourceUrl?: string };
    run?: { failureMessage?: string };
  }> = [];
  const publisher = new SiteFinderProgressPublisher({
    endpoint: "https://sitefinder.example/api/research/ingest",
    token: "private-test-token",
    lookup: publicLookup,
    fetchImpl: async (_input, init) => {
      if (init?.method === "GET") {
        return new Response(JSON.stringify({ status: "running" }), {
          status: 200,
        });
      }
      messages.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    },
  });

  await publisher.start({
    name: "Redaction test",
    source: "attio",
    companies: [company],
    configuration: {},
  });
  await publisher.publish({
    kind: "crawl",
    company,
    crawl: {
      kind: "page",
      message: "Inspected public page.",
      sourceUrl:
        "https://example.com/team?signature=top-secret#private-fragment",
    },
  });
  await publisher.fail(
    new Error(
      "Could not read /Users/example/private-data/cleanup-decisions.jsonl",
    ),
  );

  const serialized = JSON.stringify(messages);
  assert.equal(serialized.includes("top-secret"), false);
  assert.equal(serialized.includes("private-fragment"), false);
  assert.equal(serialized.includes("/Users/example/private-data"), false);
  assert.ok(
    messages.some(
      (message) =>
        message.event?.sourceUrl === "https://example.com/team",
    ),
  );
  assert.ok(
    messages.some(
      (message) =>
        message.run?.failureMessage ===
        "Research worker stopped. Review the private local run output for details.",
    ),
  );
});

test("rejects cleartext non-local ingestion endpoints", () => {
  assert.throws(
    () =>
      new SiteFinderProgressPublisher({
        endpoint: "http://sitefinder.example/api/research/ingest",
        token: "private-test-token",
      }),
    /must use HTTPS/u,
  );
});

test("rejects redirects and non-ingestion endpoint paths", async () => {
  assert.throws(
    () =>
      new SiteFinderProgressPublisher({
        endpoint: "https://sitefinder.example/api/other",
        token: "private-test-token",
      }),
    /exact SiteFinder ingestion path/u,
  );

  const publisher = new SiteFinderProgressPublisher({
    endpoint: "https://sitefinder.example/api/research/ingest",
    token: "private-test-token",
    lookup: publicLookup,
    fetchImpl: async (_input, init) => {
      assert.equal(init?.redirect, "error");
      return new Response(null, {
        status: 302,
        headers: {location: "https://example.com/collect"},
      });
    },
  });
  await assert.rejects(
    publisher.start({
      name: "Redirect test",
      source: "attio",
      companies: [company],
      configuration: {},
    }),
    /endpoint returned HTTP 302/u,
  );
});

test("rejects a SiteFinder hostname resolving to a private address before sending", async () => {
  let requestSent = false;
  const privateLookup = (async () => [
    { address: "10.0.0.5", family: 4 as const },
  ]) as never;
  const publisher = new SiteFinderProgressPublisher({
    endpoint: "https://sitefinder.example/api/research/ingest",
    token: "private-test-token",
    lookup: privateLookup,
    fetchImpl: async () => {
      requestSent = true;
      return new Response(JSON.stringify({ accepted: true }), { status: 202 });
    },
  });

  await assert.rejects(
    publisher.start({
      name: "Private host test",
      source: "attio",
      companies: [company],
      configuration: {},
    }),
    /private IP/u,
  );
  assert.equal(requestSent, false);
});
