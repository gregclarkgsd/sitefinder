import {
  isBusinessEmail,
  normalizeEmail,
} from "../lib/normalize.js";
import type {
  AttioPersonSnapshot,
  ContactCandidate,
  PipedrivePersonSnapshot,
} from "../types.js";

export const DISCOVERY_COMPARISON_STATUSES = [
  "already_in_attio",
  "pipedrive_only",
  "missing_from_both",
  "conflicting_multiple_matches",
  "unverifiable_no_email",
] as const;

export type DiscoveryComparisonStatus =
  (typeof DISCOVERY_COMPARISON_STATUSES)[number];

export type DiscoveryComparisonReason =
  | "exact_attio_email_match"
  | "exact_pipedrive_email_match"
  | "no_crm_email_match"
  | "no_business_email"
  | "duplicate_crm_email_match"
  | "invalid_crm_record_identity"
  | "inconsistent_email_outcomes"
  | "inconsistent_attio_identity"
  | "inconsistent_pipedrive_identity";

/**
 * Safe to send to SiteFinder. The candidate ID is the worker's opaque key; no
 * email address, person name, title, or external CRM record ID crosses this
 * boundary.
 */
export interface SiteFinderDiscoveryComparison {
  candidateId: string;
  status: DiscoveryComparisonStatus;
}

export interface LocalDiscoveryEmailMatch {
  email: string;
  attioRecordIds: string[];
  pipedrivePersonIds: string[];
  attioSnapshotCount: number;
  pipedriveSnapshotCount: number;
}

/**
 * Private comparison evidence for local audit and review output only.
 */
export interface LocalDiscoveryComparison {
  candidateId: string;
  status: DiscoveryComparisonStatus;
  reason: DiscoveryComparisonReason;
  normalizedBusinessEmails: string[];
  emailMatches: LocalDiscoveryEmailMatch[];
}

export interface DiscoveryComparisonReport {
  siteFinder: SiteFinderDiscoveryComparison[];
  local: LocalDiscoveryComparison[];
  counts: Record<DiscoveryComparisonStatus, number>;
}

export interface DiscoveryComparator {
  compare(candidates: ContactCandidate[]): DiscoveryComparisonReport;
}

interface CrmEmailIndexEntry {
  ids: string[];
  snapshotCount: number;
  hasInvalidId: boolean;
}

type CrmEmailIndex = Map<string, CrmEmailIndexEntry>;

function isUsableBusinessEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value) && isBusinessEmail(value);
}

function normalizedBusinessEmails(values: string[]): string[] {
  return [
    ...new Set(
      values
        .map(normalizeEmail)
        .filter(isUsableBusinessEmail),
    ),
  ].sort();
}

function buildCrmEmailIndex<T>(
  snapshots: T[],
  getEmails: (snapshot: T) => string[],
  getId: (snapshot: T) => string,
): CrmEmailIndex {
  const matches = new Map<
    string,
    { ids: Set<string>; snapshotCount: number; hasInvalidId: boolean }
  >();

  for (const snapshot of snapshots) {
    const id = getId(snapshot).trim();
    for (const email of normalizedBusinessEmails(getEmails(snapshot))) {
      const current = matches.get(email) ?? {
        ids: new Set<string>(),
        snapshotCount: 0,
        hasInvalidId: false,
      };
      current.snapshotCount += 1;
      if (id) {
        current.ids.add(id);
      } else {
        current.hasInvalidId = true;
      }
      matches.set(email, current);
    }
  }

  return new Map(
    [...matches.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([email, entry]) => [
        email,
        {
          ids: [...entry.ids].sort(),
          snapshotCount: entry.snapshotCount,
          hasInvalidId: entry.hasInvalidId,
        },
      ]),
  );
}

function emailStatus(match: LocalDiscoveryEmailMatch): DiscoveryComparisonStatus {
  if (match.attioRecordIds.length === 1) return "already_in_attio";
  if (match.pipedrivePersonIds.length === 1) return "pipedrive_only";
  return "missing_from_both";
}

function distinctMatchedIds(
  matches: LocalDiscoveryEmailMatch[],
  key: "attioRecordIds" | "pipedrivePersonIds",
): string[] {
  return [...new Set(matches.flatMap((match) => match[key]))].sort();
}

