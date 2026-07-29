import { z } from "zod";
import {
  parseCapturedJson,
  type ImmutableInput,
} from "./immutable-input.js";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const artifactSchema = z
  .object({
    file: z.string().min(1),
    sha256: sha256Schema,
    bytes: z.number().int().nonnegative(),
    mode: z.number().int(),
  })
  .strict();

const snapshotManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal("complete"),
    kind: z.literal("operational_read_only_snapshot"),
    completedAt: z.iso.datetime(),
    source: z.enum(["attio", "pipedrive"]),
    notice: z.string().min(1),
    deletionSafety: z.string().min(1),
    counts: z.record(z.string(), z.number().int().nonnegative()),
    artifacts: z.array(artifactSchema).min(1),
  })
  .strict();

export interface VerifiedPeopleSnapshotInput {
  dataInput: ImmutableInput;
  manifestInput: ImmutableInput;
  expectedPeopleCount: number;
  completedAt: string;
}

export function verifyPeopleSnapshotInput(
  dataInput: ImmutableInput,
  manifestInput: ImmutableInput,
  source: "attio" | "pipedrive",
): VerifiedPeopleSnapshotInput {
  const manifest = snapshotManifestSchema.parse(
    parseCapturedJson(manifestInput),
  );
  if (manifest.source !== source) {
    throw new Error(
      `Snapshot manifest source ${manifest.source} does not match ${source}`,
    );
  }
  const matches = manifest.artifacts.filter(
    (artifact) => artifact.file === "people.json",
  );
  if (matches.length !== 1 || !matches[0]) {
    throw new Error(
      `${source} snapshot manifest must contain exactly one people.json artifact`,
    );
  }
  const artifact = matches[0];
  if (
    artifact.sha256 !== dataInput.sha256 ||
    artifact.bytes !== dataInput.byteLength
  ) {
    throw new Error(
      `${source} people snapshot does not match its completion manifest`,
    );
  }
  if (artifact.mode !== 0o600) {
    throw new Error(
      `${source} people snapshot manifest does not record private 0600 mode`,
    );
  }
  const expectedPeopleCount = manifest.counts["people"];
  if (expectedPeopleCount === undefined) {
    throw new Error(`${source} snapshot manifest is missing its people count`);
  }
  return {
    dataInput,
    manifestInput,
    expectedPeopleCount,
    completedAt: manifest.completedAt,
  };
}
