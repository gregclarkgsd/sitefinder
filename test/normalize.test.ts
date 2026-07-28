import assert from "node:assert/strict";
import test from "node:test";
import { sameCompanyName } from "../src/lib/normalize.js";

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
