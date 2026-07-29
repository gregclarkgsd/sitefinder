import assert from "node:assert/strict";
import test from "node:test";
import {
  compileCompanyUniverse,
  normalizeCompanyNumber,
  type CompanyUniverseInputs,
} from "../src/universe/index.js";

test("unites all sources using exact normalized domains and company numbers", () => {
  const result = compileCompanyUniverse({
    attio: [
      {
        sourceId: "attio-company-1",
        name: "Example Build Limited",
        domain: "https://www.example-build.test/contact",
        companyNumber: "0123 4567",
      },
    ],
    pipedrive: [
      {
        sourceId: "42",
        name: "Example Build Ltd",
        websiteUrl: "EXAMPLE-BUILD.TEST",
        companyNumber: "01234567",
      },
    ],
    file: [
      {
        sourceId: "row-7",
        name: "Example Build",
        companyNumber: "1234567",
      },
    ],
    sitefinderContractors: [
      {
        sourceId: "contractor-8",
        name: "Example Build Limited",
        domain: "www.example-build.test",
        companyNumber: "01234567",
      },
    ],
    sitefinderClients: [
      {
        sourceId: "client-9",
        name: "Example Build Ltd",
        companyNumber: "01234567",
      },
    ],
  });

  assert.equal(result.companies.length, 1);
  const company = result.companies[0];
  assert.ok(company);
  assert.equal(company.preferredName, "Example Build Limited");
  assert.deepEqual(company.domains, ["example-build.test"]);
  assert.deepEqual(company.companyNumbers, ["01234567"]);
  assert.deepEqual(company.sourceIds, {
    attio: ["attio-company-1"],
    pipedrive: ["42"],
    file: ["row-7"],
    sitefinder_contractor: ["contractor-8"],
    sitefinder_client: ["client-9"],
  });
  assert.equal(company.sourceRecords.length, 5);
  assert.equal(result.summary.mergedCompanies, 1);
  assert.equal(result.summary.domainlessRows, 2);
});

test("never merges on a company name alone and queues the collision for review", () => {
  const result = compileCompanyUniverse({
    attio: [
      {
        sourceId: "attio-a",
        name: "Common Construction Ltd",
        domain: "common-north.test",
      },
    ],
    pipedrive: [
      {
        sourceId: "pipedrive-b",
        name: "Common Construction Limited",
        domain: "common-south.test",
      },
    ],
    file: [
      {
        sourceId: "file-c",
        name: "Common Construction Ltd",
      },
    ],
  });

  assert.equal(result.companies.length, 3);
  const nameMatch = result.reviewQueue.find(
    (item) => item.kind === "name_only_match",
  );
  assert.ok(nameMatch);
  assert.equal(nameMatch.companyIds.length, 3);
  assert.equal(nameMatch.normalizedName, "common construction");
  assert.equal(result.summary.domainlessRows, 1);
});

test("does not merge a shared domain when known company numbers conflict", () => {
  const result = compileCompanyUniverse({
    attio: [
      {
        sourceId: "a",
        name: "Alpha Construction Ltd",
        domain: "alpha.test",
        companyNumber: "00000001",
      },
    ],
    pipedrive: [
      {
        sourceId: "b",
        name: "Unexpected Holdings Ltd",
        domain: "alpha.test",
        companyNumber: "00000002",
      },
    ],
    sitefinderClients: [
      {
        sourceId: "c",
        name: "Unexpected Holdings",
        domain: "unexpected.test",
        companyNumber: "00000002",
      },
    ],
  });

  assert.equal(result.companies.length, 2);
  const kinds = new Set(result.reviewQueue.map((item) => item.kind));
  assert.ok(kinds.has("shared_domain_identity_conflict"));
  // The names differ, so this is an identifier conflict rather than a
  // name-only possible match.
  assert.equal(kinds.has("name_only_match"), false);
  const unexpected = result.companies.find((company) =>
    company.companyNumbers.includes("00000002"),
  );
  assert.deepEqual(unexpected?.sourceIds, {
    attio: [],
    pipedrive: ["b"],
    file: [],
    sitefinder_contractor: [],
    sitefinder_client: ["c"],
  });
});

