import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { ImmutableInput } from "../src/io/immutable-input.js";
import { verifyPeopleSnapshotInput } from "../src/io/verified-snapshot-input.js";

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

function manifestFor(data: ImmutableInput, source: "attio" | "pipedrive") {
  return input(`${source}-completion-manifest.json`, {
    schemaVersion: 1,
    status: "complete",
    kind: "operational_read_only_snapshot",
    completedAt: "2026-07-29T12:00:00.000Z",
    source,
    notice: "Operational snapshot, not a backup.",
    deletionSafety: "not_a_complete_deletion_safe_crm_backup",
    counts: { people: 1 },
    artifacts: [
      {
        file: "people.json",
        sha256: data.sha256,
        bytes: data.byteLength,
        mode: 0o600,
      },
    ],
  });
}

test("binds a CRM people snapshot to its completed snapshot manifest", () => {
  const data = input("people.json", [{ recordId: "person-1" }]);
  const verified = verifyPeopleSnapshotInput(
    data,
    manifestFor(data, "attio"),
    "attio",
  );
  assert.equal(verified.expectedPeopleCount, 1);
});

test("rejects a changed or cross-source CRM people snapshot", () => {
  const approved = input("people.json", [{ recordId: "person-1" }]);
  const changed = input("people.json", [{ recordId: "person-2" }]);
  assert.throws(
    () =>
      verifyPeopleSnapshotInput(
        changed,
        manifestFor(approved, "attio"),
        "attio",
      ),
    /does not match/u,
  );
  assert.throws(
    () =>
      verifyPeopleSnapshotInput(
        approved,
        manifestFor(approved, "pipedrive"),
        "attio",
      ),
    /does not match attio/u,
  );
});
