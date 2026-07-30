import { z } from "zod";
import { resolvePrivateInputFile } from "./private-data-boundary.js";
import { readJson } from "./private-files.js";

const inputPath = z.string().trim().min(1).max(500);

const queueInputManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    cleanupDecisions: inputPath,
    cleanupManifest: inputPath,
    attioPeople: inputPath,
    attioSnapshotManifest: inputPath,
    pipedrivePeople: inputPath,
    pipedriveSnapshotManifest: inputPath,
  })
  .strict();

export interface QueueInputPaths {
  cleanupDecisions: string;
  cleanupManifest: string;
  attioPeople: string;
  attioSnapshotManifest: string;
  pipedrivePeople: string;
  pipedriveSnapshotManifest: string;
}

export async function loadQueueInputManifest(
  privateRoot: string,
  requestedManifest: string,
): Promise<QueueInputPaths> {
  const manifestPath = await resolvePrivateInputFile(
    privateRoot,
    requestedManifest,
  );
  const parsed = queueInputManifestSchema.parse(
    await readJson<unknown>(manifestPath),
  );
  const [
    cleanupDecisions,
    cleanupManifest,
    attioPeople,
    attioSnapshotManifest,
    pipedrivePeople,
    pipedriveSnapshotManifest,
  ] = await Promise.all([
    resolvePrivateInputFile(privateRoot, parsed.cleanupDecisions),
    resolvePrivateInputFile(privateRoot, parsed.cleanupManifest),
    resolvePrivateInputFile(privateRoot, parsed.attioPeople),
    resolvePrivateInputFile(privateRoot, parsed.attioSnapshotManifest),
    resolvePrivateInputFile(privateRoot, parsed.pipedrivePeople),
    resolvePrivateInputFile(
      privateRoot,
      parsed.pipedriveSnapshotManifest,
    ),
  ]);
  return {
    cleanupDecisions,
    cleanupManifest,
    attioPeople,
    attioSnapshotManifest,
    pipedrivePeople,
    pipedriveSnapshotManifest,
  };
}
