import { stat } from "node:fs/promises";
import { privateOutputFile, type PrivateOutputDirectory } from "./private-data-boundary.js";
import { captureImmutableInput } from "./immutable-input.js";
import { writePrivateJson } from "./private-files.js";

export interface CompletionManifestOptions {
  kind:
    | "operational_read_only_snapshot"
    | "company_universe"
    | "enrichment_run";
  counts: Record<string, number>;
  source?: "attio" | "pipedrive";
  inputs?: unknown;
  notice?: string;
  deletionSafety?: string;
}

export async function writeCompletionManifest(
  output: PrivateOutputDirectory,
  artifactFiles: string[],
  options: CompletionManifestOptions,
): Promise<void> {
  const artifacts = await Promise.all(
    artifactFiles.map(async (file) => {
      const path = privateOutputFile(output, file);
      const [captured, metadata] = await Promise.all([
        captureImmutableInput(path),
        stat(path),
      ]);
      return {
        file,
        sha256: captured.sha256,
        bytes: captured.byteLength,
        mode: metadata.mode & 0o777,
      };
    }),
  );
  await writePrivateJson(output, "completion-manifest.json", {
    schemaVersion: 1,
    status: "complete",
    kind: options.kind,
    completedAt: new Date().toISOString(),
    ...(options.source ? { source: options.source } : {}),
    ...(options.notice ? { notice: options.notice } : {}),
    ...(options.deletionSafety
      ? { deletionSafety: options.deletionSafety }
      : {}),
    counts: options.counts,
    ...(options.inputs ? { inputs: options.inputs } : {}),
    artifacts,
  });
}
