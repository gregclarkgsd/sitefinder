import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadQueueInputManifest } from "../src/io/queue-input-manifest.js";

test("resolves every queued-run prerequisite beneath the private root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gsd-queue-inputs-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, "inputs"));
  const names = [
    "cleanup.jsonl",
    "cleanup-manifest.json",
    "attio.json",
    "attio-manifest.json",
    "pipedrive.json",
    "pipedrive-manifest.json",
  ];
  await Promise.all(
    names.map((name) => writeFile(join(root, "inputs", name), "{}")),
  );
  await writeFile(
    join(root, "queue-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      cleanupDecisions: "inputs/cleanup.jsonl",
      cleanupManifest: "inputs/cleanup-manifest.json",
      attioPeople: "inputs/attio.json",
      attioSnapshotManifest: "inputs/attio-manifest.json",
      pipedrivePeople: "inputs/pipedrive.json",
      pipedriveSnapshotManifest: "inputs/pipedrive-manifest.json",
    }),
  );

  const canonicalRoot = await realpath(root);
  const result = await loadQueueInputManifest(
    canonicalRoot,
    "queue-manifest.json",
  );
  assert.equal(
    result.cleanupDecisions,
    join(canonicalRoot, "inputs", "cleanup.jsonl"),
  );
  assert.equal(
    result.pipedriveSnapshotManifest,
    join(canonicalRoot, "inputs", "pipedrive-manifest.json"),
  );
});

test("rejects manifests that reference files outside the private root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gsd-queue-private-"));
  const outside = await mkdtemp(join(tmpdir(), "gsd-queue-outside-"));
  t.after(async () => {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  });
  const outsideFile = join(outside, "outside.json");
  await writeFile(outsideFile, "{}");
  await writeFile(
    join(root, "queue-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      cleanupDecisions: outsideFile,
      cleanupManifest: outsideFile,
      attioPeople: outsideFile,
      attioSnapshotManifest: outsideFile,
      pipedrivePeople: outsideFile,
      pipedriveSnapshotManifest: outsideFile,
    }),
  );

  await assert.rejects(
    loadQueueInputManifest(await realpath(root), "queue-manifest.json"),
    /must stay inside/u,
  );
});
