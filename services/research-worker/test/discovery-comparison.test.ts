import assert from "node:assert/strict";
import test from "node:test";

import { compareContactDiscoveries } from "../src/comparison/discovery-comparison.js";
import type {
  AttioPersonSnapshot,
  ContactCandidate,
  PipedrivePersonSnapshot,
} from "../src/types.js";

function candidate(
  id: string,
  emails: string[],
): ContactCandidate {
  return {
    id,
    companyId: "company-1",
    name: "Private Candidate",
    normalizedName: "private candidate",
    jobTitle: "Commercial Director",
    roleCategory: "commercial",
    rolePriority: 1,
    employmentStatus: "current",
    emails: emails.map((value) => ({ value, status: "public" })),
    phones: [],
    profileUrls: [],
    evidenceIds: [],
    confidence: 0.9,
  };
}

function attio(
  recordId: string,
  emails: string[],
): AttioPersonSnapshot {
  return {
    recordId,
    name: "Attio Person",
    emails,
    jobTitle: "",
    companyRecordIds: [],
  };
}

function pipedrive(
  personId: string,
  emails: string[],
): PipedrivePersonSnapshot {
  return {
    personId,
    name: "Pipedrive Person",
    emails,
    jobTitle: "",
    labels: [],
  };
}

test("classifies exact normalized business-email outcomes", () => {
  const report = compareContactDiscoveries(
    [
      candidate("in-attio", [" Alice@Build.Example "]),
      candidate("pipe-only", ["bob@build.example"]),
      candidate("new", ["new@build.example"]),
      candidate("personal", ["person@gmail.com"]),
      candidate("malformed", ["person@localhost"]),
      candidate("none", []),
    ],
    [attio("attio-1", ["alice@build.example"])],
    [
      pipedrive("pipe-alice", ["ALICE@BUILD.EXAMPLE"]),
      pipedrive("pipe-bob", ["bob@build.example"]),
    ],
  );

  assert.deepEqual(report.siteFinder, [
    { candidateId: "in-attio", status: "already_in_attio" },
    { candidateId: "pipe-only", status: "pipedrive_only" },
    { candidateId: "new", status: "missing_from_both" },
    { candidateId: "personal", status: "unverifiable_no_email" },
    { candidateId: "malformed", status: "unverifiable_no_email" },
    { candidateId: "none", status: "unverifiable_no_email" },
  ]);
  assert.deepEqual(report.counts, {
    already_in_attio: 1,
    pipedrive_only: 1,
    missing_from_both: 1,
    conflicting_multiple_matches: 0,
    unverifiable_no_email: 3,
  });
});

test("keeps emails and external CRM IDs out of SiteFinder results", () => {
  const report = compareContactDiscoveries(
    [candidate("opaque-candidate", ["secret@build.example"])],
    [attio("private-attio-id", ["secret@build.example"])],
    [pipedrive("private-pipe-id", ["secret@build.example"])],
  );

  assert.deepEqual(report.siteFinder, [
    { candidateId: "opaque-candidate", status: "already_in_attio" },
  ]);
  assert.equal(
    JSON.stringify(report.siteFinder).includes("secret@build.example"),
    false,
  );
  assert.equal(
    JSON.stringify(report.siteFinder).includes("private-attio-id"),
    false,
  );
  assert.equal(
    JSON.stringify(report.siteFinder).includes("private-pipe-id"),
    false,
  );
  assert.deepEqual(report.local[0], {
    candidateId: "opaque-candidate",
    status: "already_in_attio",
    reason: "exact_attio_email_match",
    normalizedBusinessEmails: ["secret@build.example"],
    emailMatches: [
      {
        email: "secret@build.example",
        attioRecordIds: ["private-attio-id"],
        pipedrivePersonIds: ["private-pipe-id"],
        attioSnapshotCount: 1,
        pipedriveSnapshotCount: 1,
      },
    ],
  });
});

