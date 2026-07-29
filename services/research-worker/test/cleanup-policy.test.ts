import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import {
  cleanupDecisionSchema,
  evaluateCleanupPolicy,
  loadCleanupDecisionLedger,
  parseCleanupDecisionLedger,
  type CleanupDecision,
} from "../src/policy/cleanup-policy.js";

function decision(
  overrides: Partial<CleanupDecision> = {},
): CleanupDecision {
  return cleanupDecisionSchema.parse({
    schemaVersion: 1,
    decisionId: "decision-001",
    status: "approved",
    classification: "opted_out",
    directive: "do_not_contact",
    subject: {
      kind: "email",
      email: "Person@Example-Build.test",
    },
    reason: "The recipient explicitly opted out",
    reviewedBy: "reviewer@example.invalid",
    decidedAt: "2026-07-29T09:00:00.000Z",
    ...overrides,
  });
}

test("strict schema normalizes identifiers and rejects unknown fields", () => {
  const parsed = decision();
  assert.equal(
    parsed.subject.kind === "email" ? parsed.subject.email : "",
    "person@example-build.test",
  );

  assert.throws(
    () =>
      cleanupDecisionSchema.parse({
        ...parsed,
        unexpected: true,
      }),
    z.ZodError,
  );
});

test("classification, directive, status and subject combinations are controlled", () => {
  assert.throws(
    () =>
      decision({
        classification: "invalid_address",
        directive: "do_not_contact",
      }),
    /requires directive invalid_address/u,
  );
  assert.throws(
    () =>
      decision({
        status: "quarantined",
      }),
    /requires status approved/u,
  );
  assert.throws(
    () =>
      decision({
        classification: "former_employee",
        directive: "former_employee",
      }),
    /cannot target a email subject/u,
  );
});

test("company identities cannot use a public mailbox provider domain", () => {
  assert.throws(
    () =>
      decision({
        classification: "irrelevant_company",
        directive: "irrelevant_company",
        subject: {
          kind: "company",
          domain: "gmail.com",
        },
      }),
    /Public email-provider domains cannot identify a company/u,
  );
});

test("merge decisions require a distinct source and replacement record", () => {
  assert.throws(
    () =>
      decision({
        classification: "duplicate_record",
        directive: "merged_into",
        subject: {
          kind: "person",
          attioRecordId: "person-source",
        },
      }),
    /requires a replacement Attio record ID/u,
  );
  assert.throws(
    () =>
      decision({
        classification: "duplicate_record",
        directive: "merged_into",
        subject: {
          kind: "person",
          attioRecordId: "person-source",
        },
        replacementAttioRecordId: "person-source",
      }),
    /must differ from its source/u,
  );
});

test("loads strict JSON and JSONL ledgers", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cleanup-policy-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const first = decision();
  const second = decision({
    decisionId: "decision-002",
    classification: "invalid_address",
    directive: "invalid_address",
    subject: {
      kind: "email",
      email: "bounced@example-build.test",
    },
    reason: "Mailbox verification returned a hard bounce",
    decidedAt: "2026-07-29T09:01:00.000Z",
  });

  const jsonPath = join(directory, "decisions.json");
  await writeFile(
    jsonPath,
    JSON.stringify({ schemaVersion: 1, decisions: [first, second] }),
  );
  assert.equal((await loadCleanupDecisionLedger(jsonPath)).length, 2);

  const jsonlPath = join(directory, "decisions.jsonl");
  await writeFile(
    jsonlPath,
    `${JSON.stringify(first)}\n\n${JSON.stringify(second)}\n`,
  );
  assert.equal((await loadCleanupDecisionLedger(jsonlPath)).length, 2);
});

test("reports the exact malformed JSONL line", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cleanup-policy-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const path = join(directory, "decisions.jsonl");
  await writeFile(path, `${JSON.stringify(decision())}\n{broken\n`);

  await assert.rejects(
    loadCleanupDecisionLedger(path),
    /at line 2/u,
  );
});

test("append-only supersession must be explicit, ordered and subject-stable", () => {
  const quarantined = decision({
    decisionId: "decision-quarantine",
    status: "quarantined",
    classification: "unresolved",
    directive: "hold",
    reason: "Awaiting a human cleanup decision",
  });
  const approved = decision({
    decisionId: "decision-approved",
    supersedesDecisionId: quarantined.decisionId,
    decidedAt: "2026-07-29T10:00:00.000Z",
  });
  assert.equal(
    parseCleanupDecisionLedger([quarantined, approved]).length,
    2,
  );

  assert.throws(
    () => parseCleanupDecisionLedger([quarantined, decision()]),
    /conflicting active decisions/u,
  );
  assert.throws(
    () =>
      parseCleanupDecisionLedger([
        quarantined,
        decision({
          decisionId: "decision-wrong-subject",
          supersedesDecisionId: quarantined.decisionId,
          subject: {
            kind: "email",
            email: "different@example-build.test",
          },
          decidedAt: "2026-07-29T10:00:00.000Z",
        }),
      ]),
    /cannot supersede a different subject/u,
  );
});