test("does not merge different legal forms sharing one group domain", () => {
  const result = compileCompanyUniverse({
    attio: [
      {
        sourceId: "company-ltd",
        name: "Acme Ltd",
        domain: "acme-group.test",
        companyNumber: "00000001",
      },
      {
        sourceId: "company-llp",
        name: "Acme LLP",
        domain: "acme-group.test",
      },
    ],
  });

  assert.equal(result.companies.length, 2);
  assert.ok(
    result.reviewQueue.some(
      (item) => item.kind === "shared_domain_legal_form_conflict",
    ),
  );
});

test("does not merge numbered and unnumbered records on domain alone", () => {
  const result = compileCompanyUniverse({
    attio: [
      {
        sourceId: "numbered",
        name: "Acme Ltd",
        domain: "acme.test",
        companyNumber: "00000001",
      },
      {
        sourceId: "unnumbered",
        name: "Acme Ltd",
        domain: "acme.test",
      },
    ],
  });

  assert.equal(result.companies.length, 2);
  assert.ok(
    result.reviewQueue.some(
      (item) => item.kind === "shared_domain_partial_company_number",
    ),
  );
});

test("rejects arbitrary alphanumeric values as company numbers", () => {
  const result = compileCompanyUniverse({
    file: [
      {
        sourceId: "company-1",
        name: "Acme Ltd",
        companyNumber: "not-a-number-123",
      },
    ],
  });

  assert.deepEqual(result.companies[0]?.companyNumbers, []);
});

test("a row with disagreeing domain fields cannot bridge companies", () => {
  const result = compileCompanyUniverse({
    file: [
      {
        sourceId: "row-1",
        name: "Dual Domain Ltd",
        domain: "dual-one.test",
        websiteUrl: "https://dual-two.test/about",
      },
    ],
    pipedrive: [
      {
        sourceId: "separate-company",
        name: "Dual Two Ltd",
        domain: "dual-two.test",
      },
    ],
  });

  const conflicted = result.companies.find((company) =>
    company.sourceIds.file.includes("row-1"),
  );
  assert.deepEqual(conflicted?.domains, [
    "dual-one.test",
    "dual-two.test",
  ]);
  assert.equal(result.companies.length, 2);
  assert.ok(
    result.reviewQueue.some((item) => item.kind === "row_domain_conflict"),
  );
  assert.ok(result.reviewQueue.some((item) => item.kind === "domain_conflict"));
});

test("compiler output is deterministic regardless of input ordering", () => {
  const forward: CompanyUniverseInputs = {
    attio: [
      { sourceId: "2", name: "Beta Ltd", domain: "beta.test" },
      { sourceId: "1", name: "Alpha Ltd", domain: "alpha.test" },
    ],
    pipedrive: [
      { sourceId: "20", name: "Beta Limited", domain: "www.beta.test" },
      { sourceId: "10", name: "Alpha Limited", domain: "www.alpha.test" },
    ],
  };
  const reverse: CompanyUniverseInputs = {
    attio: [...(forward.attio ?? [])].reverse(),
    pipedrive: [...(forward.pipedrive ?? [])].reverse(),
  };

  assert.deepEqual(
    compileCompanyUniverse(forward),
    compileCompanyUniverse(reverse),
  );
});

test("canonical company ID remains stable when a source record gains a company number", () => {
  const before = compileCompanyUniverse({
    attio: [
      {
        sourceId: "attio-stable-record",
        name: "Stable Build Ltd",
        domain: "stable-build.test",
      },
    ],
  });
  const after = compileCompanyUniverse({
    attio: [
      {
        sourceId: "attio-stable-record",
        name: "Stable Build Ltd",
        domain: "stable-build.test",
        companyNumber: "12345678",
      },
    ],
  });

  assert.equal(before.companies[0]?.id, after.companies[0]?.id);
  assert.deepEqual(after.companies[0]?.companyNumbers, ["12345678"]);
});

test("normalizes common UK company-number representations", () => {
  assert.equal(normalizeCompanyNumber(" 1234567 "), "01234567");
  assert.equal(normalizeCompanyNumber("sc 123456"), "SC123456");
  assert.equal(normalizeCompanyNumber("N/A"), null);
  assert.equal(normalizeCompanyNumber(""), null);
});
