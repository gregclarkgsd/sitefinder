import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadCompanySeeds,
  loadCrmCompanySnapshots,
} from "../src/io/private-files.js";

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
        sourceIds: {
          attio: ["attio-company-1"],
          pipedrive: ["42"],
        },
      },
    ]),
  );
  const seeds = await loadCompanySeeds(matching);
  assert.equal(seeds[0]?.websiteUrl, "https://www.example.com/team");
  assert.deepEqual(seeds[0]?.sourceIds, {
    attio: ["attio-company-1"],
    pipedrive: ["42"],
  });

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

test("loads domainless CRM snapshots without weakening research seeds", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gsd-crm-snapshots-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const snapshot = join(directory, "companies.json");
  await writeFile(
    snapshot,
    JSON.stringify([
      {
        id: "attio:company-1",
        name: "Domainless Ltd",
        source: "attio",
        sourceRecordId: "company-1",
      },
    ]),
  );

  const companies = await loadCrmCompanySnapshots(snapshot);
  assert.equal(companies.length, 1);
  assert.equal(companies[0]?.domain, undefined);
  await assert.rejects(loadCompanySeeds(snapshot), /domain/u);
});
