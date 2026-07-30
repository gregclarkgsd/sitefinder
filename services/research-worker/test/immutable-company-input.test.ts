import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseCapturedCompanySeeds } from "../src/io/company-input.js";
import { captureImmutableInput } from "../src/io/immutable-input.js";
import {
  parseCapturedCompanyUniverseInputs,
} from "../src/universe/company-universe-io.js";

test("company selection parses the same bytes whose digest is recorded", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "immutable-companies-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "companies.json");
  await writeFile(
    path,
    JSON.stringify([
      {
        id: "first",
        name: "First Ltd",
        domain: "first.example",
        apolloSearchDomain: "people.first.example",
      },
    ]),
  );
  const captured = await captureImmutableInput(path);
  await writeFile(
    path,
    JSON.stringify([
      { id: "second", name: "Second Ltd", domain: "second.example" },
    ]),
  );

  const seeds = parseCapturedCompanySeeds(captured);
  assert.equal(seeds[0]?.name, "First Ltd");
  assert.equal(seeds[0]?.apolloSearchDomain, "people.first.example");
  assert.equal(captured.byteLength, Buffer.byteLength(captured.text));
});

test("universe compilation parses each source's captured bytes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "immutable-universe-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "attio.json");
  await writeFile(
    path,
    JSON.stringify([
      {
        sourceRecordId: "attio-first",
        name: "First Ltd",
        domain: "first.example",
      },
    ]),
  );
  const captured = await captureImmutableInput(path);
  await writeFile(
    path,
    JSON.stringify([
      {
        sourceRecordId: "attio-second",
        name: "Second Ltd",
        domain: "second.example",
      },
    ]),
  );

  const inputs = parseCapturedCompanyUniverseInputs({
    attioCompanies: captured,
  });
  assert.equal(inputs.attio?.[0]?.sourceId, "attio-first");
});
