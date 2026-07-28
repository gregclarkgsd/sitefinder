import type {
  AttioPersonSnapshot,
  PipedrivePersonSnapshot,
  ReconciliationFinding,
} from "./types.js";
import {
  isBusinessEmail,
  normalizeEmail,
  sameCompanyName,
} from "./lib/normalize.js";

const STRUCTURED_DEPARTED_PATTERN =
  /\b(?:left|former|leaver|retired|departed|moved\s+on|no\s+longer|do\s+not\s+(?:use|contact))\b/iu;
const NOTE_DEPARTED_PATTERN =
  /\b(?:left\s+(?:the\s+)?(?:business|company|organisation|organization|firm|role|position|employment)|retired|departed|moved\s+on|no\s+longer\s+(?:with|at|employed)|do\s+not\s+(?:use|contact))\b/iu;

export interface ReconciliationReport {
  generatedAt: string;
  counts: Record<ReconciliationFinding["kind"], number>;
  findings: ReconciliationFinding[];
}

function departed(person: PipedrivePersonSnapshot): string | null {
  const structuredFields = [
    person.name,
    person.jobTitle,
    ...person.labels,
  ];
  return (
    structuredFields.find((value) =>
      STRUCTURED_DEPARTED_PATTERN.test(value),
    ) ??
    person.notes.find((value) => NOTE_DEPARTED_PATTERN.test(value)) ??
    null
  );
}

export function reconcilePeople(
  attio: AttioPersonSnapshot[],
  pipedrive: PipedrivePersonSnapshot[],
  attioCompanyNames: Map<string, string> = new Map(),
): ReconciliationReport {
  const findings: ReconciliationFinding[] = [];
  const attioByEmail = new Map<string, AttioPersonSnapshot[]>();
  const pipedriveByEmail = new Map<string, PipedrivePersonSnapshot[]>();

  for (const person of attio) {
    for (const email of person.emails.map(normalizeEmail).filter(Boolean)) {
      attioByEmail.set(email, [...(attioByEmail.get(email) ?? []), person]);
    }
  }
  for (const person of pipedrive) {
    for (const email of person.emails.map(normalizeEmail).filter(Boolean)) {
      pipedriveByEmail.set(email, [...(pipedriveByEmail.get(email) ?? []), person]);
    }
  }

  for (const [email, people] of attioByEmail) {
    if (people.length > 1) {
      for (const person of people) {
        findings.push({
          kind: "duplicate_email",
          email,
          attioRecordId: person.recordId,
          name: person.name,
          reason: `${people.length} Attio people share this email`,
        });
      }
    }
  }
  for (const [email, people] of pipedriveByEmail) {
    if (people.length > 1) {
      for (const person of people) {
        findings.push({
          kind: "duplicate_email",
          email,
          pipedrivePersonId: person.personId,
          name: person.name,
          reason: `${people.length} Pipedrive people share this email`,
        });
      }
    }
  }

  for (const person of pipedrive) {
    const staleEvidence = departed(person);
    if (staleEvidence) {
      findings.push({
        kind: "departed_or_stale",
        pipedrivePersonId: person.personId,
        name: person.name,
        ...(person.jobTitle ? { pipedriveJobTitle: person.jobTitle } : {}),
        ...(person.organizationName
          ? { pipedriveCompany: person.organizationName }
          : {}),
        reason: `Matched stale-contact indicator: ${staleEvidence}`,
      });
      continue;
    }

    const businessEmails = [
      ...new Set(person.emails.filter(isBusinessEmail).map(normalizeEmail)),
    ];
    if (businessEmails.length === 0) {
      findings.push({
        kind: "unusable",
        pipedrivePersonId: person.personId,
        name: person.name,
        ...(person.jobTitle ? { pipedriveJobTitle: person.jobTitle } : {}),
        reason: "No professional business email",
      });
      continue;
    }

    const attioMatchesByEmail = businessEmails.flatMap((email) =>
      (attioByEmail.get(email) ?? []).map((match) => ({ email, match })),
    );
    const attioMatches = [
      ...new Map(
        attioMatchesByEmail.map(({ match }) => [match.recordId, match]),
      ).values(),
    ];
    if (attioMatches.length === 0) {
      const email = businessEmails[0] ?? "";
      findings.push({
        kind: "pipedrive_only",
        email,
        pipedrivePersonId: person.personId,
        name: person.name,
        ...(person.jobTitle ? { pipedriveJobTitle: person.jobTitle } : {}),
        ...(person.organizationName
          ? { pipedriveCompany: person.organizationName }
          : {}),
        reason: "No Attio person has this business email",
      });
      continue;
    }
    if (attioMatches.length !== 1) continue;

    const match = attioMatches[0];
    if (!match) continue;
    const email =
      attioMatchesByEmail.find(
        ({ match: candidate }) => candidate.recordId === match.recordId,
      )?.email ?? businessEmails[0] ?? "";
    if (!match.jobTitle && person.jobTitle) {
      findings.push({
        kind: "recoverable_title",
        email,
        pipedrivePersonId: person.personId,
        attioRecordId: match.recordId,
        name: match.name || person.name,
        pipedriveJobTitle: person.jobTitle,
        ...(person.organizationName
          ? { pipedriveCompany: person.organizationName }
          : {}),
        reason: "Pipedrive has a title while Attio is blank",
      });
    }

    const attioCompany = match.companyRecordIds
      .map((id) => attioCompanyNames.get(id))
      .find((name): name is string => Boolean(name));
    if (
      attioCompany &&
      person.organizationName &&
      !sameCompanyName(attioCompany, person.organizationName)
    ) {
      findings.push({
        kind: "company_conflict",
        email,
        pipedrivePersonId: person.personId,
        attioRecordId: match.recordId,
        name: match.name || person.name,
        pipedriveCompany: person.organizationName,
        attioCompany,
        reason: "Matched email has different company associations",
      });
    }
  }

  const kinds: ReconciliationFinding["kind"][] = [
    "recoverable_title",
    "pipedrive_only",
    "company_conflict",
    "departed_or_stale",
    "duplicate_email",
    "unusable",
  ];
  return {
    generatedAt: new Date().toISOString(),
    counts: Object.fromEntries(
      kinds.map((kind) => [kind, findings.filter((item) => item.kind === kind).length]),
    ) as Record<ReconciliationFinding["kind"], number>,
    findings,
  };
}
