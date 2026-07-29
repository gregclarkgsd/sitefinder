import assert from "node:assert/strict";
import test from "node:test";
import { CLI_HELP_TEXT } from "../src/cli-help.js";

const REQUIRED_ENRICH_FLAGS = [
  "--input",
  "--cleanup-decisions",
  "--cleanup-manifest",
  "--attio-people",
  "--attio-snapshot-manifest",
  "--pipedrive-people",
  "--pipedrive-snapshot-manifest",
] as const;

function enrichExamples(): string[] {
  return CLI_HELP_TEXT
    .split(/\n(?=  npm run )/u)
    .filter((block) => block.startsWith("  npm run enrich "));
}

test("every CLI help enrichment example is complete and cleanup-current", () => {
  const examples = enrichExamples();
  assert.ok(examples.length > 0);
  for (const example of examples) {
    for (const flag of REQUIRED_ENRICH_FLAGS) {
      assert.match(example, new RegExp(`(?:^|\\s)${flag}(?:=|\\s)`, "u"));
    }
    assert.match(example, /(?:--company-id|--pilot-manifest)(?:=|\s)/u);
    assert.match(
      example,
      /--attio-people snapshots\/attio-post-cleanup\/people\.json/u,
    );
    assert.match(
      example,
      /--attio-snapshot-manifest snapshots\/attio-post-cleanup\/completion-manifest\.json/u,
    );
    assert.doesNotMatch(example, /(?:--limit|--confirm-large-run)(?:=|\s)/u);
  }
});
