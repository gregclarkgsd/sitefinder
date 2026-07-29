import { z } from "zod";
import {
  captureImmutableInput,
  parseCapturedJson,
  type ImmutableInput,
} from "../io/immutable-input.js";
import {
  parseCleanupDecisionLedgerContents,
  type CleanupDecision,
} from "./cleanup-policy.js";

const sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u, "Expected a lowercase SHA-256 digest");

export const cleanupApprovalManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("cleanup_approval_manifest"),
    status: z.literal("approved"),
    approvedBy: z.string().trim().min(1).max(256),
    approvedAt: z.iso.datetime(),
    ledger: z
      .object({
        sha256: sha256Schema,
        decisionCount: z.number().int().positive(),
      })
      .strict(),
    note: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

export type CleanupApprovalManifest = z.infer<
  typeof cleanupApprovalManifestSchema
>;

export interface VerifiedCleanupApproval {
  manifest: CleanupApprovalManifest;
  decisions: CleanupDecision[];
  ledgerInput: ImmutableInput;
  manifestInput: ImmutableInput;
}

export function verifyCleanupApproval(
  ledgerInput: ImmutableInput,
  manifestInput: ImmutableInput,
): VerifiedCleanupApproval {
  const manifest = cleanupApprovalManifestSchema.parse(
    parseCapturedJson(manifestInput),
  );
  const decisions = parseCleanupDecisionLedgerContents(
    ledgerInput.text,
    ledgerInput.path,
  );
  if (decisions.length === 0) {
    throw new Error("Cleanup decision ledger must not be empty");
  }
  if (ledgerInput.sha256 !== manifest.ledger.sha256) {
    throw new Error(
      "Cleanup decision ledger SHA-256 does not match its approval manifest",
    );
  }
  if (decisions.length !== manifest.ledger.decisionCount) {
    throw new Error(
      "Cleanup decision count does not match its approval manifest",
    );
  }
  return { manifest, decisions, ledgerInput, manifestInput };
}

export async function loadVerifiedCleanupApproval(
  ledgerPath: string,
  manifestPath: string,
): Promise<VerifiedCleanupApproval> {
  const [ledgerInput, manifestInput] = await Promise.all([
    captureImmutableInput(ledgerPath),
    captureImmutableInput(manifestPath),
  ]);
  return verifyCleanupApproval(ledgerInput, manifestInput);
}
