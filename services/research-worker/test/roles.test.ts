import assert from "node:assert/strict";
import test from "node:test";
import { classifyRoleTitle } from "../src/lib/roles.js";

test("classifies the construction roles GSD targets", () => {
  const cases = [
    ["Senior Quantity Surveyor", "quantity_surveying"],
    ["Commercial Manager", "commercial"],
    ["Head of Procurement", "procurement"],
    ["Supply Chain Director", "supply_chain"],
    ["Project Manager", "project_management"],
    ["Contracts Manager", "contracts"],
    ["Site Surveyor", "site_surveying"],
    ["Senior Estimator", "estimating"],
    ["Site Manager", "site_management"],
  ] as const;

  for (const [title, expected] of cases) {
    assert.equal(classifyRoleTitle(title)?.category, expected);
  }
});

test("does not classify unrelated management titles", () => {
  assert.equal(classifyRoleTitle("Marketing Manager"), null);
  assert.equal(classifyRoleTitle("Finance Director"), null);
  assert.equal(classifyRoleTitle("Office Administrator"), null);
});