test("deduplicates and sorts candidate emails deterministically", () => {
  const report = compareContactDiscoveries(
    [
      candidate("ordered", [
        "Zulu@build.example",
        "alpha@build.example",
        " zulu@BUILD.example ",
      ]),
    ],
    [],
    [],
  );

  assert.deepEqual(report.local[0]?.normalizedBusinessEmails, [
    "alpha@build.example",
    "zulu@build.example",
  ]);
  assert.deepEqual(
    report.local[0]?.emailMatches.map(({ email }) => email),
    ["alpha@build.example", "zulu@build.example"],
  );
  assert.equal(report.local[0]?.status, "missing_from_both");
});

test("fails conservative when one email has multiple CRM matches", () => {
  const report = compareContactDiscoveries(
    [candidate("duplicate", ["same@build.example"])],
    [
      attio("attio-b", ["same@build.example"]),
      attio("attio-a", ["SAME@BUILD.EXAMPLE"]),
    ],
    [],
  );

  assert.equal(report.local[0]?.status, "conflicting_multiple_matches");
  assert.equal(report.local[0]?.reason, "duplicate_crm_email_match");
  assert.deepEqual(report.local[0]?.emailMatches[0]?.attioRecordIds, [
    "attio-a",
    "attio-b",
  ]);
});

test("fails conservative when candidate emails have mixed outcomes", () => {
  const report = compareContactDiscoveries(
    [
      candidate("mixed", [
        "existing@build.example",
        "new@build.example",
      ]),
    ],
    [attio("attio-1", ["existing@build.example"])],
    [],
  );

  assert.equal(report.local[0]?.status, "conflicting_multiple_matches");
  assert.equal(report.local[0]?.reason, "inconsistent_email_outcomes");
});

test("fails conservative when candidate emails point at different identities", () => {
  const attioConflict = compareContactDiscoveries(
    [candidate("attio-conflict", ["one@build.example", "two@build.example"])],
    [
      attio("attio-1", ["one@build.example"]),
      attio("attio-2", ["two@build.example"]),
    ],
    [],
  );
  const pipedriveConflict = compareContactDiscoveries(
    [candidate("pipe-conflict", ["one@build.example", "two@build.example"])],
    [],
    [
      pipedrive("pipe-1", ["one@build.example"]),
      pipedrive("pipe-2", ["two@build.example"]),
    ],
  );

  assert.equal(attioConflict.local[0]?.status, "conflicting_multiple_matches");
  assert.equal(
    attioConflict.local[0]?.reason,
    "inconsistent_attio_identity",
  );
  assert.equal(
    pipedriveConflict.local[0]?.status,
    "conflicting_multiple_matches",
  );
  assert.equal(
    pipedriveConflict.local[0]?.reason,
    "inconsistent_pipedrive_identity",
  );
});

test("fails conservative when an exact CRM match lacks a record identity", () => {
  const report = compareContactDiscoveries(
    [candidate("invalid-id", ["person@build.example"])],
    [attio("  ", ["person@build.example"])],
    [],
  );

  assert.equal(report.local[0]?.status, "conflicting_multiple_matches");
  assert.equal(report.local[0]?.reason, "invalid_crm_record_identity");
  assert.equal(report.local[0]?.emailMatches[0]?.attioSnapshotCount, 1);
  assert.deepEqual(report.local[0]?.emailMatches[0]?.attioRecordIds, []);
});

test("does not let personal CRM emails participate in business matching", () => {
  const report = compareContactDiscoveries(
    [candidate("business", ["person@build.example"])],
    [attio("attio-1", ["person@gmail.com"])],
    [pipedrive("pipe-1", ["person@yahoo.com"])],
  );

  assert.equal(report.local[0]?.status, "missing_from_both");
  assert.equal(report.local[0]?.reason, "no_crm_email_match");
});

test("does not mutate candidate or snapshot inputs", () => {
  const candidates = [candidate("immutable", ["PERSON@build.example"])];
  const attioPeople = [attio("attio-1", ["person@build.example"])];
  const pipedrivePeople = [pipedrive("pipe-1", ["person@build.example"])];
  const before = JSON.stringify({
    candidates,
    attioPeople,
    pipedrivePeople,
  });

  compareContactDiscoveries(candidates, attioPeople, pipedrivePeople);

  assert.equal(
    JSON.stringify({ candidates, attioPeople, pipedrivePeople }),
    before,
  );
});
