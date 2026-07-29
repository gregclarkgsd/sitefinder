import assert from "node:assert/strict";
import test from "node:test";
import { CompaniesHouseReader } from "../src/public-data/companies-house.js";
import type { CompanySeed } from "../src/types.js";

const company: CompanySeed = {
  id: "company-1",
  name: "Example Build Ltd",
  domain: "example-build.test",
  websiteUrl: "https://example-build.test/",
  source: "file",
  companyNumber: "01234567",
};

test("rejects a supplied company number whose profile belongs to another entity", async () => {
  const reader = new CompaniesHouseReader(
    "test-key",
    async (_input, init) => {
      assert.equal(init?.redirect, "error");
      return new Response(
        JSON.stringify({
          company_name: "Unrelated Holdings Ltd",
          company_number: "01234567",
          company_status: "active",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  );

  const result = await reader.enrich(company);
  assert.deepEqual(result.facts, {});
  assert.deepEqual(result.evidence, []);
  assert.match(result.warnings[0] ?? "", /did not match/u);
});

test("accepts a supplied company number only when the legal identity matches", async () => {
  const reader = new CompaniesHouseReader(
    "test-key",
    async (_input, init) => {
      assert.equal(init?.redirect, "error");
      return new Response(
        JSON.stringify({
          company_name: "EXAMPLE BUILD LIMITED",
          company_number: "01234567",
          company_status: "active",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  );

  const result = await reader.enrich(company);
  assert.equal(result.facts.companyNumber, "01234567");
  assert.equal(result.facts.legalName, "EXAMPLE BUILD LIMITED");
  assert.ok(result.evidence.length > 0);
});

test("does not treat Ltd and LLP as the same Companies House entity", async () => {
  const reader = new CompaniesHouseReader(
    "test-key",
    async () =>
      new Response(
        JSON.stringify({
          company_name: "Example Build LLP",
          company_number: "01234567",
          company_status: "active",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );

  const result = await reader.enrich(company);
  assert.deepEqual(result.facts, {});
  assert.match(result.warnings[0] ?? "", /did not match/u);
});
