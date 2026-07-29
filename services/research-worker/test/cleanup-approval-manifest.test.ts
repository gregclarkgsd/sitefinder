import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureImmutableInput } from "../src/io/immutable-input.js";
import {
  cleanupApprovalManifestSchema,
  loadVerifiedCleanupApproval,
  verifyCleanupApproval,
} from "../src/policy/cleanup-approval-manifest.js";

function decision(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    decisionId: "approved-junk-001",
    status: "approved",
    classification: "junk_sender",
    directive: "do_not_reimport",
    subject: { kind: "email", email: "sender@example-build.test" },
    reason: "Human review confirmed an automated irrelevant sender",
    reviewedBy: "reviewer@example.invalid",
    decidedAt: "2026-07-29T10:00:00.000Z",
  };
}

function manifest(ledger: Buffer, decisionCount = 1): unknown {
  return {
    schemaVersion: 1,
    kind: "cleanup_approval_manifest",
    status: "approved",
    approvedBy: "reviewer@example.invalid",
    approvedAt: "2026-07-29T10:01:00.000Z",
    ledger: {
      sha256: createHash("sha256").update(ledger).digest("hex"),
      decisionCount,
    },
  };
}

test("verifies an approval against the exact captured ledger bytes and count", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cleanup-approval-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const ledgerPath = join(directory, "decisions.jsonl");
  const manifestPath = join(directory, "approval.json");
  const ledger = Buffer.from(`${JSON.stringify(decision())}\n`);
  await writeFile(ledgerPath, ledger);
  await writeFile(manifestPath, JSON.stringify(manifest(ledger)));

  const verified = await loadVerifiedCleanupApproval(ledgerPath, manifestPath);
  assert.equal(verified.decisions.length, 1);
  assert.equal(verified.ledgerInput.sha256, verified.manifest.ledger.sha256);
});

test("rejects changed bytes, wrong counts, empty ledgers and loose manifests", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cleanup-approval-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const ledgerPath = join(directory, "decisions.jsonl");
  const manifestPath = join(directory, "approval.json");
  const ledger = Buffer.from(`${JSON.stringify(decision())}\n`);
  await writeFile(ledgerPath, ledger);
  await writeFile(
    manifestPath,
    JSON.stringify(manifest(Buffer.from(`${ledger.toString()} `))),
  );
  await assert.rejects(
    loadVerifiedCleanupApproval(ledgerPath, manifestPath),
    /SHA-256 does not match/u,
  );

  await writeFile(manifestPath, JSON.stringify(manifest(ledger, 2)));
  await assert.rejects(
    loadVerifiedCleanupApproval(ledgerPath, manifestPath),
    /decision count does not match/u,
  );

  assert.throws(
    () =>
      cleanupApprovalManifestSchema.parse({
        ...(manifest(ledger) as object),
        unexpected: true,
      }),
  );

  const emptyPath = join(directory, "empty.jsonl");
  const emptyManifestPath = join(directory, "empty-approval.json");
  const empty = Buffer.from("");
  await writeFile(emptyPath, empty);
  await writeFile(
    emptyManifestPath,
    JSON.stringify({
      ...(manifest(empty) as Record<string, unknown>),
      ledger: {
        sha256: createHash("sha256").update(empty).digest("hex"),
        decisionCount: 1,
      },
    }),
  );
  await assert.rejects(
    loadVerifiedCleanupApproval(emptyPath, emptyManifestPath),
    /must not be empty/u,
  );
});

test("parsing and hashing remain bound to a captured immutable input", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cleanup-captured-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const ledgerPath = join(directory, "decisions.jsonl");
  const manifestPath = join(directory, "approval.json");
  const original = Buffer.from(`${JSON.stringify(decision())}\n`);
  await writeFile(ledgerPath, original);
  await writeFile(manifestPath, JSON.stringify(manifest(original)));
  const [capturedLedger, capturedManifest] = await Promise.all([
    captureImmutableInput(ledgerPath),
    captureImmutableInput(manifestPath),
  ]);

  await writeFile(ledgerPath, `${JSON.stringify(decision())}\n\n`);
  const verified = verifyCleanupApproval(capturedLedger, capturedManifest);
  assert.equal(verified.decisions.length, 1);
  assert.equal(
    verified.ledgerInput.sha256,
    createHash("sha256").update(original).digest("hex"),
  );
});
