import { stableId } from "../lib/normalize.js";
import type {
  AttioPersonSnapshot,
  CompanySeed,
  ContactCandidate,
  EnrichedCompany,
} from "../types.js";
import { normalizeEmail } from "../lib/normalize.js";
import {
  evaluateCleanupPolicy,
  type CleanupDecision,
  type CleanupDisposition,
  type CleanupLookup,
  type CleanupPolicyOutcome,
} from "./cleanup-policy.js";

export interface HeldCleanupMatch {
  id: string;
  companyId: string;
  contactId?: string;
  kind: "company" | "contact" | "email";
  disposition: Exclude<CleanupDisposition, "allow">;
  name?: string;
  jobTitle?: string;
  email?: string;
  directives: CleanupPolicyOutcome["directives"];
  matchedDecisionIds: string[];
  evidenceIds: string[];
  reason?: "missing_durable_person_identifier";
}

export interface CleanupFilteredCompany {
  result: EnrichedCompany;
  heldMatches: HeldCleanupMatch[];
}

export interface HeldCleanupCompany {
  companyId: string;
  name: string;
  domain: string;
  disposition: Exclude<CleanupDisposition, "allow">;
  directives: CleanupPolicyOutcome["directives"];
  matchedDecisionIds: string[];
}

function companyLookups(company: CompanySeed): CleanupLookup[] {
  const base = {
    ...(company.companyNumber ? { companyNumber: company.companyNumber } : {}),
    companyDomain: company.domain,
  };
  const attioRecordIds = [
    ...new Set([
      ...(company.sourceIds?.attio ?? []),
      ...(company.source === "attio" && company.sourceRecordId
        ? [company.sourceRecordId]
        : []),
    ]),
  ].sort();
  return attioRecordIds.length > 0
    ? attioRecordIds.map((companyAttioRecordId) => ({
        ...base,
        companyAttioRecordId,
      }))
    : [base];
}

const DISPOSITION_RANK: Record<CleanupDisposition, number> = {
  allow: 0,
  redirected_match: 1,
  hold_for_review: 2,
  suppressed_match: 3,
};

function strongestCleanupOutcome(
  outcomes: CleanupPolicyOutcome[],
  companyId: string,
): CleanupPolicyOutcome {
  const first = outcomes[0];
  if (!first) {
    throw new Error(`No cleanup lookup could be built for company ${companyId}`);
  }
  return outcomes.reduce((strongest, outcome) =>
    DISPOSITION_RANK[outcome.disposition] >
    DISPOSITION_RANK[strongest.disposition]
      ? outcome
      : strongest,
  first);
}

function evaluateCompanyCleanupPolicy(
  decisions: CleanupDecision[],
  company: CompanySeed,
  extra: Pick<CleanupLookup, "email" | "personAttioRecordId"> = {},
): CleanupPolicyOutcome {
  const outcomes = companyLookups(company).map((lookup) =>
    evaluateCleanupPolicy(decisions, { ...lookup, ...extra }),
  );
  return strongestCleanupOutcome(outcomes, company.id);
}

export type CleanupPersonIdentityIndex = ReadonlyMap<
  string,
  readonly string[]
>;

export function indexAttioPeopleForCleanup(
  people: AttioPersonSnapshot[],
): CleanupPersonIdentityIndex {
  const idsByEmail = new Map<string, Set<string>>();
  for (const person of people) {
    const recordId = person.recordId.trim();
    if (!recordId) continue;
    for (const rawEmail of person.emails) {
      const email = normalizeEmail(rawEmail);
      if (!email || !email.includes("@")) continue;
      const ids = idsByEmail.get(email) ?? new Set<string>();
      ids.add(recordId);
      idsByEmail.set(email, ids);
    }
  }
  return new Map(
    [...idsByEmail.entries()].map(([email, ids]) => [
      email,
      [...ids].sort(),
    ]),
  );
}

function evaluateContactCleanupPolicy(
  decisions: CleanupDecision[],
  company: CompanySeed,
  email: string,
  personIndex: CleanupPersonIdentityIndex,
): CleanupPolicyOutcome {
  const normalized = normalizeEmail(email);
  const personIds = personIndex.get(normalized) ?? [];
  const outcomes =
    personIds.length > 0
      ? personIds.map((personAttioRecordId) =>
          evaluateCompanyCleanupPolicy(decisions, company, {
            email: normalized,
            personAttioRecordId,
          }),
        )
      : [
          evaluateCompanyCleanupPolicy(decisions, company, {
            email: normalized,
          }),
        ];
  return strongestCleanupOutcome(outcomes, company.id);
}

function redirectAlreadyResolvesInsideCompany(
  company: CompanySeed,
  outcome: CleanupPolicyOutcome,
): boolean {
  const target = outcome.merge?.companyAttioRecordId;
  return (
    outcome.disposition === "redirected_match" &&
    Boolean(target && company.sourceIds?.attio?.includes(target)) &&
    !outcome.merge?.personAttioRecordId &&
    outcome.company === "allow" &&
    outcome.contact === "allow" &&
    outcome.employment === "allow" &&
    outcome.conflicts.length === 0
  );
}

export function partitionCompaniesByCleanupPolicy(
  companies: CompanySeed[],
  decisions: CleanupDecision[],
): { allowed: CompanySeed[]; held: HeldCleanupCompany[] } {
  if (decisions.length === 0) return { allowed: companies, held: [] };
  const allowed: CompanySeed[] = [];
  const held: HeldCleanupCompany[] = [];
  for (const company of companies) {
    const outcome = evaluateCompanyCleanupPolicy(decisions, company);
    if (
      outcome.disposition === "allow" ||
      redirectAlreadyResolvesInsideCompany(company, outcome)
    ) {
      allowed.push(company);
      continue;
    }
    held.push({
      companyId: company.id,
      name: company.name,
      domain: company.domain,
      disposition: outcome.disposition,
      directives: outcome.directives,
      matchedDecisionIds: outcome.matchedDecisionIds,
    });
  }
  return { allowed, held };
}

