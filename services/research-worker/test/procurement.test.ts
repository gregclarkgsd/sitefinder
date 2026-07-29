import assert from "node:assert/strict";
import test from "node:test";
import { matchProcurementReleases } from "../src/public-data/procurement.js";
import type { CompanySeed } from "../src/types.js";

const company: CompanySeed = {
  id: "company-1",
  name: "Example Build Ltd",
  domain: "example-build.test",
  websiteUrl: "https://example-build.test",
  source: "file",
};

test("matches exact supplier names but avoids fuzzy procurement joins", () => {
  const result = matchProcurementReleases(
    [company],
    [
      {
        id: "000001-2026",
        ocid: "ocds-example-1",
        date: "2026-07-20T10:00:00Z",
        tender: { title: "Council refurbishment", status: "complete" },
        awards: [
          {
            title: "Council refurbishment award",
            status: "active",
            value: { amount: 500_000, currency: "GBP" },
            suppliers: [{ name: "Example Build Limited" }],
          },
        ],
      },
      {
        id: "000002-2026",
        tender: { title: "Different contract" },
        awards: [{ suppliers: [{ name: "Example Building Services Ltd" }] }],
      },
      {
        id: "000003-2026",
        tender: { title: "Group company contract" },
        awards: [{ suppliers: [{ name: "Example Build Group Ltd" }] }],
      },
    ],
    "find_a_tender",
  );

  assert.equal(result.signals.length, 1);
  assert.equal(result.signals[0]?.role, "supplier");
  assert.equal(result.signals[0]?.value, 500_000);
  assert.equal(result.evidence.length, 1);
});
