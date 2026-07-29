import assert from "node:assert/strict";
import test from "node:test";
import {
  compileCompanyUniverse,
  identityResolutionManifestSchema,
  type IdentityResolutionManifest,
} from "../src/universe/index.js";
import { createCompanyResearchPlan } from "../src/universe/company-universe-io.js";

function manifest(
  resolutions: IdentityResolutionManifest["resolutions"],
): IdentityResolutionManifest {
  return identityResolutionManifestSchema.parse({
    schemaVersion: 1,
    kind: "sitefinder_crm_identity_resolutions",
    status: "approved",
    reviewedBy: "reviewer@example.invalid",
    reviewedAt: "2026-07-29T10:00:00.000Z",
    reason: "Reviewed against the cleaned CRM company snapshots.",
    resolutions,
  });
}

test("merges SiteFinder and CRM identities only through an exact approved mapping", () => {
  const result = compileCompanyUniverse(
    {
      attio: [
        {
          sourceId: "attio-company-1",
          name: "Example Build Limited",
          domain: "example-build.test",
        },
      ],
      sitefinderContractors: [
        {
          sourceId: "contractor-101",
          name: "Example Build",
        },
        {
          sourceId: "contractor-unmapped",
          name: "Other Build",
        },
      ],
    },
    manifest([
      {
        resolutionKey: "sf-101-to-attio-1",
        sitefinder: {
          source: "sitefinder_contractor",
          sourceId: "contractor-101",
        },
        crm: { source: "attio", sourceId: "attio-company-1" },
        reason: "Official website and legal identity were manually checked.",
      },
    ]),
  );

  assert.equal(result.companies.length, 2);
  const linked = result.companies.find((company) =>
    company.sourceIds.attio.includes("attio-company-1"),
  );
  assert.deepEqual(linked?.sourceIds.sitefinder_contractor, [
    "contractor-101",
  ]);
  assert.deepEqual(linked?.approvedIdentityResolutionKeys, [
    "sf-101-to-attio-1",
  ]);
  assert.equal(result.summary.identityMappings, 1);
  assert.equal(result.summary.mappedSiteFinderIdentities, 1);
  assert.equal(result.summary.unmappedSiteFinderIdentities, 1);
  assert.equal(createCompanyResearchPlan(result).companies.length, 1);
});

test("never converts a name-only match into an identity mapping", () => {
  const result = compileCompanyUniverse({
    pipedrive: [
      {
        sourceId: "crm-1",
        name: "Same Name Limited",
        domain: "same-name.test",
      },
    ],
    sitefinderClients: [
      {
        sourceId: "client-1",
        name: "Same Name Ltd",
      },
    ],
  });

  assert.equal(result.companies.length, 2);
  assert.equal(result.summary.identityMappings, 0);
  assert.equal(result.summary.unmappedSiteFinderIdentities, 1);
  assert.ok(
    result.reviewQueue.some((item) => item.kind === "name_only_match"),
  );
});

test("rejects duplicate keys and multiple CRM mappings for one SiteFinder identity", () => {
  const base = {
    schemaVersion: 1,
    kind: "sitefinder_crm_identity_resolutions",
    status: "approved",
    reviewedBy: "reviewer@example.invalid",
    reviewedAt: "2026-07-29T10:00:00.000Z",
    reason: "Reviewed against source snapshots.",
  } as const;
  const resolution = {
    resolutionKey: "duplicate-key",
    sitefinder: {
      source: "sitefinder_client",
      sourceId: "client-1",
    },
    crm: { source: "attio", sourceId: "attio-1" },
    reason: "The company number was checked.",
  } as const;

  assert.equal(
    identityResolutionManifestSchema.safeParse({
      ...base,
      resolutions: [
        resolution,
        {
          ...resolution,
          crm: { source: "pipedrive", sourceId: "pipedrive-2" },
        },
      ],
    }).success,
    false,
  );
});

test("rejects identity resolutions whose exact source records are absent", () => {
  const approved = manifest([
    {
      resolutionKey: "missing-crm",
      sitefinder: {
        source: "sitefinder_client",
        sourceId: "client-1",
      },
      crm: { source: "attio", sourceId: "absent-attio-record" },
      reason: "The CRM record was selected during review.",
    },
  ]);

  assert.throws(
    () =>
      compileCompanyUniverse(
        {
          sitefinderClients: [
            { sourceId: "client-1", name: "Example Client" },
          ],
        },
        approved,
      ),
    /references missing CRM record attio:absent-attio-record/u,
  );
});

test("keeps contradictory approved mappings blocked for review", () => {
  const result = compileCompanyUniverse(
    {
      attio: [
        {
          sourceId: "attio-contradiction",
          name: "CRM Company Limited",
          domain: "crm-company.test",
          companyNumber: "00000001",
        },
      ],
      sitefinderClients: [
        {
          sourceId: "client-contradiction",
          name: "SiteFinder Company Limited",
          domain: "sitefinder-company.test",
          companyNumber: "00000002",
        },
      ],
    },
    manifest([
      {
        resolutionKey: "contradictory-review",
        sitefinder: {
          source: "sitefinder_client",
          sourceId: "client-contradiction",
        },
        crm: { source: "attio", sourceId: "attio-contradiction" },
        reason: "Reviewer requested a second check of contradictory evidence.",
      },
    ]),
  );

  assert.equal(result.companies.length, 1);
  assert.equal(result.summary.identityResolutionConflicts, 1);
  assert.ok(
    result.reviewQueue.some(
      (item) => item.kind === "reviewed_identity_conflict",
    ),
  );
  assert.equal(createCompanyResearchPlan(result).companies.length, 0);
});

test("requires approval reviewer, time and reasons", () => {
  const invalid = identityResolutionManifestSchema.safeParse({
    schemaVersion: 1,
    kind: "sitefinder_crm_identity_resolutions",
    status: "approved",
    reviewedBy: "",
    reviewedAt: "not-a-time",
    reason: "",
    resolutions: [
      {
        resolutionKey: "missing-reason",
        sitefinder: {
          source: "sitefinder_client",
          sourceId: "client-1",
        },
        crm: { source: "attio", sourceId: "attio-1" },
        reason: "",
      },
    ],
  });
  assert.equal(invalid.success, false);
});
