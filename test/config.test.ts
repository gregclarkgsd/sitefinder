import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

test("allows unused optional credentials to be blank", () => {
  const config = loadConfig({
    ATTIO_API_TOKEN: "attio-token",
    PIPEDRIVE_API_TOKEN: "",
    COMPANIES_HOUSE_API_KEY: "   ",
  });

  assert.equal(config.attioToken, "attio-token");
  assert.equal(config.pipedriveToken, undefined);
  assert.equal(config.companiesHouseApiKey, undefined);
});
