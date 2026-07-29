import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { extname } from "node:path";
import { z } from "zod";
import {
  canonicalDomain,
  isBusinessEmail,
  normalizeEmail,
} from "../lib/normalize.js";

export const CLEANUP_CLASSIFICATIONS = [
  "legitimate",
  "unresolved",
  "junk_sender",
  "irrelevant_contact",
  "irrelevant_company",
  "duplicate_record",
  "former_employee",
  "invalid_address",
  "opted_out",
] as const;

export const CLEANUP_DIRECTIVES = [
  "no_change",
  "hold",
  "do_not_reimport",
  "do_not_contact",
  "invalid_address",
  "former_employee",
  "merged_into",
  "irrelevant_company",
] as const;

export const CLEANUP_STATUSES = ["quarantined", "approved"] as const;

export type CleanupClassification =
  (typeof CLEANUP_CLASSIFICATIONS)[number];
export type CleanupDirective = (typeof CLEANUP_DIRECTIVES)[number];
export type CleanupStatus = (typeof CLEANUP_STATUSES)[number];

const identifierSchema = z.string().trim().min(1).max(256);
const decisionIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const emailSchema = z
  .string()
  .trim()
  .pipe(z.email())
  .transform((value) => normalizeEmail(value));
const companyNumberSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .transform((value, context): string => {
    const compact = value.toUpperCase().replace(/[^A-Z0-9]/gu, "");
    if (/^\d{1,8}$/u.test(compact)) return compact.padStart(8, "0");
    if (/^[A-Z]{2}\d{6}$/u.test(compact)) return compact;
    context.addIssue({
      code: "custom",
      message: "Expected a normalized UK company number",
    });
    return z.NEVER;
  });
const domainSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .transform((value, context): string => {
    const domain = canonicalDomain(value);
    if (!domain || !domain.includes(".") || isIP(domain) !== 0) {
      context.addIssue({
        code: "custom",
        message: "Expected a valid registrable company domain",
      });
      return z.NEVER;
    }
    if (!isBusinessEmail(`cleanup-policy@${domain}`)) {
      context.addIssue({
        code: "custom",
        message: "Public email-provider domains cannot identify a company",
      });
      return z.NEVER;
    }
    return domain;
  });

const personSubjectSchema = z
  .object({
    kind: z.literal("person"),
    attioRecordId: identifierSchema.optional(),
    email: emailSchema.optional(),
  })
  .strict()
  .refine(
    (subject) => Boolean(subject.attioRecordId || subject.email),
    "A person subject requires an Attio record ID or email",
  );

const emailSubjectSchema = z
  .object({
    kind: z.literal("email"),
    email: emailSchema,
  })
  .strict();

const companySubjectSchema = z
  .object({
    kind: z.literal("company"),
    attioRecordId: identifierSchema.optional(),
    companyNumber: companyNumberSchema.optional(),
    domain: domainSchema.optional(),
  })
  .strict()
  .refine(
    (subject) =>
      Boolean(
        subject.attioRecordId || subject.companyNumber || subject.domain,
      ),
    "A company subject requires an Attio record ID, company number or domain",
  );

const employmentSubjectSchema = z
  .object({
    kind: z.literal("employment"),
    personAttioRecordId: identifierSchema.optional(),
    email: emailSchema.optional(),
    companyAttioRecordId: identifierSchema.optional(),
    companyNumber: companyNumberSchema.optional(),
    companyDomain: domainSchema.optional(),
  })
  .strict()
  .refine(
    (subject) => Boolean(subject.personAttioRecordId || subject.email),
    "An employment subject requires a person Attio record ID or email",
  )
  .refine(
    (subject) =>
      Boolean(
        subject.companyAttioRecordId ||
          subject.companyNumber ||
          subject.companyDomain,
      ),
    "An employment subject requires a company Attio record ID, company number or domain",
  );

export const cleanupSubjectSchema = z.discriminatedUnion("kind", [
  personSubjectSchema,
  emailSubjectSchema,
  companySubjectSchema,
  employmentSubjectSchema,
]);

