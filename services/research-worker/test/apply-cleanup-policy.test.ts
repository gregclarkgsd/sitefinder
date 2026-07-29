import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCleanupPolicyToCompany,
  indexAttioPeopleForCleanup,
  partitionCompaniesByCleanupPolicy,
} from "../src/policy/apply-cleanup-policy.js";
import {
  cleanupDecisionSchema,
  type CleanupDecision,
} from "../src/policy/cleanup-policy.js";
import type { EnrichedCompany } from "../src/types.js";

function decision(input: Partial<CleanupDecision>): CleanupDecision {
  return cleanupDecisionSchema.parse({
    schemaVersion: 1,
    decisionId: "decision-1",
    status: "quarantined",
    classification: "unresolved",
    directive: "hold",
    subject: { kind: "email", email: "person@example.test" },
    reason: "Awaiting a human cleanup decision",
    reviewedBy: "reviewer@example.invalid",
    decidedAt: "2026-07-29T09:00:00.000Z",
    ...input,
  });
}

function result(): EnrichedCompany {
  return {
    company: {
      id: "company-1",
      name: "Example Build",
      domain: "example.test",
      websiteUrl: "https://example.test/",
      source: "file",
    },
    facts: {},
    contacts: [
      {
        id: "contact-1",
        companyId: "company-1",
        name: "Example Person",
        normalizedName: "example person",
        jobTitle: "Commercial Manager",
        roleCategory: "commercial",
        rolePriority: 90,
        employmentStatus: "current",
        emails: [
          { value: "person@example.test", status: "public" },
          { value: "other@example.test", status: "public" },
        ],
        phones: [],
        profileUrls: [],
        evidenceIds: ["evidence-1"],
        confidence: 0.95,
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
    evidence: [],
    pagesVisited: [],
    pagesSkipped: [],
    warnings: [],
    completedAt: "2026-07-29T09:30:00.000Z",
  };
}

test("quarantined identities are held and never remain ordinary candidates", () => {
  const filtered = applyCleanupPolicyToCompany(result(), [decision({})]);
  assert.equal(filtered.result.contacts.length, 0);
  assert.equal(filtered.heldMatches.length, 1);
  assert.equal(filtered.heldMatches[0]?.disposition, "hold_for_review");
});

test("an invalid address is removed without suppressing an alternative address", () => {
  const invalid = decision({
    status: "approved",
    classification: "invalid_address",
    directive: "invalid_address",
    subject: { kind: "email", email: "person@example.test" },
    reason: "Mailbox verification returned a hard bounce",
  });
  const filtered = applyCleanupPolicyToCompany(result(), [invalid]);
  assert.deepEqual(filtered.result.contacts[0]?.emails, [
    { value: "other@example.test", status: "public" },
  ]);
  assert.equal(filtered.heldMatches[0]?.kind, "email");
  assert.equal(filtered.heldMatches[0]?.disposition, "suppressed_match");
});

test("an irrelevant company withholds every discovered identity", () => {
  const irrelevant = decision({
    status: "approved",
    classification: "irrelevant_company",
    directive: "irrelevant_company",
    subject: { kind: "company", domain: "example.test" },
    reason: "Company is outside the approved market",
  });
  const filtered = applyCleanupPolicyToCompany(result(), [irrelevant]);
  assert.equal(filtered.result.contacts.length, 0);
  assert.equal(filtered.heldMatches[0]?.kind, "company");
  assert.equal(filtered.heldMatches[0]?.disposition, "suppressed_match");
});

test("a discovery without a durable person identifier is held for review", () => {
  const noEmail = result();
  const discovered = noEmail.contacts[0];
  assert.ok(discovered);
  discovered.emails = [];
  discovered.profileUrls = [
    "https://www.linkedin.com/in/example-person",
  ];
  const unrelatedDecision = decision({
    status: "approved",
    classification: "invalid_address",
    directive: "invalid_address",
    subject: { kind: "email", email: "old@example.test" },
    reason: "Mailbox verification returned a hard bounce",
  });

  const filtered = applyCleanupPolicyToCompany(noEmail, [
    unrelatedDecision,
  ]);

  assert.equal(filtered.result.contacts.length, 0);
  assert.equal(filtered.heldMatches.length, 1);
  assert.equal(
    filtered.heldMatches[0]?.reason,
    "missing_durable_person_identifier",
  );
  assert.deepEqual(filtered.heldMatches[0]?.matchedDecisionIds, []);
});

test("a company merge does not block a canonical company containing the survivor", () => {
  const merged = result();
  merged.company.sourceIds = {
    attio: ["company-duplicate", "company-survivor"],
  };
  const mergeDecision = decision({
    decisionId: "company-merge",
    status: "approved",
    classification: "duplicate_record",
    directive: "merged_into",
    subject: {
      kind: "company",
      attioRecordId: "company-duplicate",
    },
    replacementAttioRecordId: "company-survivor",
    reason: "Reviewed duplicate company record",
  });

  const partition = partitionCompaniesByCleanupPolicy(
    [merged.company],
    [mergeDecision],
  );
  assert.equal(partition.allowed.length, 1);
  assert.equal(partition.held.length, 0);

  const filtered = applyCleanupPolicyToCompany(merged, [mergeDecision]);
  assert.equal(filtered.result.contacts.length, 1);
  assert.equal(filtered.heldMatches.length, 0);
});

test("a company merge remains held when the survivor is outside the canonical company", () => {
  const merged = result();
  merged.company.sourceIds = {
    attio: ["company-duplicate"],
  };
  const mergeDecision = decision({
    decisionId: "company-merge",
    status: "approved",
    classification: "duplicate_record",
    directive: "merged_into",
    subject: {
      kind: "company",
      attioRecordId: "company-duplicate",
    },
    replacementAttioRecordId: "company-survivor",
    reason: "Reviewed duplicate company record",
  });

  const partition = partitionCompaniesByCleanupPolicy(
    [merged.company],
    [mergeDecision],
  );
  assert.equal(partition.allowed.length, 0);
  assert.equal(partition.held[0]?.disposition, "redirected_match");
});

test("an ID-only person quarantine is enforced through the verified Attio email index", () => {
  const quarantined = decision({
    decisionId: "person-id-quarantine",
    subject: {
      kind: "person",
      attioRecordId: "attio-person-1",
    },
    reason: "The Attio record is awaiting a human cleanup decision",
  });
  const personIndex = indexAttioPeopleForCleanup([
    {
      recordId: "attio-person-1",
      name: "Example Person",
      emails: ["person@example.test"],
      jobTitle: "Commercial Manager",
      companyRecordIds: ["company-1"],
    },
  ]);

  const filtered = applyCleanupPolicyToCompany(
    result(),
    [quarantined],
    personIndex,
  );

  assert.equal(filtered.result.contacts.length, 0);
  assert.deepEqual(filtered.heldMatches[0]?.matchedDecisionIds, [
    "person-id-quarantine",
  ]);
});

test("an ID-only former-employment decision is enforced at the matching company", () => {
  const former = decision({
    decisionId: "former-person-id",
    status: "approved",
    classification: "former_employee",
    directive: "former_employee",
    subject: {
      kind: "employment",
      personAttioRecordId: "attio-person-1",
      companyDomain: "example.test",
    },
    reason: "The employer confirmed this person has left",
  });
  const personIndex = indexAttioPeopleForCleanup([
    {
      recordId: "attio-person-1",
      name: "Example Person",
      emails: ["person@example.test"],
      jobTitle: "Former Commercial Manager",
      companyRecordIds: ["company-1"],
    },
  ]);

  const filtered = applyCleanupPolicyToCompany(
    result(),
    [former],
    personIndex,
  );

  assert.equal(filtered.result.contacts.length, 0);
  assert.equal(
    filtered.heldMatches[0]?.directives.includes("former_employee"),
    true,
  );
});
