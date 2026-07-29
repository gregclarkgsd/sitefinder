import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AttioReader } from "../src/crm/attio.js";
import { PipedriveReader } from "../src/crm/pipedrive.js";
import { loadCompanyUniverseRows } from "../src/universe/company-universe-io.js";
import { compileCompanyUniverse } from "../src/universe/index.js";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("maps Attio company and people attributes without writes", async () => {
  const fetchMock = (async (input: string | URL | Request) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input
          : input.url,
    );
    if (url.pathname.includes("/companies/")) {
      return jsonResponse({
        data: [
          {
            id: { record_id: "company-record" },
            values: {
              name: [{ value: "Example Build Ltd" }],
              domains: [{ domain: "www.example-build.test" }],
            },
          },
          {
            id: { record_id: "domainless-company" },
            values: {
              name: [{ value: "Domainless Contractor Ltd" }],
              domains: [],
            },
          },
        ],
      });
    }
    return jsonResponse({
      data: [
        {
          id: { record_id: "person-record" },
          values: {
            name: [{ full_name: "Alice Morgan" }],
            email_addresses: [{ email_address: "alice@example-build.test" }],
            job_title: [{ value: "Quantity Surveyor" }],
            company: [{ target_record_id: "company-record" }],
          },
        },
      ],
    });
  }) as typeof fetch;

  const reader = new AttioReader("test-token", fetchMock);
  const [companies, people] = await Promise.all([
    reader.snapshotCompanies(),
    reader.snapshotPeople(),
  ]);
  assert.equal(companies[0]?.domain, "example-build.test");
  assert.equal(companies.length, 2);
  assert.equal(companies[1]?.name, "Domainless Contractor Ltd");
  assert.equal(companies[1]?.domain, undefined);
  assert.equal(people[0]?.jobTitle, "Quantity Surveyor");
  assert.deepEqual(people[0]?.companyRecordIds, ["company-record"]);
});

test("follows Pipedrive cursor pagination and maps read-only person fields", async () => {
  let calls = 0;
  const fetchMock = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls += 1;
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input
          : input.url,
    );
    assert.equal(url.searchParams.has("api_token"), false);
    assert.equal(new Headers(init?.headers).get("x-api-token"), "test-token");
    assert.equal(init?.redirect, "error");
    if (!url.searchParams.has("cursor")) {
      return jsonResponse({
        success: true,
        data: [
          {
            id: 1,
            name: "Alice Morgan",
            emails: [{ value: "alice@example-build.test" }],
            job_title: "Senior Quantity Surveyor",
            org_id: { value: 10, name: "Example Build Ltd" },
            labels: [{ label: "Priority" }],
            notes: "Left the business",
          },
        ],
        additional_data: { next_cursor: "next-page" },
      });
    }
    return jsonResponse({
      success: true,
      data: [
        {
          id: 2,
          name: "Benjamin Carter",
          email: [{ value: "benjamin@example-build.test" }],
          job_title: "Commercial Manager",
          note: "Left voicemail with reception",
        },
      ],
      additional_data: { next_cursor: null },
    });
  }) as typeof fetch;

  const reader = new PipedriveReader(
    "test-token",
    "https://example-company.pipedrive.com",
    fetchMock,
  );
  const people = await reader.snapshotPeople();
  assert.equal(calls, 2);
  assert.equal(people.length, 2);
  assert.equal(people[0]?.jobTitle, "Senior Quantity Surveyor");
  assert.equal(people[0]?.organizationName, "Example Build Ltd");
  assert.equal(people[0]?.noteDepartedSignal, true);
  assert.equal(people[1]?.noteDepartedSignal, undefined);
  assert.equal("notes" in (people[0] ?? {}), false);
});

test("retains Pipedrive organizations without domains for universe review", async () => {
  const fetchMock = (async () =>
    jsonResponse({
      success: true,
      data: [
        { id: 10, name: "Known Website Ltd", website: "known.test" },
        { id: 11, name: "Needs Domain Research Ltd" },
      ],
      additional_data: { next_cursor: null },
    })) as typeof fetch;

  const reader = new PipedriveReader(
    "test-token",
    "https://api.pipedrive.com",
    fetchMock,
  );
  const companies = await reader.snapshotOrganizations();
  assert.equal(companies.length, 2);
  assert.equal(companies[0]?.domain, "known.test");
  assert.equal(companies[1]?.domain, undefined);
  assert.equal(companies[1]?.sourceRecordId, "11");
});

test("CRM snapshot JSON feeds domainless organizations into universe review", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "crm-universe-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const path = join(directory, "companies.json");
  await writeFile(
    path,
    JSON.stringify([
      {
        id: "pipedrive:11",
        name: "Needs Domain Research Ltd",
        source: "pipedrive",
        sourceRecordId: "11",
      },
    ]),
  );

  const rows = await loadCompanyUniverseRows(path);
  const result = compileCompanyUniverse({ pipedrive: rows });
  assert.equal(result.summary.inputRows, 1);
  assert.equal(result.summary.domainlessRows, 1);
  assert.ok(result.reviewQueue.some((item) => item.kind === "domainless"));
});

test("rejects untrusted Pipedrive API origins before sending a token", () => {
  const neverFetch = (async () => {
    assert.fail("fetch must not run for an untrusted Pipedrive origin");
  }) as typeof fetch;

  for (const baseUrl of [
    "http://api.pipedrive.com",
    "https://pipedrive.com.evil.test",
    "https://api.pipedrive.com.evil.test",
    "https://user:pass@api.pipedrive.com",
    "https://api.pipedrive.com/custom/path",
    "https://localhost:3000",
  ]) {
    assert.throws(
      () => new PipedriveReader("secret-token", baseUrl, neverFetch),
      /credential-free HTTPS origin on pipedrive\.com/u,
    );
  }
});