export type CleanupSubject = z.infer<typeof cleanupSubjectSchema>;

const EXPECTED_DIRECTIVE: Record<
  CleanupClassification,
  CleanupDirective
> = {
  legitimate: "no_change",
  unresolved: "hold",
  junk_sender: "do_not_reimport",
  irrelevant_contact: "do_not_reimport",
  irrelevant_company: "irrelevant_company",
  duplicate_record: "merged_into",
  former_employee: "former_employee",
  invalid_address: "invalid_address",
  opted_out: "do_not_contact",
};

const EXPECTED_STATUS: Record<CleanupClassification, CleanupStatus> = {
  legitimate: "approved",
  unresolved: "quarantined",
  junk_sender: "approved",
  irrelevant_contact: "approved",
  irrelevant_company: "approved",
  duplicate_record: "approved",
  former_employee: "approved",
  invalid_address: "approved",
  opted_out: "approved",
};

export const cleanupDecisionSchema = z
  .object({
    schemaVersion: z.literal(1),
    decisionId: decisionIdSchema,
    status: z.enum(CLEANUP_STATUSES),
    classification: z.enum(CLEANUP_CLASSIFICATIONS),
    directive: z.enum(CLEANUP_DIRECTIVES),
    subject: cleanupSubjectSchema,
    replacementAttioRecordId: identifierSchema.optional(),
    supersedesDecisionId: decisionIdSchema.optional(),
    reason: z.string().trim().min(3).max(2_000),
    reviewedBy: z.string().trim().min(1).max(256),
    decidedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((decision, context) => {
    const expectedDirective = EXPECTED_DIRECTIVE[decision.classification];
    if (decision.directive !== expectedDirective) {
      context.addIssue({
        code: "custom",
        path: ["directive"],
        message: `Classification ${decision.classification} requires directive ${expectedDirective}`,
      });
    }

    const expectedStatus = EXPECTED_STATUS[decision.classification];
    if (decision.status !== expectedStatus) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: `Classification ${decision.classification} requires status ${expectedStatus}`,
      });
    }

    const allowedKinds: Record<CleanupDirective, CleanupSubject["kind"][]> = {
      no_change: ["person", "email", "company", "employment"],
      hold: ["person", "email", "company", "employment"],
      do_not_reimport: ["person", "email"],
      do_not_contact: ["person", "email"],
      invalid_address: ["email"],
      former_employee: ["employment"],
      merged_into: ["person", "company"],
      irrelevant_company: ["company"],
    };
    if (!allowedKinds[decision.directive].includes(decision.subject.kind)) {
      context.addIssue({
        code: "custom",
        path: ["subject", "kind"],
        message: `Directive ${decision.directive} cannot target a ${decision.subject.kind} subject`,
      });
    }

    if (decision.directive === "merged_into") {
      if (!decision.replacementAttioRecordId) {
        context.addIssue({
          code: "custom",
          path: ["replacementAttioRecordId"],
          message: "A merge decision requires a replacement Attio record ID",
        });
      }
      if (
        decision.subject.kind === "person" ||
        decision.subject.kind === "company"
      ) {
        if (!decision.subject.attioRecordId) {
          context.addIssue({
            code: "custom",
            path: ["subject", "attioRecordId"],
            message: "A merge source requires an Attio record ID",
          });
        } else if (
          decision.replacementAttioRecordId ===
          decision.subject.attioRecordId
        ) {
          context.addIssue({
            code: "custom",
            path: ["replacementAttioRecordId"],
            message: "A merge replacement must differ from its source",
          });
        }
      }
    } else if (decision.replacementAttioRecordId) {
      context.addIssue({
        code: "custom",
        path: ["replacementAttioRecordId"],
        message: "Only merge decisions may name a replacement Attio record",
      });
    }
  });

export type CleanupDecision = z.infer<typeof cleanupDecisionSchema>;

const cleanupLedgerEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    decisions: z.array(z.unknown()),
  })
  .strict();