function heldCompany(
  company: CompanySeed,
  outcome: CleanupPolicyOutcome,
): HeldCleanupMatch {
  return {
    id: stableId(
      "cleanup-company-match",
      company.id,
      ...outcome.matchedDecisionIds,
    ),
    companyId: company.id,
    kind: "company",
    disposition:
      outcome.disposition === "allow"
        ? "hold_for_review"
        : outcome.disposition,
    directives: outcome.directives,
    matchedDecisionIds: outcome.matchedDecisionIds,
    evidenceIds: [],
  };
}

function heldContact(
  contact: ContactCandidate,
  outcome: CleanupPolicyOutcome,
  email?: string,
  kind: HeldCleanupMatch["kind"] = "contact",
): HeldCleanupMatch {
  return {
    id: stableId(
      "cleanup-contact-match",
      contact.companyId,
      contact.id,
      email ?? "",
      ...outcome.matchedDecisionIds,
    ),
    companyId: contact.companyId,
    contactId: contact.id,
    kind,
    disposition:
      outcome.disposition === "allow"
        ? "hold_for_review"
        : outcome.disposition,
    name: contact.name,
    jobTitle: contact.jobTitle,
    ...(email ? { email } : {}),
    directives: outcome.directives,
    matchedDecisionIds: outcome.matchedDecisionIds,
    evidenceIds: contact.evidenceIds,
  };
}

function heldContactWithoutDurableIdentifier(
  contact: ContactCandidate,
): HeldCleanupMatch {
  return {
    id: stableId(
      "cleanup-unverifiable-contact",
      contact.companyId,
      contact.id,
    ),
    companyId: contact.companyId,
    contactId: contact.id,
    kind: "contact",
    disposition: "hold_for_review",
    name: contact.name,
    jobTitle: contact.jobTitle,
    directives: ["hold"],
    matchedDecisionIds: [],
    evidenceIds: contact.evidenceIds,
    reason: "missing_durable_person_identifier",
  };
}

function shouldHoldWholeContact(outcome: CleanupPolicyOutcome): boolean {
  return (
    outcome.disposition === "hold_for_review" ||
    outcome.disposition === "redirected_match" ||
    outcome.company !== "allow" ||
    outcome.employment !== "allow" ||
    outcome.contact === "hold" ||
    outcome.contact === "do_not_reimport" ||
    outcome.contact === "do_not_contact"
  );
}

function applyContactPolicy(
  company: CompanySeed,
  contact: ContactCandidate,
  decisions: CleanupDecision[],
  personIndex: CleanupPersonIdentityIndex,
): { contact: ContactCandidate | null; heldMatches: HeldCleanupMatch[] } {
  const heldMatches: HeldCleanupMatch[] = [];
  const retainedEmails = [];

  if (contact.emails.length === 0) {
    // Names are not safe identity keys. Until there is an exact email (or a
    // future reviewed external-person ID), the worker cannot prove that this
    // discovery is distinct from a quarantined, merged, opted-out, or former
    // Attio record.
    return {
      contact: null,
      heldMatches: [heldContactWithoutDurableIdentifier(contact)],
    };
  }

  for (const point of contact.emails) {
    const outcome = evaluateContactCleanupPolicy(
      decisions,
      company,
      point.value,
      personIndex,
    );
    if (
      shouldHoldWholeContact(outcome) &&
      !redirectAlreadyResolvesInsideCompany(company, outcome)
    ) {
      return {
        contact: null,
        heldMatches: [heldContact(contact, outcome, point.value)],
      };
    }
    if (outcome.contact === "invalid_address") {
      heldMatches.push(heldContact(contact, outcome, point.value, "email"));
      continue;
    }
    retainedEmails.push(point);
  }

  return {
    contact:
      retainedEmails.length === contact.emails.length
        ? contact
        : { ...contact, emails: retainedEmails },
    heldMatches,
  };
}

export function applyCleanupPolicyToCompany(
  result: EnrichedCompany,
  decisions: CleanupDecision[],
  personIndex: CleanupPersonIdentityIndex = new Map(),
): CleanupFilteredCompany {
  if (decisions.length === 0) return { result, heldMatches: [] };

  const companyOutcome = evaluateCompanyCleanupPolicy(
    decisions,
    result.company,
  );
  if (
    companyOutcome.disposition !== "allow" &&
    !redirectAlreadyResolvesInsideCompany(result.company, companyOutcome)
  ) {
    return {
      result: {
        ...result,
        contacts: [],
        warnings: [
          ...result.warnings,
          "Cleanup policy held this company and withheld every discovered identity.",
        ],
      },
      heldMatches: [heldCompany(result.company, companyOutcome)],
    };
  }

  const contacts: ContactCandidate[] = [];
  const heldMatches: HeldCleanupMatch[] = [];
  for (const contact of result.contacts) {
    const filtered = applyContactPolicy(
      result.company,
      contact,
      decisions,
      personIndex,
    );
    if (filtered.contact) contacts.push(filtered.contact);
    heldMatches.push(...filtered.heldMatches);
  }
  if (heldMatches.length === 0) return { result, heldMatches };
  return {
    result: {
      ...result,
      contacts,
      warnings: [
        ...result.warnings,
        `Cleanup policy held ${heldMatches.length} discovered identity or contact-point match${heldMatches.length === 1 ? "" : "es"}.`,
      ],
    },
    heldMatches,
  };
}
