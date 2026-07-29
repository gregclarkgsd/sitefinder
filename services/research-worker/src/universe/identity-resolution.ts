import { z } from "zod";
import {
  parseCapturedJson,
  type ImmutableInput,
} from "../io/immutable-input.js";

export const siteFinderIdentitySourceSchema = z.enum([
  "sitefinder_contractor",
  "sitefinder_client",
]);

export const crmIdentitySourceSchema = z.enum(["attio", "pipedrive"]);

const siteFinderEndpointSchema = z
  .object({
    source: siteFinderIdentitySourceSchema,
    sourceId: z.string().trim().min(1).max(512),
  })
  .strict();

const crmEndpointSchema = z
  .object({
    source: crmIdentitySourceSchema,
    sourceId: z.string().trim().min(1).max(512),
  })
  .strict();

export const reviewedIdentityResolutionSchema = z
  .object({
    resolutionKey: z.string().trim().min(1).max(256),
    sitefinder: siteFinderEndpointSchema,
    crm: crmEndpointSchema,
    reason: z.string().trim().min(3).max(2_000),
  })
  .strict();

export const identityResolutionManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("sitefinder_crm_identity_resolutions"),
    status: z.literal("approved"),
    reviewedBy: z.string().trim().min(1).max(256),
    reviewedAt: z.iso.datetime(),
    reason: z.string().trim().min(3).max(2_000),
    resolutions: z.array(reviewedIdentityResolutionSchema).min(1).max(100_000),
  })
  .strict()
  .superRefine((manifest, context) => {
    const resolutionKeys = new Set<string>();
    const siteFinderKeys = new Set<string>();
    for (const [index, resolution] of manifest.resolutions.entries()) {
      if (resolutionKeys.has(resolution.resolutionKey)) {
        context.addIssue({
          code: "custom",
          path: ["resolutions", index, "resolutionKey"],
          message: "Identity-resolution keys must be unique",
        });
      }
      resolutionKeys.add(resolution.resolutionKey);

      const siteFinderKey =
        `${resolution.sitefinder.source}:${resolution.sitefinder.sourceId}`;
      if (siteFinderKeys.has(siteFinderKey)) {
        context.addIssue({
          code: "custom",
          path: ["resolutions", index, "sitefinder"],
          message:
            "Each SiteFinder company identity may have only one approved CRM mapping",
        });
      }
      siteFinderKeys.add(siteFinderKey);
    }
  });

export type SiteFinderIdentitySource = z.infer<
  typeof siteFinderIdentitySourceSchema
>;
export type CrmIdentitySource = z.infer<typeof crmIdentitySourceSchema>;
export type ReviewedIdentityResolution = z.infer<
  typeof reviewedIdentityResolutionSchema
>;
export type IdentityResolutionManifest = z.infer<
  typeof identityResolutionManifestSchema
>;

export function parseIdentityResolutionManifest(
  input: ImmutableInput,
): IdentityResolutionManifest {
  return identityResolutionManifestSchema.parse(parseCapturedJson(input));
}