function subjectKey(subject: CleanupSubject): string {
  switch (subject.kind) {
    case "person":
      return [
        subject.kind,
        subject.attioRecordId ?? "",
        subject.email ?? "",
      ].join("\u001f");
    case "email":
      return [subject.kind, subject.email].join("\u001f");
    case "company":
      return [
        subject.kind,
        subject.attioRecordId ?? "",
        subject.companyNumber ?? "",
        subject.domain ?? "",
      ].join("\u001f");
    case "employment":
      return [
        subject.kind,
        subject.personAttioRecordId ?? "",
        subject.email ?? "",
        subject.companyAttioRecordId ?? "",
        subject.companyNumber ?? "",
        subject.companyDomain ?? "",
      ].join("\u001f");
  }
}

export function validateCleanupDecisionLedger(
  decisions: CleanupDecision[],
): CleanupDecision[] {
  const byId = new Map<string, { decision: CleanupDecision; index: number }>();
  const supersededBy = new Map<string, string>();

  for (const [index, decision] of decisions.entries()) {
    const priorWithId = byId.get(decision.decisionId);
    if (priorWithId) {
      throw new Error(
        `Duplicate cleanup decision ID ${decision.decisionId} at rows ${priorWithId.index + 1} and ${index + 1}`,
      );
    }

    if (decision.supersedesDecisionId) {
      const previous = byId.get(decision.supersedesDecisionId);
      if (!previous) {
        throw new Error(
          `Cleanup decision ${decision.decisionId} supersedes a missing or later decision ${decision.supersedesDecisionId}`,
        );
      }
      if (subjectKey(previous.decision.subject) !== subjectKey(decision.subject)) {
        throw new Error(
          `Cleanup decision ${decision.decisionId} cannot supersede a different subject`,
        );
      }
      if (
        Date.parse(decision.decidedAt) <=
        Date.parse(previous.decision.decidedAt)
      ) {
        throw new Error(
          `Cleanup decision ${decision.decisionId} must be later than ${decision.supersedesDecisionId}`,
        );
      }
      if (
        decision.directive === "no_change" &&
        !["hold", "no_change"].includes(previous.decision.directive)
      ) {
        throw new Error(
          `Cleanup decision ${decision.decisionId} cannot weaken ${previous.decision.directive}; suppression removal requires a separate privileged process`,
        );
      }
      const existingReplacement = supersededBy.get(
        decision.supersedesDecisionId,
      );
      if (existingReplacement) {
        throw new Error(
          `Cleanup decision ${decision.supersedesDecisionId} is already superseded by ${existingReplacement}`,
        );
      }
      supersededBy.set(decision.supersedesDecisionId, decision.decisionId);
    }

    byId.set(decision.decisionId, { decision, index });
  }

  const activeBySubject = new Map<string, CleanupDecision>();
  for (const decision of decisions) {
    if (supersededBy.has(decision.decisionId)) continue;
    const key = subjectKey(decision.subject);
    const active = activeBySubject.get(key);
    if (active) {
      throw new Error(
        `Cleanup subject has conflicting active decisions ${active.decisionId} and ${decision.decisionId}; use supersedesDecisionId`,
      );
    }
    activeBySubject.set(key, decision);
  }

  const mergeGraphs = {
    person: new Map<string, string>(),
    company: new Map<string, string>(),
  };
  for (const decision of activeBySubject.values()) {
    if (
      decision.directive !== "merged_into" ||
      !decision.replacementAttioRecordId ||
      (decision.subject.kind !== "person" &&
        decision.subject.kind !== "company") ||
      !decision.subject.attioRecordId
    ) {
      continue;
    }
    mergeGraphs[decision.subject.kind].set(
      decision.subject.attioRecordId,
      decision.replacementAttioRecordId,
    );
  }
  for (const [kind, graph] of Object.entries(mergeGraphs)) {
    for (const source of graph.keys()) {
      const seen = new Set<string>();
      let current: string | undefined = source;
      while (current && graph.has(current)) {
        if (seen.has(current)) {
          throw new Error(
            `Cleanup ${kind} merge graph contains a cycle at ${current}`,
          );
        }
        seen.add(current);
        current = graph.get(current);
      }
    }
  }

  return decisions;
}

