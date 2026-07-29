import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createCompanyResearchPlan,
  loadCompanyUniverseRows,
  loadSiteFinderCompanyRows,
} from "../src/universe/company-universe-io.js";
import { partitionCompaniesByCleanupPolicy } from "../src/policy/apply-cleanup-policy.js";
import { cleanupDecisionSchema } from "../src/policy/cleanup-policy.js";
import { compileCompanyUniverse } from "../src/universe/index.js";

async function fixtureDirectory(
  t: { after: (fn: () => Promise<void>) => void },
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "company-universe-io-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test("loads worker company snapshots while retaining their source IDs", async (t) => {
  const directory = await fixtureDirectory(t);
  const path = join(directory, "companies.json");
  await writeFile(
    path,
    JSON.stringify([
      {
        id: "attio:record-1",
        sourceRecordId: "record-1",
        name: "Example Build Ltd",
        domain: "example-build.test",
        websiteUrl: "https://example-build.test/",
        source: "attio",
      },
    ]),
  );

  assert.deepEqual(await loadCompanyUniverseRows(path), [
    {
      sourceId: "record-1",
      name: "Example Build Ltd",
      domain: "example-build.test",
      websiteUrl: "https://example-build.test/",
    },
  ]);
});

test("extracts stable contractor and client identities from SiteFinder projects", async (t) => {
  const directory = await fixtureDirectory(t);
  const path = join(directory, "sitefinder.json");
  await writeFile(
    path,
    JSON.stringify([
      {
        MainContractorId: 101,
        MainContractor: "Example Contractor",
        ClientId: "202",
        Client: "Example Client",
      },
      {
        source_data: {
          MainContractorId: "101",
          MainContractor: "Example Contractor",
          ClientId: "202",
          Client: "Example Client",
        },
      },
    ]),
  );

  const rows = await loadSiteFinderCompanyRows(path);
  assert.equal(rows.contractors.length, 1);
  assert.deepEqual(rows.contractors[0], {
    sourceId: "101",
    name: "Example Contractor",
  });
  assert.equal(rows.clients.length, 1);
  assert.deepEqual(rows.clients[0], {
    sourceId: "202",
    name: "Example Client",
  });
});

test("retains conflicting SiteFinder names for the same ID so they reach review", async (t) => {
  const directory = await fixtureDirectory(t);
  const path = join(directory, "sitefinder-conflict.json");
  await writeFile(
    path,
    JSON.stringify([
      { MainContractorId: "101", MainContractor: "Example Contractor" },
      { MainContractorId: "101", MainContractor: "Renamed Contractor" },
      { MainContractorId: "101", MainContractor: "Example Contractor" },
    ]),
  );

  const rows = await loadSiteFinderCompanyRows(path);
  assert.deepEqual(rows.contractors, [
    { sourceId: "101", name: "Example Contractor" },
    { sourceId: "101", name: "Renamed Contractor" },
  ]);
  const universe = compileCompanyUniverse({
    sitefinderContractors: rows.contractors,
  });
  assert.ok(
    universe.reviewQueue.some((item) => item.kind === "duplicate_source_id"),
  );
  assert.ok(
    universe.reviewQueue.some((item) => item.kind === "merged_name_conflict"),
  );
});

test("produces research seeds only for unambiguous companies with one domain", () => {
  const result = compileCompanyUniverse({
    attio: [
      {
        sourceId: "safe",
        name: "Safe Build Ltd",
        domain: "safe-build.test",
      },
      {
        sourceId: "conflict",
        name: "Conflicted Build Ltd",
        domain: "conflict-one.test",
        websiteUrl: "https://conflict-two.test/",
      },
    ],
    sitefinderContractors: [
      {
        sourceId: "domainless",
        name: "Needs Domain Ltd",
      },
    ],
  });

  const plan = createCompanyResearchPlan(result);
  assert.deepEqual(
    plan.companies.map((company) => company.name),
    ["Safe Build Ltd"],
  );
  assert.equal(plan.blockedCompanyIds.length, 2);
});

test("holds public mailbox provider domains for review instead of crashing cleanup", () => {
  const result = compileCompanyUniverse({
    attio: [
      {
        sourceId: "public-mailbox-domain",
        name: "Needs Website Review",
        domain: "gmail.com",
        websiteUrl: "https://gmail.com/",
      },
      {
        sourceId: "business-domain",
        name: "Researchable Build Ltd",
        domain: "researchable-build.test",
      },
    ],
  });

  const plan = createCompanyResearchPlan(result);
  assert.deepEqual(
    plan.companies.map((company) => company.name),
    ["Researchable Build Ltd"],
  );
  assert.ok(
    result.reviewQueue.some(
      (item) =>
        item.kind === "domainless" &&
        item.sourceKeys.includes("attio:public-mailbox-domain"),
    ),
  );
});

test("research seeds preserve Attio IDs and enforce ID-only cleanup decisions", () => {
  const result = compileCompanyUniverse({
    attio: [
      {
        sourceId: "attio-record-primary",
        name: "Quarantined Build Ltd",
        domain: "quarantined-build.test",
      },
      {
        sourceId: "attio-record-secondary",
        name: "Quarantined Build Ltd",
        domain: "quarantined-build.test",
      },
    ],
    pipedrive: [
      {
        sourceId: "pipedrive-22",
        name: "Quarantined Build",
        domain: "quarantined-build.test",
      },
    ],
  });
  const plan = createCompanyResearchPlan(result);
  const company = plan.companies[0];
  assert.ok(company);
  assert.equal(company.source, "attio");
  assert.equal(company.sourceRecordId, "attio-record-primary");
  assert.deepEqual(company.sourceIds?.attio, [
    "attio-record-primary",
    "attio-record-secondary",
  ]);
  assert.deepEqual(company.sourceIds?.pipedrive, ["pipedrive-22"]);

  const cleanupDecision = cleanupDecisionSchema.parse({
    schemaVersion: 1,
    decisionId: "attio-company-hold",
    status: "quarantined",
    classification: "unresolved",
    directive: "hold",
    subject: {
      kind: "company",
      attioRecordId: "attio-record-secondary",
    },
    reason: "Awaiting cleanup review",
    reviewedBy: "reviewer@example.invalid",
    decidedAt: "2026-07-29T09:00:00.000Z",
  });
  const partitioned = partitionCompaniesByCleanupPolicy(
    plan.companies,
    [cleanupDecision],
  );
  assert.equal(partitioned.allowed.length, 0);
  assert.equal(partitioned.held[0]?.companyId, company.id);
  assert.deepEqual(partitioned.held[0]?.matchedDecisionIds, [
    "attio-company-hold",
  ]);
});
