import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { EnrichmentRun } from "../src/pipeline/enrich.js";
import {
  preparePrivateOutputDirectory,
  type PrivateOutputDirectory,
} from "../src/io/private-data-boundary.js";
import { writeEnrichmentRun } from "../src/io/run-output.js";

async function fixture(
  t: { after: (fn: () => Promise<void>) => void },
): Promise<PrivateOutputDirectory> {
  const createdRoot = await mkdtemp(join(tmpdir(), "run-output-"));
  const rootDirectory = await realpath(createdRoot);
  t.after(async () => rm(rootDirectory, { recursive: true, force: true }));
  const path = join(rootDirectory, "run");
  await mkdir(path, { mode: 0o700 });
  const output = {
    rootDirectory,
    path,
    relativePath: "run",
    workspaceDirectory: join(tmpdir(), "unrelated-workspace"),
  };
  await preparePrivateOutputDirectory(output);
  return output;
}

test("CRM conflicts are included in the private human-review output", async (t) => {
  const output = await fixture(t);
  const run: EnrichmentRun = {
    mode: "read_only",
    status: "completed",
    startedAt: "2026-07-29T09:00:00.000Z",
    completedAt: "2026-07-29T09:01:00.000Z",
    companyCount: 1,
    completedCompanyCount: 1,
    failedCompanyCount: 0,
    skippedCompanyCount: 0,
    cancelledCompanyCount: 0,
    contactCount: 1,
    evidenceCount: 1,
    projectSignalCount: 0,
    heldMatchCount: 0,
    heldMatches: [],
    heldCompanyCount: 0,
    heldCompanies: [],
    crmComparisonCounts: {
      already_in_attio: 0,
      pipedrive_only: 0,
      missing_from_both: 0,
      conflicting_multiple_matches: 1,
      unverifiable_no_email: 0,
    },
    crmComparisons: [{
      candidateId: "contact-1",
      status: "conflicting_multiple_matches",
      reason: "duplicate_crm_email_match",
      normalizedBusinessEmails: ["person@example.com"],
      emailMatches: [{
        email: "person@example.com",
        attioRecordIds: ["attio-1", "attio-2"],
        pipedrivePersonIds: [],
        attioSnapshotCount: 2,
        pipedriveSnapshotCount: 0,
      }],
    }],
    companies: [{
      company: {
        id: "company-1",
        name: "Example Construction Ltd",
        domain: "example.com",
        websiteUrl: "https://example.com",
        source: "file",
      },
      facts: {},
      contacts: [{
        id: "contact-1",
        companyId: "company-1",
        name: "Example Person",
        normalizedName: "example person",
        jobTitle: "Commercial Manager",
        roleCategory: "commercial",
        rolePriority: 1,
        employmentStatus: "current",
        emails: [{ value: "person@example.com", status: "public" }],
        phones: [],
        profileUrls: ["https://example.com/team"],
        evidenceIds: ["evidence-1"],
        confidence: 0.95,
      }],
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
      evidence: [{
        id: "evidence-1",
        companyId: "company-1",
        sourceKind: "company_website",
        sourceUrl: "https://example.com/team",
        capturedAt: "2026-07-29T09:00:30.000Z",
        field: "job_title",
        value: "Commercial Manager",
        confidence: 0.95,
      }],
      pagesVisited: ["https://example.com/team"],
      pagesSkipped: [],
      warnings: [],
      crawlStatus: "completed",
      completedAt: "2026-07-29T09:01:00.000Z",
    }],
  };

  await writeEnrichmentRun(output, run);

  const review = JSON.parse(
    await readFile(join(output.path, "review.json"), "utf8"),
  ) as Array<{
    crmComparison: string;
    crmComparisonReason: string;
    reasons: string[];
  }>;
  assert.equal(review.length, 1);
  assert.equal(review[0]?.crmComparison, "conflicting_multiple_matches");
  assert.equal(
    review[0]?.crmComparisonReason,
    "duplicate_crm_email_match",
  );
  assert.deepEqual(
    review[0]?.reasons,
    ["crm_conflict:duplicate_crm_email_match"],
  );
});
