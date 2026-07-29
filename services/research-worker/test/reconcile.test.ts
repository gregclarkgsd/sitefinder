import assert from "node:assert/strict";
import test from "node:test";
import { reconcilePeople } from "../src/reconcile.js";
import type {
  AttioPersonSnapshot,
  PipedrivePersonSnapshot,
} from "../src/types.js";

const attio: AttioPersonSnapshot[] = [
  {
    recordId: "a-1",
    name: "Alice Morgan",
    emails: ["alice@example-build.test"],
    jobTitle: "",
    companyRecordIds: ["c-1"],
  },
  {
    recordId: "a-2",
    name: "Conflict Person",
    emails: ["conflict@example-build.test"],
    jobTitle: "Project Manager",
    companyRecordIds: ["c-2"],
  },
];

const pipedrive: PipedrivePersonSnapshot[] = [
  {
    personId: "p-1",
    name: "Alice Morgan",
    emails: ["ALICE@example-build.test"],
    jobTitle: "Senior Quantity Surveyor",
    organizationId: "o-1",
    organizationName: "Example Build Ltd",
    labels: [],
  },
  {
    personId: "p-2",
    name: "LEFT Former Person",
    emails: ["former@example-build.test"],
    jobTitle: "Commercial Manager",
    organizationName: "Example Build Ltd",
    labels: ["Left"],
  },
  {
    personId: "p-3",
    name: "New Contact",
    emails: ["new@example-build.test"],
    jobTitle: "Procurement Manager",
    organizationName: "Example Build Ltd",
    labels: [],
  },
  {
    personId: "p-4",
    name: "Personal Address",
    emails: ["personal@gmail.com"],
    jobTitle: "Project Manager",
    labels: [],
  },
  {
    personId: "p-5",
    name: "Conflict Person",
    emails: ["conflict@example-build.test"],
    jobTitle: "Project Manager",
    organizationName: "Different Contractor Ltd",
    labels: [],
  },
];

test("separates recoverable, stale, new, conflicting and unusable records", () => {
  const report = reconcilePeople(
    attio,
    pipedrive,
    new Map([
      ["c-1", "Example Build Ltd"],
      ["c-2", "Example Build Ltd"],
    ]),
  );

  assert.equal(report.counts.recoverable_title, 1);
  assert.equal(report.counts.departed_or_stale, 1);
  assert.equal(report.counts.pipedrive_only, 1);
  assert.equal(report.counts.unusable, 1);
  assert.equal(report.counts.company_conflict, 1);
});

test("matches a person when any business email exists in Attio", () => {
  const report = reconcilePeople(
    [
      {
        recordId: "a-multi",
        name: "Multiple Email Person",
        emails: ["current@example-build.test"],
        jobTitle: "",
        companyRecordIds: [],
      },
    ],
    [
      {
        personId: "p-multi",
        name: "Multiple Email Person",
        emails: ["old@example-build.test", "current@example-build.test"],
        jobTitle: "Project Manager",
        labels: [],
      },
    ],
  );

  assert.equal(report.counts.pipedrive_only, 0);
  assert.equal(report.counts.recoverable_title, 1);
  assert.equal(
    report.findings.find((finding) => finding.kind === "recoverable_title")
      ?.email,
    "current@example-build.test",
  );
});

test("uses only the bounded note signal and never exposes note text", () => {
  const report = reconcilePeople(
    [],
    [
      {
        personId: "p-active",
        name: "Active Contact",
        emails: ["active@example-build.test"],
        jobTitle: "Project Manager",
        organizationName: "Example Build Ltd",
        labels: [],
        noteDepartedSignal: true,
      },
    ],
  );

  assert.equal(report.counts.departed_or_stale, 1);
  assert.equal(report.counts.pipedrive_only, 0);
  const reason =
    report.findings.find((finding) => finding.kind === "departed_or_stale")
      ?.reason ?? "";
  assert.match(reason, /departed\/stale indicator/u);
  assert.equal(reason.includes("voicemail"), false);
});