test("a cleanup no-change decision cannot weaken an approved suppression", () => {
  const optedOut = decision();
  const attemptedKeep = decision({
    decisionId: "decision-keep",
    status: "approved",
    classification: "legitimate",
    directive: "no_change",
    supersedesDecisionId: optedOut.decisionId,
    reason: "Attempted cleanup reclassification",
    decidedAt: "2026-07-29T10:00:00.000Z",
  });
  assert.throws(
    () => parseCleanupDecisionLedger([optedOut, attemptedKeep]),
    /cannot weaken do_not_contact/u,
  );
});

test("quarantine holds a rediscovered identity until an approved supersession", () => {
  const quarantined = decision({
    decisionId: "decision-quarantine",
    status: "quarantined",
    classification: "unresolved",
    directive: "hold",
    reason: "Awaiting a human cleanup decision",
  });
  const lookup = { email: "PERSON@example-build.test" };
  assert.equal(
    evaluateCleanupPolicy([quarantined], lookup).disposition,
    "hold_for_review",
  );

  const approved = decision({
    decisionId: "decision-approved",
    supersedesDecisionId: quarantined.decisionId,
    decidedAt: "2026-07-29T10:00:00.000Z",
  });
  const outcome = evaluateCleanupPolicy([quarantined, approved], lookup);
  assert.equal(outcome.disposition, "suppressed_match");
  assert.deepEqual(outcome.matchedDecisionIds, ["decision-approved"]);
});

test("an irrelevant company suppresses candidates by normalized company domain", () => {
  const irrelevant = decision({
    decisionId: "company-irrelevant",
    classification: "irrelevant_company",
    directive: "irrelevant_company",
    subject: {
      kind: "company",
      domain: "https://www.example-build.test/contact",
    },
    reason: "Company is outside the approved market",
  });
  const outcome = evaluateCleanupPolicy([irrelevant], {
    companyDomain: "EXAMPLE-BUILD.test",
  });

  assert.equal(outcome.disposition, "suppressed_match");
  assert.equal(outcome.company, "irrelevant_company");
});

test("authoritative company record IDs prevent a shared domain false match", () => {
  const irrelevant = decision({
    decisionId: "company-irrelevant",
    classification: "irrelevant_company",
    directive: "irrelevant_company",
    subject: {
      kind: "company",
      attioRecordId: "company-a",
      domain: "shared-group.test",
    },
    reason: "This subsidiary is outside the approved market",
  });
  const outcome = evaluateCleanupPolicy([irrelevant], {
    companyAttioRecordId: "company-b",
    companyDomain: "shared-group.test",
  });

  assert.equal(outcome.disposition, "allow");
});

test("a durable email suppression survives an Attio person record recreation", () => {
  const optedOut = decision({
    decisionId: "person-opted-out",
    subject: {
      kind: "person",
      attioRecordId: "person-old",
      email: "person@example-build.test",
    },
    reason: "The recipient explicitly opted out",
  });
  const outcome = evaluateCleanupPolicy([optedOut], {
    personAttioRecordId: "person-recreated",
    email: "person@example-build.test",
  });

  assert.equal(outcome.disposition, "suppressed_match");
  assert.equal(outcome.contact, "do_not_contact");
});

test("a company number remains authoritative after an Attio record recreation", () => {
  const irrelevant = decision({
    decisionId: "company-recreated",
    classification: "irrelevant_company",
    directive: "irrelevant_company",
    subject: {
      kind: "company",
      attioRecordId: "company-old",
      companyNumber: "01234567",
      domain: "shared-group.test",
    },
    reason: "The reviewed legal entity is outside the approved market",
  });
  const outcome = evaluateCleanupPolicy([irrelevant], {
    companyAttioRecordId: "company-recreated",
    companyNumber: "01234567",
    companyDomain: "shared-group.test",
  });

  assert.equal(outcome.disposition, "suppressed_match");
  assert.equal(outcome.company, "irrelevant_company");
});

test("invalid email decisions suppress only the exact normalized address", () => {
  const invalid = decision({
    decisionId: "email-invalid",
    classification: "invalid_address",
    directive: "invalid_address",
    subject: {
      kind: "email",
      email: "old@example-build.test",
    },
    reason: "Mailbox verification returned a hard bounce",
  });

  assert.equal(
    evaluateCleanupPolicy([invalid], {
      email: "OLD@example-build.test",
    }).contact,
    "invalid_address",
  );
  assert.equal(
    evaluateCleanupPolicy([invalid], {
      email: "new@example-build.test",
    }).disposition,
    "allow",
  );
});

