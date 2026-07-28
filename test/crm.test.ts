import assert from "node:assert/strict";
import test from "node:test";
import { AttioReader } from "../src/crm/attio.js";
import { PipedriveReader } from "../src/crm/pipedrive.js";

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
        },
      ],
      additional_data: { next_cursor: null },
    });
  }) as typeof fetch;

  const reader = new PipedriveReader(
    "test-token",
    "https://api.pipedrive.test",
    fetchMock,
  );
  const people = await reader.snapshotPeople();
  assert.equal(calls, 2);
  assert.equal(people.length, 2);
  assert.equal(people[0]?.jobTitle, "Senior Quantity Surveyor");
  assert.equal(people[0]?.organizationName, "Example Build Ltd");
  assert.deepEqual(people[0]?.notes, ["Left the business"]);
});
