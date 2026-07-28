import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadCompanySeeds } from "../src/io/private-files.js";

test("accepts matching website domains and rejects mismatched ones", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gsd-sales-seeds-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const matching = join(directory, "matching.json");
  await writeFile(
    matching,
    JSON.stringify([
      {
        name: "Example Ltd",
        domain: "example.com",
        websiteUrl: "https://www.example.com/team",
        source: "file",
      },
    ]),
  );
  const seeds = await loadCompanySeeds(matching);
  assert.equal(seeds[0]?.websiteUrl, "https://www.example.com/team");

  const mismatched = join(directory, "mismatched.json");
  await writeFile(
    mismatched,
    JSON.stringify([
      {
        name: "Example Ltd",
        domain: "example.com",
        websiteUrl: "https://news.ycombinator.com/",
        source: "file",
      },
    ]),
  );
  await assert.rejects(
    loadCompanySeeds(mismatched),
    /Website domain does not match company domain/u,
  );
});
