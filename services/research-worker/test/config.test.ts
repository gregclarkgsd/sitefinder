import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

test("allows unused optional credentials to be blank", () => {
  const config = loadConfig({
    RESEARCH_PRIVATE_DATA_DIRECTORY: "/private/gsd-research-data",
    ATTIO_API_TOKEN: "attio-token",
    PIPEDRIVE_API_TOKEN: "",
    COMPANIES_HOUSE_API_KEY: "   ",
    APOLLO_API_KEY: "",
  });

  assert.equal(
    config.privateDataDirectory,
    "/private/gsd-research-data",
  );
  assert.equal(config.attioToken, "attio-token");
  assert.equal(config.pipedriveToken, undefined);
  assert.equal(config.companiesHouseApiKey, undefined);
  assert.equal(config.apolloApiKey, undefined);
  assert.equal(config.researchQueueInputManifest, undefined);
  assert.equal(config.researchWorkerId, "gsd-local-worker");
});

test("accepts a private queue manifest and non-sensitive worker ID", () => {
  const config = loadConfig({
    RESEARCH_PRIVATE_DATA_DIRECTORY: "/private/gsd-research-data",
    RESEARCH_QUEUE_INPUT_MANIFEST: "queue/worker-inputs.json",
    RESEARCH_WORKER_ID: "worker-01",
  });
  assert.equal(
    config.researchQueueInputManifest,
    "queue/worker-inputs.json",
  );
  assert.equal(config.researchWorkerId, "worker-01");
  assert.throws(() => loadConfig({
    RESEARCH_PRIVATE_DATA_DIRECTORY: "/private/gsd-research-data",
    RESEARCH_WORKER_ID: "Greg’s MacBook /Users/greg",
  }));
});

test("requires an absolute private-data directory", () => {
  assert.throws(
    () => loadConfig({ RESEARCH_PRIVATE_DATA_DIRECTORY: "private-data" }),
    /RESEARCH_PRIVATE_DATA_DIRECTORY must be an absolute path/u,
  );
  assert.throws(
    () => loadConfig({}),
    /RESEARCH_PRIVATE_DATA_DIRECTORY/u,
  );
});

test("accepts only trusted HTTPS Pipedrive API origins", () => {
  const trusted = loadConfig({
    RESEARCH_PRIVATE_DATA_DIRECTORY: "/private/gsd-research-data",
    PIPEDRIVE_API_DOMAIN: "https://tenant-name.pipedrive.com/",
  });
  assert.equal(
    trusted.pipedriveApiDomain,
    "https://tenant-name.pipedrive.com",
  );

  for (const value of [
    "http://api.pipedrive.com",
    "https://api.pipedrive.com.evil.test",
    "https://localhost:3000",
  ]) {
    assert.throws(
      () =>
        loadConfig({
          RESEARCH_PRIVATE_DATA_DIRECTORY: "/private/gsd-research-data",
          PIPEDRIVE_API_DOMAIN: value,
        }),
      /credential-free HTTPS origin on pipedrive\.com/u,
    );
  }
});