export function parseCleanupDecisionLedger(input: unknown): CleanupDecision[] {
  const rows = Array.isArray(input)
    ? input
    : cleanupLedgerEnvelopeSchema.parse(input).decisions;
  const decisions = z.array(cleanupDecisionSchema).parse(rows);
  return validateCleanupDecisionLedger(decisions);
}

function parseJsonLines(contents: string, path: string): unknown[] {
  const rows: unknown[] = [];
  for (const [index, line] of contents.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as unknown);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown JSON parse error";
      throw new Error(
        `Invalid JSONL in ${path} at line ${index + 1}: ${message}`,
      );
    }
  }
  return rows;
}

export async function loadCleanupDecisionLedger(
  path: string,
): Promise<CleanupDecision[]> {
  const contents = await readFile(path, "utf8");
  return parseCleanupDecisionLedgerContents(contents, path);
}

export function parseCleanupDecisionLedgerContents(
  contents: string,
  path: string,
): CleanupDecision[] {
  switch (extname(path).toLowerCase()) {
    case ".json":
      try {
        return parseCleanupDecisionLedger(JSON.parse(contents) as unknown);
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new Error(`Invalid JSON in ${path}: ${error.message}`);
        }
        throw error;
      }
    case ".jsonl":
    case ".ndjson":
      return parseCleanupDecisionLedger(parseJsonLines(contents, path));
    default:
      throw new Error(
        `Unsupported cleanup ledger format for ${path}; expected .json, .jsonl or .ndjson`,
      );
  }
}

export const cleanupLookupSchema = z
  .object({
    personAttioRecordId: identifierSchema.optional(),
    email: emailSchema.optional(),
    companyAttioRecordId: identifierSchema.optional(),
    companyNumber: companyNumberSchema.optional(),
    companyDomain: domainSchema.optional(),
  })
  .strict()
  .refine(
    (lookup) =>
      Boolean(
        lookup.personAttioRecordId ||
          lookup.email ||
          lookup.companyAttioRecordId ||
          lookup.companyNumber ||
          lookup.companyDomain,
      ),
    "A cleanup lookup requires at least one person, email or company identifier",
  );

export type CleanupLookup = z.infer<typeof cleanupLookupSchema>;

export type CleanupDisposition =
  | "allow"
  | "hold_for_review"
  | "suppressed_match"
  | "redirected_match";

export interface CleanupPolicyOutcome {
  disposition: CleanupDisposition;
  company: "allow" | "hold" | "irrelevant_company";
  contact:
    | "allow"
    | "hold"
    | "do_not_reimport"
    | "invalid_address"
    | "do_not_contact";
  employment: "allow" | "hold" | "former_employee";
  merge: {
    personAttioRecordId?: string;
    companyAttioRecordId?: string;
  } | null;
  directives: CleanupDirective[];
  matchedDecisionIds: string[];
  conflicts: string[];
}

function personMatches(
  subject: {
    personAttioRecordId?: string;
    email?: string;
  },
  lookup: CleanupLookup,
): boolean {
  const recordIdMatches = Boolean(
    subject.personAttioRecordId &&
      lookup.personAttioRecordId &&
      subject.personAttioRecordId === lookup.personAttioRecordId,
  );
  const emailMatches = Boolean(
    subject.email && lookup.email && subject.email === lookup.email,
  );
  // Email is the durable identity when an Attio record has been deleted and
  // recreated. A changed record ID must never reactivate an opt-out or other
  // person-level suppression tied to the same exact address.
  return recordIdMatches || emailMatches;
}