function compareCandidate(
  candidate: ContactCandidate,
  attioByEmail: CrmEmailIndex,
  pipedriveByEmail: CrmEmailIndex,
): LocalDiscoveryComparison {
  const emails = normalizedBusinessEmails(
    candidate.emails.map(({ value }) => value),
  );
  if (emails.length === 0) {
    return {
      candidateId: candidate.id,
      status: "unverifiable_no_email",
      reason: "no_business_email",
      normalizedBusinessEmails: [],
      emailMatches: [],
    };
  }

  let hasInvalidIdentity = false;
  const emailMatches = emails.map((email): LocalDiscoveryEmailMatch => {
    const attio = attioByEmail.get(email);
    const pipedrive = pipedriveByEmail.get(email);
    if (attio?.hasInvalidId || pipedrive?.hasInvalidId) {
      hasInvalidIdentity = true;
    }
    return {
      email,
      attioRecordIds: attio?.ids ?? [],
      pipedrivePersonIds: pipedrive?.ids ?? [],
      attioSnapshotCount: attio?.snapshotCount ?? 0,
      pipedriveSnapshotCount: pipedrive?.snapshotCount ?? 0,
    };
  });

  if (hasInvalidIdentity) {
    return {
      candidateId: candidate.id,
      status: "conflicting_multiple_matches",
      reason: "invalid_crm_record_identity",
      normalizedBusinessEmails: emails,
      emailMatches,
    };
  }

  if (
    emailMatches.some(
      (match) =>
        match.attioRecordIds.length > 1 ||
        match.pipedrivePersonIds.length > 1,
    )
  ) {
    return {
      candidateId: candidate.id,
      status: "conflicting_multiple_matches",
      reason: "duplicate_crm_email_match",
      normalizedBusinessEmails: emails,
      emailMatches,
    };
  }

  const perEmailStatuses = new Set(emailMatches.map(emailStatus));
  if (perEmailStatuses.size !== 1) {
    return {
      candidateId: candidate.id,
      status: "conflicting_multiple_matches",
      reason: "inconsistent_email_outcomes",
      normalizedBusinessEmails: emails,
      emailMatches,
    };
  }

  if (distinctMatchedIds(emailMatches, "attioRecordIds").length > 1) {
    return {
      candidateId: candidate.id,
      status: "conflicting_multiple_matches",
      reason: "inconsistent_attio_identity",
      normalizedBusinessEmails: emails,
      emailMatches,
    };
  }

  if (distinctMatchedIds(emailMatches, "pipedrivePersonIds").length > 1) {
    return {
      candidateId: candidate.id,
      status: "conflicting_multiple_matches",
      reason: "inconsistent_pipedrive_identity",
      normalizedBusinessEmails: emails,
      emailMatches,
    };
  }

  const status = emailStatus(emailMatches[0]!);
  const reason: DiscoveryComparisonReason =
    status === "already_in_attio"
      ? "exact_attio_email_match"
      : status === "pipedrive_only"
        ? "exact_pipedrive_email_match"
        : "no_crm_email_match";
  return {
    candidateId: candidate.id,
    status,
    reason,
    normalizedBusinessEmails: emails,
    emailMatches,
  };
}

/**
 * Compare researched contacts with read-only CRM snapshots by exact normalized
 * business email. Inputs are never mutated and output ordering follows the
 * candidate input ordering.
 */
export function compareContactDiscoveries(
  candidates: ContactCandidate[],
  attio: AttioPersonSnapshot[],
  pipedrive: PipedrivePersonSnapshot[],
): DiscoveryComparisonReport {
  return createDiscoveryComparator(attio, pipedrive).compare(candidates);
}

export function createDiscoveryComparator(
  attio: AttioPersonSnapshot[],
  pipedrive: PipedrivePersonSnapshot[],
): DiscoveryComparator {
  const attioByEmail = buildCrmEmailIndex(
    attio,
    (person) => person.emails,
    (person) => person.recordId,
  );
  const pipedriveByEmail = buildCrmEmailIndex(
    pipedrive,
    (person) => person.emails,
    (person) => person.personId,
  );
  return {
    compare(candidates) {
      const local = candidates.map((candidate) =>
        compareCandidate(candidate, attioByEmail, pipedriveByEmail),
      );
      const siteFinder = local.map(
        ({ candidateId, status }): SiteFinderDiscoveryComparison => ({
          candidateId,
          status,
        }),
      );
      const counts = Object.fromEntries(
        DISCOVERY_COMPARISON_STATUSES.map((status) => [
          status,
          local.filter((item) => item.status === status).length,
        ]),
      ) as Record<DiscoveryComparisonStatus, number>;

      return { siteFinder, local, counts };
    },
  };
}
