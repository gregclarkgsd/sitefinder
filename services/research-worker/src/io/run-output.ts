import type { EnrichmentRun } from "../pipeline/enrich.js";
import type { PrivateOutputDirectory } from "./private-data-boundary.js";
import {
  writePrivateJson,
  writePrivateJsonLines,
} from "./private-files.js";

export async function writeEnrichmentRun(
  output: PrivateOutputDirectory,
  run: EnrichmentRun,
): Promise<void> {
  const contacts = run.companies.flatMap((company) => company.contacts);
  const evidence = run.companies.flatMap((company) => company.evidence);
  const projects = run.companies.flatMap((company) => company.projects);
  const comparisonByCandidateId = new Map(
    run.crmComparisons.map((comparison) => [
      comparison.candidateId,
      comparison,
    ]),
  );
  const review = contacts
    .filter(
      (contact) => {
        const comparison = comparisonByCandidateId.get(contact.id);
        return (
          contact.confidence < 0.85 ||
          contact.employmentStatus !== "current" ||
          contact.emails.length === 0 ||
          !comparison ||
          comparison?.status === "conflicting_multiple_matches" ||
          comparison?.status === "unverifiable_no_email"
        );
      },
    )
    .map((contact) => {
      const comparison = comparisonByCandidateId.get(contact.id);
      return {
        contactId: contact.id,
        companyId: contact.companyId,
        name: contact.name,
        jobTitle: contact.jobTitle,
        confidence: contact.confidence,
        employmentStatus: contact.employmentStatus,
        crmComparison: comparison?.status ?? "not_compared",
        crmComparisonReason: comparison?.reason ?? "missing_comparison",
        reasons: [
          ...(contact.confidence < 0.85 ? ["low_confidence"] : []),
          ...(contact.employmentStatus !== "current"
            ? ["employment_not_confirmed"]
            : []),
          ...(contact.emails.length === 0 ? ["no_public_email"] : []),
          ...(comparison?.status === "conflicting_multiple_matches"
            ? [`crm_conflict:${comparison.reason}`]
            : []),
          ...(comparison?.status === "unverifiable_no_email"
            ? ["crm_unverifiable:no_business_email"]
            : []),
          ...(!comparison ? ["crm_comparison_missing"] : []),
        ],
        evidenceIds: contact.evidenceIds,
      };
    });

  await Promise.all([
    writePrivateJson(output, "summary.json", {
      mode: run.mode,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      companyCount: run.companyCount,
      completedCompanyCount: run.completedCompanyCount,
      failedCompanyCount: run.failedCompanyCount,
      skippedCompanyCount: run.skippedCompanyCount,
      cancelledCompanyCount: run.cancelledCompanyCount,
      contactCount: run.contactCount,
      evidenceCount: run.evidenceCount,
      projectSignalCount: run.projectSignalCount,
      heldMatchCount: run.heldMatchCount,
      heldCompanyCount: run.heldCompanyCount,
      crmComparisonCounts: run.crmComparisonCounts,
      reviewCount: review.length,
      warningCount: run.companies.reduce(
        (total, company) => total + company.warnings.length,
        0,
      ),
    }),
    writePrivateJsonLines(
      output,
      "companies.jsonl",
      run.companies,
    ),
    writePrivateJsonLines(output, "contacts.jsonl", contacts),
    writePrivateJsonLines(output, "evidence.jsonl", evidence),
    writePrivateJsonLines(output, "projects.jsonl", projects),
    writePrivateJsonLines(output, "held-matches.jsonl", run.heldMatches),
    writePrivateJsonLines(output, "held-companies.jsonl", run.heldCompanies),
    writePrivateJsonLines(
      output,
      "crm-comparisons.jsonl",
      run.crmComparisons,
    ),
    writePrivateJson(output, "review.json", review),
  ]);
}
