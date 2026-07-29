import assert from "node:assert/strict";
import test from "node:test";
import {
  isBusinessEmail,
  sameCompanyName,
  stableId,
} from "../src/lib/normalize.js";

test("does not collapse Group, Holdings or UK identity qualifiers", () => {
  const base = "Alpha Beta Construction Services Ltd";
  assert.equal(
    sameCompanyName(base, "Alpha Beta Construction Services Group Ltd"),
    false,
  );
  assert.equal(
    sameCompanyName(base, "Alpha Beta Construction Services Holdings Ltd"),
    false,
  );
  assert.equal(
    sameCompanyName(base, "Alpha Beta Construction Services UK Ltd"),
    false,
  );
});

test("uses deterministic 128-bit identifiers for persisted research facts", () => {
  const id = stableId("company", "example.test", "commercial");
  assert.match(id, /^gsd_[0-9a-f]{32}$/u);
  assert.equal(id, stableId("company", "example.test", "commercial"));
  assert.notEqual(id, stableId("company", "example.test", "procurement"));
});

test("common public mailbox providers cannot identify a business", () => {
  for (const domain of [
    "mail.com",
    "gmx.com",
    "me.com",
    "msn.com",
    "yahoo.fr",
    "fastmail.com",
  ]) {
    assert.equal(isBusinessEmail(`person@${domain}`), false, domain);
  }
  assert.equal(isBusinessEmail("person@example-build.test"), true);
});
