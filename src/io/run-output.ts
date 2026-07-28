import { resolve } from "node:path";
import type { EnrichmentRun } from "../pipeline/enrich.js";
import {
  writePrivateJson,
  writePrivateJsonLines,
} from "./private-files.js";

export async function writeEnrichmentRun(
  outputDirectory: string,
  run: EnrichmentRun,
): Promise<void> {
  const contacts = run.companies.flatMap((company) => company.contacts);
  const evidence = run.companies.flatMap((company) => company.evidence);
  const projects = run.companies.flatMap((company) => company.projects);
  const review = contacts
    .filter(
      (contact) =>
        contact.confidence < 0.85 ||
        contact.employmentStatus !== "current" ||
        contact.emails.length === 0,
    )
    .map((contact) => ({
      contactId: contact.id,
      companyId: contact.companyId,
      name: contact.name,
      jobTitle: contact.jobTitle,
      confidence: contact.confidence,
      employmentStatus: contact.employmentStatus,
      reasons: [
        ...(contact.confidence < 0.85 ? ["low_confidence"] : []),
        ...(contact.employmentStatus !== "current"
          ? ["employment_not_confirmed"]
          : []),
        ...(contact.emails.length === 0 ? ["no_public_email"] : []),
      ],
      evidenceIds: contact.evidenceIds,
    }));

  await Promise.all([
    writePrivateJson(resolve(outputDirectory, "summary.json"), {
      mode: run.mode,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      companyCount: run.companyCount,
      contactCount: run.contactCount,
      evidenceCount: run.evidenceCount,
      projectSignalCount: run.projectSignalCount,
      reviewCount: review.length,
      warningCount: run.companies.reduce(
        (total, company) => total + company.warnings.length,
        0,
      ),
    }),
    writePrivateJsonLines(
      resolve(outputDirectory, "companies.jsonl"),
      run.companies,
    ),
    writePrivateJsonLines(resolve(outputDirectory, "contacts.jsonl"), contacts),
    writePrivateJsonLines(resolve(outputDirectory, "evidence.jsonl"), evidence),
    writePrivateJsonLines(resolve(outputDirectory, "projects.jsonl"), projects),
    writePrivateJson(resolve(outputDirectory, "review.json"), review),
  ]);
}