test("former employment requires both the person and company to match", () => {
  const former = decision({
    decisionId: "employment-former",
    classification: "former_employee",
    directive: "former_employee",
    subject: {
      kind: "employment",
      email: "person@example-build.test",
      companyDomain: "old-employer.test",
    },
    reason: "The company confirmed this person has left",
  });

  assert.equal(
    evaluateCleanupPolicy([former], {
      email: "person@example-build.test",
      companyDomain: "old-employer.test",
    }).employment,
    "former_employee",
  );
  assert.equal(
    evaluateCleanupPolicy([former], {
      email: "person@example-build.test",
      companyDomain: "new-employer.test",
    }).disposition,
    "allow",
  );
});

test("merge decisions return deterministic person and company redirects", () => {
  const personMerge = decision({
    decisionId: "person-merge",
    classification: "duplicate_record",
    directive: "merged_into",
    subject: {
      kind: "person",
      attioRecordId: "person-old",
    },
    replacementAttioRecordId: "person-current",
    reason: "Reviewed duplicate person record",
  });
  const companyMerge = decision({
    decisionId: "company-merge",
    classification: "duplicate_record",
    directive: "merged_into",
    subject: {
      kind: "company",
      attioRecordId: "company-old",
    },
    replacementAttioRecordId: "company-current",
    reason: "Reviewed duplicate company record",
    decidedAt: "2026-07-29T09:01:00.000Z",
  });

  const outcome = evaluateCleanupPolicy([companyMerge, personMerge], {
    personAttioRecordId: "person-old",
    companyAttioRecordId: "company-old",
  });
  assert.equal(outcome.disposition, "redirected_match");
  assert.deepEqual(outcome.merge, {
    personAttioRecordId: "person-current",
    companyAttioRecordId: "company-current",
  });
  assert.deepEqual(outcome.matchedDecisionIds, [
    "person-merge",
    "company-merge",
  ]);
});

test("merge chains resolve to one final survivor", () => {
  const first = decision({
    decisionId: "person-merge-a-b",
    classification: "duplicate_record",
    directive: "merged_into",
    subject: {
      kind: "person",
      attioRecordId: "person-a",
    },
    replacementAttioRecordId: "person-b",
    reason: "Reviewed first duplicate person record",
  });
  const second = decision({
    decisionId: "person-merge-b-c",
    classification: "duplicate_record",
    directive: "merged_into",
    subject: {
      kind: "person",
      attioRecordId: "person-b",
    },
    replacementAttioRecordId: "person-c",
    reason: "Reviewed second duplicate person record",
    decidedAt: "2026-07-29T09:01:00.000Z",
  });

  const outcome = evaluateCleanupPolicy([first, second], {
    personAttioRecordId: "person-a",
  });
  assert.deepEqual(outcome.merge, {
    personAttioRecordId: "person-c",
  });
});

test("merge cycles are rejected", () => {
  const first = decision({
    decisionId: "person-merge-a-b",
    classification: "duplicate_record",
    directive: "merged_into",
    subject: {
      kind: "person",
      attioRecordId: "person-a",
    },
    replacementAttioRecordId: "person-b",
    reason: "Reviewed first duplicate person record",
  });
  const second = decision({
    decisionId: "person-merge-b-a",
    classification: "duplicate_record",
    directive: "merged_into",
    subject: {
      kind: "person",
      attioRecordId: "person-b",
    },
    replacementAttioRecordId: "person-a",
    reason: "Reviewed second duplicate person record",
    decidedAt: "2026-07-29T09:01:00.000Z",
  });

  assert.throws(
    () => parseCleanupDecisionLedger([first, second]),
    /merge graph contains a cycle/u,
  );
});

test("approved suppressions take precedence over redirects", () => {
  const merge = decision({
    decisionId: "person-merge",
    classification: "duplicate_record",
    directive: "merged_into",
    subject: {
      kind: "person",
      attioRecordId: "person-old",
    },
    replacementAttioRecordId: "person-current",
    reason: "Reviewed duplicate person record",
  });
  const optOut = decision({
    decisionId: "person-opt-out",
    subject: {
      kind: "person",
      attioRecordId: "person-old",
      email: "person@example-build.test",
    },
    reason: "The recipient explicitly opted out",
    decidedAt: "2026-07-29T09:01:00.000Z",
  });
  const outcome = evaluateCleanupPolicy([merge, optOut], {
    personAttioRecordId: "person-old",
  });

  assert.equal(outcome.disposition, "suppressed_match");
  assert.equal(outcome.contact, "do_not_contact");
  assert.deepEqual(outcome.merge, {
    personAttioRecordId: "person-current",
  });
});
