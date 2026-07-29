import { z } from "zod";
import type { CompanySeed } from "../types.js";
import {
  parseCapturedJson,
  type ImmutableInput,
} from "../io/immutable-input.js";

const reviewedPilotManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("reviewed_company_pilot"),
    companyInputSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    attioPeopleSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    pipedrivePeopleSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    companyIds: z.array(z.string().trim().min(1).max(256)).min(1).max(250),
    purpose: z.string().trim().min(3).max(1_000),
    reviewedBy: z.string().trim().min(1).max(256),
    reviewedAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (new Set(manifest.companyIds).size !== manifest.companyIds.length) {
      context.addIssue({
        code: "custom",
        path: ["companyIds"],
        message: "Reviewed pilot company IDs must be unique",
      });
    }
  });

export type ReviewedPilotManifest = z.infer<
  typeof reviewedPilotManifestSchema
>;

export interface ReviewedPilotSelection {
  manifest: ReviewedPilotManifest;
  companies: CompanySeed[];
}

export function selectReviewedPilotCompanies(
  companies: CompanySeed[],
  companyInput: ImmutableInput,
  manifestInput: ImmutableInput,
): ReviewedPilotSelection {
  const manifest = reviewedPilotManifestSchema.parse(
    parseCapturedJson(manifestInput),
  );
  if (manifest.companyInputSha256 !== companyInput.sha256) {
    throw new Error(
      "Reviewed pilot manifest does not match the captured company input",
    );
  }
  const byId = new Map<string, CompanySeed>();
  for (const company of companies) {
    if (byId.has(company.id)) {
      throw new Error(`Company input contains duplicate ID ${company.id}`);
    }
    byId.set(company.id, company);
  }
  const selected = manifest.companyIds.map((id) => {
    const company = byId.get(id);
    if (!company) {
      throw new Error(`Reviewed pilot company ${id} is missing from the input`);
    }
    return company;
  });
  return { manifest, companies: selected };
}
