import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeCompletionManifest } from "../src/io/completion-manifest.js";
import {
  preparePrivateOutputDirectory,
  type PrivateOutputDirectory,
} from "../src/io/private-data-boundary.js";
import { writePrivateJson } from "../src/io/private-files.js";

async function fixture(
  t: { after: (fn: () => Promise<void>) => void },
): Promise<PrivateOutputDirectory> {
  const createdRoot = await mkdtemp(join(tmpdir(), "completion-manifest-"));
  const rootDirectory = await realpath(createdRoot);
  t.after(async () => rm(rootDirectory, { recursive: true, force: true }));
  const path = join(rootDirectory, "run");
  await mkdir(path, { mode: 0o700 });
  const output = {
    rootDirectory,
    path,
    relativePath: "run",
    workspaceDirectory: join(tmpdir(), "unrelated-workspace"),
  };
  await preparePrivateOutputDirectory(output);
  return output;
}

test("writes a complete marker last with artifact hashes and counts", async (t) => {
  const output = await fixture(t);
  await writePrivateJson(output, "summary.json", { companies: 2 });
  await writeCompletionManifest(output, ["summary.json"], {
    kind: "company_universe",
    counts: { companies: 2 },
  });

  const manifest = JSON.parse(
    await readFile(join(output.path, "completion-manifest.json"), "utf8"),
  ) as {
    status: string;
    counts: { companies: number };
    artifacts: Array<{ file: string; sha256: string; mode: number }>;
  };
  assert.equal(manifest.status, "complete");
  assert.equal(manifest.counts.companies, 2);
  assert.equal(manifest.artifacts[0]?.file, "summary.json");
  assert.match(manifest.artifacts[0]?.sha256 ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(manifest.artifacts[0]?.mode, 0o600);
});

test("a failed artifact check never leaves a completion marker", async (t) => {
  const output = await fixture(t);
  await assert.rejects(
    writeCompletionManifest(output, ["missing.json"], {
      kind: "enrichment_run",
      counts: {},
    }),
  );
  await assert.rejects(
    access(join(output.path, "completion-manifest.json")),
  );
});
