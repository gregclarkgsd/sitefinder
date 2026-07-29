import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { ImmutableInput } from "../src/io/immutable-input.js";
import { selectReviewedPilotCompanies } from "../src/policy/reviewed-pilot-manifest.js";
import type { CompanySeed } from "../src/types.js";

function input(path: string, value: unknown): ImmutableInput {
  const bytes = Buffer.from(JSON.stringify(value));
  return {
    path,
    bytes,
    text: bytes.toString("utf8"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
  };
}

const companies: CompanySeed[] = [
  {
    id: "company-b",
    name: "B Build",
    domain: "b-build.test",
    websiteUrl: "https://b-build.test/",
    source: "file",
  },
  {
    id: "company-a",
    name: "A Build",
    domain: "a-build.test",
    websiteUrl: "https://a-build.test/",
    source: "file",
  },
];

test("uses the explicit reviewed order instead of an alphabetical slice", () => {
  const companyInput = input("companies.json", companies);
  const manifestInput = input("pilot.json", {
    schemaVersion: 1,
    kind: "reviewed_company_pilot",
    companyInputSha256: companyInput.sha256,
    attioPeopleSha256: "1".repeat(64),
    pipedrivePeopleSha256: "2".repeat(64),
    companyIds: ["company-a", "company-b"],
    purpose: "Reviewed safety pilot",
    reviewedBy: "reviewer@example.invalid",
    reviewedAt: "2026-07-29T12:00:00.000Z",
  });
  const selected = selectReviewedPilotCompanies(
    companies,
    companyInput,
    manifestInput,
  );
  assert.deepEqual(
    selected.companies.map((company) => company.id),
    ["company-a", "company-b"],
  );
});

test("rejects stale, duplicate, or missing reviewed pilot identities", () => {
  const companyInput = input("companies.json", companies);
  const base = {
    schemaVersion: 1,
    kind: "reviewed_company_pilot",
    companyInputSha256: companyInput.sha256,
    attioPeopleSha256: "1".repeat(64),
    pipedrivePeopleSha256: "2".repeat(64),
    companyIds: ["company-a"],
    purpose: "Reviewed safety pilot",
    reviewedBy: "reviewer@example.invalid",
    reviewedAt: "2026-07-29T12:00:00.000Z",
  };
  assert.throws(
    () =>
      selectReviewedPilotCompanies(
        companies,
        companyInput,
        input("pilot.json", {
          ...base,
          companyInputSha256: "0".repeat(64),
        }),
      ),
    /does not match/u,
  );
  assert.throws(
    () =>
      selectReviewedPilotCompanies(
        companies,
        companyInput,
        input("pilot.json", {
          ...base,
          companyIds: ["company-a", "company-a"],
        }),
      ),
    /must be unique/u,
  );
  assert.throws(
    () =>
      selectReviewedPilotCompanies(
        companies,
        companyInput,
        input("pilot.json", {
          ...base,
          companyIds: ["missing-company"],
        }),
      ),
    /is missing from the input/u,
  );
});