function companyMatches(
  subject: {
    companyAttioRecordId?: string;
    companyNumber?: string;
    companyDomain?: string;
  },
  lookup: CleanupLookup,
): boolean {
  if (
    subject.companyAttioRecordId &&
    lookup.companyAttioRecordId &&
    subject.companyAttioRecordId === lookup.companyAttioRecordId
  ) {
    return true;
  }
  if (
    subject.companyNumber &&
    lookup.companyNumber &&
    subject.companyNumber === lookup.companyNumber
  ) {
    return true;
  }
  // A domain can be shared by multiple subsidiaries. When two explicit Attio
  // IDs disagree, domain equality alone is not enough to identify the company.
  if (
    subject.companyAttioRecordId &&
    lookup.companyAttioRecordId &&
    subject.companyAttioRecordId !== lookup.companyAttioRecordId
  ) {
    return false;
  }
  return Boolean(
    subject.companyDomain &&
      lookup.companyDomain &&
      subject.companyDomain === lookup.companyDomain,
  );
}

function subjectMatches(
  subject: CleanupSubject,
  lookup: CleanupLookup,
): boolean {
  switch (subject.kind) {
    case "person":
      return personMatches(
        {
          ...(subject.attioRecordId
            ? { personAttioRecordId: subject.attioRecordId }
            : {}),
          ...(subject.email ? { email: subject.email } : {}),
        },
        lookup,
      );
    case "email":
      return Boolean(lookup.email && lookup.email === subject.email);
    case "company":
      return companyMatches(
        {
          ...(subject.attioRecordId
            ? { companyAttioRecordId: subject.attioRecordId }
            : {}),
          ...(subject.companyNumber
            ? { companyNumber: subject.companyNumber }
            : {}),
          ...(subject.domain ? { companyDomain: subject.domain } : {}),
        },
        lookup,
      );
    case "employment":
      return (
        personMatches(
          {
            ...(subject.personAttioRecordId
              ? { personAttioRecordId: subject.personAttioRecordId }
              : {}),
            ...(subject.email ? { email: subject.email } : {}),
          },
          lookup,
        ) &&
        companyMatches(
          {
            ...(subject.companyAttioRecordId
              ? { companyAttioRecordId: subject.companyAttioRecordId }
              : {}),
            ...(subject.companyNumber
              ? { companyNumber: subject.companyNumber }
              : {}),
            ...(subject.companyDomain
              ? { companyDomain: subject.companyDomain }
              : {}),
          },
          lookup,
        )
      );
  }
}

const DIRECTIVE_ORDER: Record<CleanupDirective, number> = {
  no_change: 0,
  hold: 1,
  merged_into: 2,
  former_employee: 3,
  do_not_reimport: 4,
  invalid_address: 5,
  do_not_contact: 6,
  irrelevant_company: 7,
};

const CONTACT_ORDER: Record<CleanupPolicyOutcome["contact"], number> = {
  allow: 0,
  hold: 1,
  do_not_reimport: 2,
  invalid_address: 3,
  do_not_contact: 4,
};

function maxContactDirective(
  current: CleanupPolicyOutcome["contact"],
  next: CleanupPolicyOutcome["contact"],
): CleanupPolicyOutcome["contact"] {
  return CONTACT_ORDER[next] > CONTACT_ORDER[current] ? next : current;
}

function activeMergeGraph(
  decisions: CleanupDecision[],
  kind: "person" | "company",
): Map<string, string> {
  const supersededIds = new Set(
    decisions
      .map((decision) => decision.supersedesDecisionId)
      .filter((id): id is string => Boolean(id)),
  );
  return new Map(
    decisions.flatMap((decision) => {
      if (
        supersededIds.has(decision.decisionId) ||
        decision.directive !== "merged_into" ||
        decision.subject.kind !== kind ||
        !decision.subject.attioRecordId ||
        !decision.replacementAttioRecordId
      ) {
        return [];
      }
      return [
        [
          decision.subject.attioRecordId,
          decision.replacementAttioRecordId,
        ] as const,
      ];
    }),
  );
}

function finalMergeTarget(
  graph: Map<string, string>,
  initialTarget: string,
): string {
  let target = initialTarget;
  while (graph.has(target)) {
    target = graph.get(target) ?? target;
  }
  return target;
}

