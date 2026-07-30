import assert from "node:assert/strict";
import test from "node:test";
import { ApolloPeopleReader } from "../src/public-data/apollo.js";
import type { CompanySeed } from "../src/types.js";

const company: CompanySeed = {
  id: "company-1",
  name: "Example Build Ltd",
  domain: "example-build.com",
  websiteUrl: "https://example-build.com/",
  apolloSearchDomain: "people.example-build.com",
  source: "file",
};

test("searches exact company domains and retains verified licensed business emails", async () => {
  const requests: URL[] = [];
  const reader = new ApolloPeopleReader("test-api-key", {
    maxPeople: 5,
    fetchImpl: async (input, init) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input
            : input.url,
      );
      requests.push(url);
      assert.equal(new Headers(init?.headers).get("x-api-key"), "test-api-key");
      assert.equal(init?.redirect, "error");

      if (url.pathname.endsWith("/mixed_people/api_search")) {
        assert.deepEqual(
          url.searchParams.getAll("q_organization_domains_list[]"),
          ["people.example-build.com"],
        );
        assert.ok(
          url.searchParams.getAll("person_titles[]").includes(
            "commercial manager",
          ),
        );
        return Response.json({
          people: [
            {
              id: "apollo-person-1",
              title: "Regional Commercial Manager",
              has_email: true,
            },
            {
              id: "apollo-person-2",
              title: "Marketing Manager",
              has_email: true,
            },
          ],
        });
      }

      assert.equal(url.pathname.endsWith("/people/match"), true);
      assert.equal(url.searchParams.get("id"), "apollo-person-1");
      assert.equal(
        url.searchParams.get("domain"),
        "people.example-build.com",
      );
      assert.equal(url.searchParams.get("reveal_personal_emails"), "false");
      assert.equal(url.searchParams.get("reveal_phone_number"), "false");
      return Response.json({
        person: {
          id: "apollo-person-1",
          name: "Example Person",
          title: "Regional Commercial Manager",
          email: "person@example-build.com",
          email_status: "verified",
          linkedin_url: "http://www.linkedin.com/in/example-person?tracking=1",
          organization: { primary_domain: "example-build.com" },
        },
      });
    },
  });

  const result = await reader.enrich(company);

  assert.equal(requests.length, 2);
  assert.equal(result.contacts.length, 1);
  assert.deepEqual(result.contacts[0]?.emails, [
    {
      value: "person@example-build.com",
      status: "licensed_provider",
    },
  ]);
  assert.deepEqual(result.contacts[0]?.profileUrls, [
    "https://www.linkedin.com/in/example-person",
  ]);
  assert.equal(result.contacts[0]?.roleCategory, "commercial");
  assert.ok(
    result.evidence.some(
      (item) =>
        item.sourceKind === "apollo" &&
        item.field === "licensed_business_email",
    ),
  );
});

test("rejects personal emails and mismatched company domains", async () => {
  let enrichCount = 0;
  const reader = new ApolloPeopleReader("test-api-key", {
    fetchImpl: async (input) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input
            : input.url,
      );
      if (url.pathname.endsWith("/mixed_people/api_search")) {
        return Response.json({
          people: [
            {
              id: "personal-email",
              title: "Quantity Surveyor",
              has_email: true,
            },
            {
              id: "wrong-company",
              title: "Procurement Manager",
              has_email: true,
            },
          ],
        });
      }
      enrichCount += 1;
      const personal = url.searchParams.get("id") === "personal-email";
      return Response.json({
        person: {
          id: url.searchParams.get("id"),
          name: personal ? "Personal Email" : "Wrong Company",
          title: personal ? "Quantity Surveyor" : "Procurement Manager",
          email: personal ? "person@gmail.com" : "person@other-company.test",
          email_status: "verified",
          organization: {
            primary_domain: personal
              ? "example-build.com"
              : "other-company.test",
          },
        },
      });
    },
  });

  const result = await reader.enrich(company);

  assert.equal(enrichCount, 2);
  assert.deepEqual(result.contacts, []);
  assert.deepEqual(result.evidence, []);
});
