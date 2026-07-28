import type { RoleCategory } from "../types.js";
import { collapseWhitespace } from "./normalize.js";

interface RoleRule {
  category: RoleCategory;
  priority: number;
  pattern: RegExp;
}

const ROLE_RULES: RoleRule[] = [
  {
    category: "quantity_surveying",
    priority: 100,
    pattern:
      /\b(?:(?:assistant|trainee|graduate|project|senior|managing|lead|chief)\s+)?(?:quantity\s+surveyor|q\.?s\.?)\b/iu,
  },
  {
    category: "commercial",
    priority: 95,
    pattern:
      /\b(?:(?:assistant|senior|regional|group|chief)\s+)?commercial\s+(?:manager|director|lead|head)\b|\bhead\s+of\s+commercial\b/iu,
  },
  {
    category: "procurement",
    priority: 92,
    pattern:
      /\b(?:(?:assistant|senior|group|chief)\s+)?(?:procurement|purchasing)\s+(?:manager|director|lead|officer|specialist|head)\b|\bhead\s+of\s+(?:procurement|purchasing)\b|\b(?:senior\s+)?buyer\b/iu,
  },
  {
    category: "supply_chain",
    priority: 90,
    pattern:
      /\b(?:(?:assistant|senior|group|regional)\s+)?supply\s+chain\s+(?:manager|director|lead|head)\b|\bhead\s+of\s+supply\s+chain\b/iu,
  },
  {
    category: "project_management",
    priority: 88,
    pattern:
      /\b(?:(?:assistant|senior|construction|delivery|lead)\s+)?project\s+(?:manager|director|lead)\b|\bhead\s+of\s+projects?\b/iu,
  },
  {
    category: "contracts",
    priority: 85,
    pattern:
      /\b(?:(?:assistant|senior|regional)\s+)?contracts?\s+(?:manager|director|surveyor|lead)\b/iu,
  },
  {
    category: "site_surveying",
    priority: 84,
    pattern:
      /\b(?:(?:assistant|senior|lead)\s+)?site\s+surveyor\b/iu,
  },
  {
    category: "estimating",
    priority: 75,
    pattern:
      /\b(?:(?:assistant|senior|chief|lead)\s+)?(?:estimator|estimating\s+manager|preconstruction\s+manager)\b/iu,
  },
  {
    category: "site_management",
    priority: 65,
    pattern:
      /\b(?:(?:assistant|senior|lead)\s+)?site\s+manager\b/iu,
  },
];

export interface RoleMatch {
  category: RoleCategory;
  priority: number;
  matchedTitle: string;
}

export function classifyRoleTitle(value: string): RoleMatch | null {
  const title = collapseWhitespace(value);
  for (const rule of ROLE_RULES) {
    const match = title.match(rule.pattern);
    if (match?.[0]) {
      return {
        category: rule.category,
        priority: rule.priority,
        matchedTitle: collapseWhitespace(match[0]),
      };
    }
  }
  return null;
}

export function containsTargetRole(value: string): boolean {
  return classifyRoleTitle(value) !== null;
}