export function evaluateCleanupPolicy(
  decisionsInput: CleanupDecision[],
  lookupInput: CleanupLookup,
): CleanupPolicyOutcome {
  const decisions = validateCleanupDecisionLedger(
    z.array(cleanupDecisionSchema).parse(decisionsInput),
  );
  const lookup = cleanupLookupSchema.parse(lookupInput);
  const supersededIds = new Set(
    decisions
      .map((decision) => decision.supersedesDecisionId)
      .filter((id): id is string => Boolean(id)),
  );
  const matching = decisions
    .filter(
      (decision) =>
        !supersededIds.has(decision.decisionId) &&
        subjectMatches(decision.subject, lookup),
    )
    .sort(
      (left, right) =>
        Date.parse(left.decidedAt) - Date.parse(right.decidedAt) ||
        left.decisionId.localeCompare(right.decisionId),
    );
  const personMergeGraph = activeMergeGraph(decisions, "person");
  const companyMergeGraph = activeMergeGraph(decisions, "company");

  let company: CleanupPolicyOutcome["company"] = "allow";
  let contact: CleanupPolicyOutcome["contact"] = "allow";
  let employment: CleanupPolicyOutcome["employment"] = "allow";
  let personMergeTarget: string | undefined;
  let companyMergeTarget: string | undefined;
  const conflicts: string[] = [];

  for (const decision of matching) {
    switch (decision.directive) {
      case "no_change":
        break;
      case "hold":
        switch (decision.subject.kind) {
          case "company":
            if (company === "allow") company = "hold";
            break;
          case "employment":
            if (employment === "allow") employment = "hold";
            break;
          case "person":
          case "email":
            contact = maxContactDirective(contact, "hold");
            break;
        }
        break;
      case "do_not_reimport":
      case "invalid_address":
      case "do_not_contact":
        contact = maxContactDirective(contact, decision.directive);
        break;
      case "former_employee":
        employment = "former_employee";
        break;
      case "irrelevant_company":
        company = "irrelevant_company";
        break;
      case "merged_into": {
        const configuredTarget = decision.replacementAttioRecordId;
        if (!configuredTarget) break;
        if (decision.subject.kind === "person") {
          const target = finalMergeTarget(
            personMergeGraph,
            configuredTarget,
          );
          if (personMergeTarget && personMergeTarget !== target) {
            conflicts.push(
              `Conflicting person merge targets ${personMergeTarget} and ${target}`,
            );
          } else {
            personMergeTarget = target;
          }
        } else if (decision.subject.kind === "company") {
          const target = finalMergeTarget(
            companyMergeGraph,
            configuredTarget,
          );
          if (companyMergeTarget && companyMergeTarget !== target) {
            conflicts.push(
              `Conflicting company merge targets ${companyMergeTarget} and ${target}`,
            );
          } else {
            companyMergeTarget = target;
          }
        }
        break;
      }
    }
  }

  const directives = [
    ...new Set(matching.map((decision) => decision.directive)),
  ].sort((left, right) => DIRECTIVE_ORDER[left] - DIRECTIVE_ORDER[right]);
  const suppressed =
    company === "irrelevant_company" ||
    contact === "do_not_reimport" ||
    contact === "invalid_address" ||
    contact === "do_not_contact" ||
    employment === "former_employee";
  const held =
    conflicts.length > 0 ||
    company === "hold" ||
    contact === "hold" ||
    employment === "hold";
  const redirected = Boolean(personMergeTarget || companyMergeTarget);
  const disposition: CleanupDisposition = suppressed
    ? "suppressed_match"
    : held
      ? "hold_for_review"
      : redirected
        ? "redirected_match"
        : "allow";
  const merge =
    personMergeTarget || companyMergeTarget
      ? {
          ...(personMergeTarget
            ? { personAttioRecordId: personMergeTarget }
            : {}),
          ...(companyMergeTarget
            ? { companyAttioRecordId: companyMergeTarget }
            : {}),
        }
      : null;

  return {
    disposition,
    company,
    contact,
    employment,
    merge,
    directives,
    matchedDecisionIds: matching.map((decision) => decision.decisionId),
    conflicts,
  };
}
