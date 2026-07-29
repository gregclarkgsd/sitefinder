import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import type {
  CompanySeed,
  ContactCandidate,
  ContactPoint,
  Evidence,
  WebsiteSignal,
} from "../types.js";
import {
  canonicalDomain,
  collapseWhitespace,
  isBusinessEmail,
  normalizeEmail,
  normalizePersonName,
  normalizeUkPhone,
  stableId,
} from "../lib/normalize.js";
import { classifyRoleTitle, containsTargetRole } from "../lib/roles.js";

const EMAIL_PATTERN =
  /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/giu;
const UK_PHONE_PATTERN =
  /(?:(?:\+44\s?(?:\(0\)\s?)?)|0)(?:\d[\s().-]?){9,11}\d/gu;
const DEPARTED_PATTERN =
  /\b(?:left\s+(?:the\s+)?(?:business|company)|retired|departed|no\s+longer\s+(?:with|at))\b/iu;
const GENERIC_EMAIL_PREFIXES = new Set([
  "bids",
  "commercial",
  "contact",
  "enquiries",
  "estimating",
  "hello",
  "info",
  "procurement",
  "sales",
  "supplychain",
  "tenders",
]);

const SECTOR_RULES: Array<[string, RegExp]> = [
  ["residential", /\b(?:residential|housing|apartments?|homes?)\b/iu],
  ["social_housing", /\bsocial\s+housing\b/iu],
  ["commercial_office", /\b(?:commercial|office|workplace)\b/iu],
  ["fit_out", /\b(?:fit[\s-]?out|interiors?|refurbishment)\b/iu],
  ["education", /\b(?:education|school|college|university)\b/iu],
  ["healthcare", /\b(?:healthcare|hospital|health\s+centre)\b/iu],
  ["heritage", /\b(?:heritage|listed\s+building|conservation)\b/iu],
  ["hospitality", /\b(?:hotel|hospitality|restaurant)\b/iu],
  ["leisure", /\b(?:leisure|sports?|stadium)\b/iu],
  ["industrial", /\b(?:industrial|warehouse|logistics|factory)\b/iu],
  ["infrastructure", /\b(?:infrastructure|rail|station|airport|highways?)\b/iu],
];

export interface PageExtraction {
  contacts: ContactCandidate[];
  evidence: Evidence[];
  website: WebsiteSignal;
  links: string[];
  pdfLinks: string[];
}

interface ContactDraft {
  name: string;
  jobTitle: string;
  emails: string[];
  phones: string[];
  profileUrls: string[];
  employmentStatus: "current" | "former" | "unknown";
  confidence: number;
  excerpt: string;
}

function deobfuscateEmails(text: string): string {
  return text
    .replace(/\s*(?:\[|\()?\s+at\s+(?:\]|\))?\s*/giu, "@")
    .replace(/\s*(?:\[|\()?\s+dot\s+(?:\]|\))?\s*/giu, ".");
}

function extractEmails(text: string): string[] {
  return [
    ...new Set(
      (deobfuscateEmails(text).match(EMAIL_PATTERN) ?? [])
        .map(normalizeEmail)
        .filter(isBusinessEmail),
    ),
  ];
}

function extractPhones(text: string): string[] {
  return [
    ...new Set(
      (text.match(UK_PHONE_PATTERN) ?? [])
        .map(normalizeUkPhone)
        .filter((phone): phone is string => phone !== null),
    ),
  ];
}

function cleanPersonName(value: string): string {
  return collapseWhitespace(value.replace(/[|–—].*$/u, ""));
}

function isLikelyPersonName(value: string, companyName: string): boolean {
  const name = cleanPersonName(value);
  if (name.length < 4 || name.length > 80) return false;
  if (normalizePersonName(name) === normalizePersonName(companyName)) return false;
  if (containsTargetRole(name)) return false;
  if (
    /\b(?:team|people|contact|about|leadership|management|directorate|careers?|vacancies|projects?|managing\s+director|chief\s+executive|operations?\s+director|construction|contractors?|building|group|company|limited|ltd|plc)\b/iu.test(
      name,
    )
  ) {
    return false;
  }
  const words = name.split(/\s+/u);
  if (words.length < 2 || words.length > 5) return false;
  return words.every((word) =>
    /^(?:[A-ZÀ-ÖØ-Þ][\p{L}'’-]+|[A-Z]\.)$/u.test(word),
  );
}

function findTitleLine(text: string): string | null {
  const lines = text
    .split(/\n|\s{2,}/u)
    .map(collapseWhitespace)
    .filter((line) => line.length > 1 && line.length <= 160);
  return lines.find((line) => containsTargetRole(line)) ?? null;
}

function findName(
  $: cheerio.CheerioAPI,
  container: cheerio.Cheerio<AnyNode>,
  text: string,
  company: CompanySeed,
): string | null {
  const imageNames = container
    .find("img[alt],img[title]")
    .map((_, element) => {
      const image = $(element);
      return collapseWhitespace(image.attr("alt") ?? image.attr("title") ?? "");
    })
    .get();
  for (const candidate of imageNames) {
    if (isLikelyPersonName(candidate, company.name)) {
      return cleanPersonName(candidate);
    }
  }

  const preferredSelectors = [
    "[itemprop='name']",
    "[class*='name']",
    "h2",
    "h3",
    "h4",
    "strong",
  ];
  for (const selector of preferredSelectors) {
    const candidates = container
      .find(selector)
      .map((_, element) => collapseWhitespace($(element).text()))
      .get();
    for (const candidate of candidates) {
      if (isLikelyPersonName(candidate, company.name)) {
        return cleanPersonName(candidate);
      }
    }
  }

  const lines = text
    .split(/\n|\s{2,}/u)
    .map(collapseWhitespace)
    .filter(Boolean);
  const roleIndex = lines.findIndex(containsTargetRole);
  const nearby = roleIndex > 0 ? lines.slice(Math.max(0, roleIndex - 3), roleIndex) : lines;
  for (const candidate of nearby.reverse()) {
    if (isLikelyPersonName(candidate, company.name)) {
      return cleanPersonName(candidate);
    }
  }
  return null;
}

function pageKind(url: string): "team" | "careers" | "projects" | "contact" | "other" {
  const path = new URL(url).pathname.toLowerCase();
  if (/(?:team|people|leadership|management|staff)/u.test(path)) return "team";
  if (/(?:career|vacanc|jobs?)/u.test(path)) return "careers";
  if (/(?:project|case-stud|portfolio)/u.test(path)) return "projects";
  if (/(?:contact|office|location)/u.test(path)) return "contact";
  return "other";
}

function evidenceForContact(
  company: CompanySeed,
  url: string,
  capturedAt: string,
  draft: ContactDraft,
): Evidence {
  return {
    id: stableId(company.id, url, draft.name, draft.jobTitle),
    companyId: company.id,
    sourceKind: url.toLowerCase().endsWith(".pdf")
      ? "company_pdf"
      : "company_website",
    sourceUrl: url,
    capturedAt,
    field: "contact_role",
    value: `${draft.name} — ${draft.jobTitle}`,
    excerpt: draft.excerpt.slice(0, 320),
    confidence: draft.confidence,
  };
}

function materializeContact(
  company: CompanySeed,
  draft: ContactDraft,
  evidence: Evidence,
): ContactCandidate | null {
  const role = classifyRoleTitle(draft.jobTitle);
  if (!role) return null;
  const name = cleanPersonName(draft.name);
  const normalizedName = normalizePersonName(name);
  const titleContainsName = normalizePersonName(draft.jobTitle).includes(
    normalizedName,
  );
  const jobTitle =
    draft.jobTitle.length > 80 || titleContainsName
      ? role.matchedTitle
      : draft.jobTitle;
  return {
    id: stableId(company.id, normalizedName, role.category),
    companyId: company.id,
    name,
    normalizedName,
    jobTitle,
    roleCategory: role.category,
    rolePriority: role.priority,
    employmentStatus: draft.employmentStatus,
    emails: draft.emails.map(
      (value): ContactPoint => ({ value, status: "public" }),
    ),
    phones: draft.phones.map(
      (value): ContactPoint => ({ value, status: "public" }),
    ),
    profileUrls: draft.profileUrls,
    evidenceIds: [evidence.id],
    confidence: draft.confidence,
  };
}

function flattenJsonLd(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(flattenJsonLd);
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  const nested = object["@graph"] ? flattenJsonLd(object["@graph"]) : [];
  return [object, ...nested];
}

function jsonLdDrafts(
  $: cheerio.CheerioAPI,
  company: CompanySeed,
): ContactDraft[] {
  const drafts: ContactDraft[] = [];
  $("script[type='application/ld+json']").each((_, element) => {
    const raw = $(element).text();
    try {
      for (const object of flattenJsonLd(JSON.parse(raw) as unknown)) {
        const types = Array.isArray(object["@type"])
          ? object["@type"]
          : [object["@type"]];
        if (!types.some((type) => String(type).toLowerCase() === "person")) continue;
        const name = cleanPersonName(String(object["name"] ?? ""));
        const jobTitle = collapseWhitespace(String(object["jobTitle"] ?? ""));
        if (!isLikelyPersonName(name, company.name) || !containsTargetRole(jobTitle)) {
          continue;
        }
        const email = String(object["email"] ?? "").replace(/^mailto:/iu, "");
        const phone = String(object["telephone"] ?? "");
        const sameAs = Array.isArray(object["sameAs"])
          ? object["sameAs"].map(String)
          : object["sameAs"]
            ? [String(object["sameAs"])]
            : [];
        drafts.push({
          name,
          jobTitle,
          emails: extractEmails(email),
          phones: extractPhones(phone),
          profileUrls: sameAs.filter((link) => /^https?:\/\//iu.test(link)),
          employmentStatus: "current",
          confidence: 0.96,
          excerpt: `${name} ${jobTitle}`,
        });
      }
    } catch {
      // Invalid JSON-LD is common and must not stop the crawl.
    }
  });
  return drafts;
}

function containerDrafts(
  $: cheerio.CheerioAPI,
  company: CompanySeed,
  url: string,
): ContactDraft[] {
  if (pageKind(url) === "careers") return [];
  const selectors = [
    "[itemtype*='Person']",
    "[class*='team-member']",
    "[class*='team_member']",
    "[class*='staff']",
    "[class*='person']",
    "[class*='profile']",
    "[class*='member']",
    "[class*='image_frame']",
    "[class*='mcb-wrap-inner']",
    "figure",
    "article",
    "li",
  ];
  const seen = new Set<string>();
  const drafts: ContactDraft[] = [];

  $(selectors.join(",")).each((_, element) => {
    const container = $(element);
    const text = collapseWhitespace(container.text());
    if (text.length < 10 || text.length > 900 || !containsTargetRole(text)) return;
    const fingerprint = text.toLowerCase();
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);

    const name = findName($, container, container.text(), company);
    const explicitTitles = container
      .find(
        "[itemprop='jobTitle'],[class*='job-title'],[class*='job_title'],[class*='role'],[class*='position']",
      )
      .map((__, titleElement) => collapseWhitespace($(titleElement).text()))
      .get();
    const jobTitle =
      explicitTitles.find((candidate) => containsTargetRole(candidate)) ??
      findTitleLine(container.text());
    if (!name || !jobTitle) return;

    const hrefs = container
      .find("a[href]")
      .map((__, anchor) => $(anchor).attr("href") ?? "")
      .get();
    const emails = [
      ...new Set([
        ...extractEmails(text),
        ...hrefs
          .filter((href) => href.toLowerCase().startsWith("mailto:"))
          .flatMap((href) => extractEmails(href.slice(7))),
      ]),
    ];
    const phones = [
      ...new Set([
        ...extractPhones(text),
        ...hrefs
          .filter((href) => href.toLowerCase().startsWith("tel:"))
          .flatMap((href) => extractPhones(href.slice(4))),
      ]),
    ];
    const profileUrls = hrefs
      .filter((href) => /linkedin\.com\/in\//iu.test(href))
      .map((href) => {
        try {
          return new URL(href, url).toString();
        } catch {
          return href;
        }
      });
    const kind = pageKind(url);
    drafts.push({
      name,
      jobTitle,
      emails,
      phones,
      profileUrls: [...new Set(profileUrls)],
      employmentStatus: DEPARTED_PATTERN.test(text) ? "former" : "current",
      confidence: kind === "team" ? 0.9 : 0.76,
      excerpt: text,
    });
  });
  return drafts;
}

function extractLinks(
  $: cheerio.CheerioAPI,
  url: string,
  companyDomain: string,
): { links: string[]; pdfLinks: string[]; socialUrls: string[] } {
  const links = new Set<string>();
  const pdfLinks = new Set<string>();
  const socialUrls = new Set<string>();

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href || /^(?:mailto|tel|javascript):/iu.test(href) || href.startsWith("#")) {
      return;
    }
    try {
      const target = new URL(href, url);
      if (!["http:", "https:"].includes(target.protocol)) return;
      if (/linkedin\.com|x\.com|twitter\.com|instagram\.com|facebook\.com/iu.test(target.hostname)) {
        socialUrls.add(target.toString());
        return;
      }
      if (canonicalDomain(target.hostname) !== companyDomain) return;
      target.hash = "";
      if (target.pathname.toLowerCase().endsWith(".pdf")) {
        pdfLinks.add(target.toString());
      } else {
        target.search = "";
        links.add(target.toString());
      }
    } catch {
      // Ignore malformed links.
    }
  });
  return {
    links: [...links],
    pdfLinks: [...pdfLinks],
    socialUrls: [...socialUrls],
  };
}

function websiteSignals(
  $: cheerio.CheerioAPI,
  url: string,
  company: CompanySeed,
  socialUrls: string[],
): WebsiteSignal {
  const bodyText = collapseWhitespace($("body").text()).slice(0, 250_000);
  const emails = extractEmails(bodyText);
  const phones = extractPhones(bodyText);
  const domain = canonicalDomain(company.domain);
  const genericEmails = emails.filter((email) => {
    const [local = "", emailDomain = ""] = email.split("@");
    return GENERIC_EMAIL_PREFIXES.has(local) && (!domain || emailDomain === domain);
  });
  const sectors = SECTOR_RULES.filter(([, pattern]) => pattern.test(bodyText)).map(
    ([sector]) => sector,
  );
  const hiringRoles =
    pageKind(url) === "careers"
      ? [
          ...new Set(
            bodyText
              .split(/[.!?|\n]/u)
              .map(collapseWhitespace)
              .filter((line) => line.length <= 160 && containsTargetRole(line))
              .map((line) => classifyRoleTitle(line)?.matchedTitle)
              .filter((title): title is string => Boolean(title)),
          ),
        ]
      : [];
  const projectNames =
    pageKind(url) === "projects"
      ? $("h1,h2,h3")
          .map((_, element) => collapseWhitespace($(element).text()))
          .get()
          .filter(
            (heading) =>
              heading.length >= 5 &&
              heading.length <= 120 &&
              !/^(?:projects?|case studies|portfolio|our work)$/iu.test(heading),
          )
          .slice(0, 20)
      : [];
  const offices =
    pageKind(url) === "contact"
      ? $("address,[itemprop='address']")
          .map((_, element) => collapseWhitespace($(element).text()))
          .get()
          .filter((address) => address.length >= 8 && address.length <= 240)
          .slice(0, 10)
      : [];
  return {
    offices: [...new Set(offices)],
    sectors: [...new Set(sectors)],
    projectNames: [...new Set(projectNames)],
    hiringRoles,
    genericEmails: [...new Set(genericEmails)],
    genericPhones: [...new Set(phones)],
    socialUrls,
  };
}

export function extractHtmlPage(
  company: CompanySeed,
  url: string,
  html: string,
  capturedAt: string,
): PageExtraction {
  const $ = cheerio.load(html);
  $("script:not([type='application/ld+json']),style,noscript,template").remove();
  const domain = canonicalDomain(company.domain) ?? canonicalDomain(url) ?? "";
  const discovered = extractLinks($, url, domain);
  const drafts = [...jsonLdDrafts($, company), ...containerDrafts($, company, url)];
  const contacts: ContactCandidate[] = [];
  const evidence: Evidence[] = [];
  const seen = new Set<string>();

  for (const draft of drafts) {
    const key = `${normalizePersonName(draft.name)}|${draft.jobTitle.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const itemEvidence = evidenceForContact(company, url, capturedAt, draft);
    const contact = materializeContact(company, draft, itemEvidence);
    if (!contact) continue;
    evidence.push(itemEvidence);
    contacts.push(contact);
  }

  return {
    contacts,
    evidence,
    website: websiteSignals($, url, company, discovered.socialUrls),
    links: discovered.links,
    pdfLinks: discovered.pdfLinks,
  };
}

export function extractPdfText(
  company: CompanySeed,
  url: string,
  text: string,
  capturedAt: string,
): PageExtraction {
  const companyDomain =
    canonicalDomain(company.domain) ?? canonicalDomain(company.websiteUrl) ?? "";
  const lines = text
    .split(/\r?\n/u)
    .map(collapseWhitespace)
    .filter(Boolean);
  const contacts: ContactCandidate[] = [];
  const evidence: Evidence[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!containsTargetRole(line)) continue;
    const context = lines
      .slice(Math.max(0, index - 2), Math.min(lines.length, index + 3))
      .join(" ");
    const name = lines
      .slice(Math.max(0, index - 2), index)
      .find((candidate) => isLikelyPersonName(candidate, company.name));
    if (!name) continue;
    const draft: ContactDraft = {
      name,
      jobTitle: line.slice(0, 160),
      emails: extractEmails(context),
      phones: extractPhones(context),
      profileUrls: [],
      employmentStatus: DEPARTED_PATTERN.test(context) ? "former" : "unknown",
      confidence: 0.68,
      excerpt: context,
    };
    const itemEvidence = evidenceForContact(company, url, capturedAt, draft);
    const contact = materializeContact(company, draft, itemEvidence);
    if (!contact) continue;
    evidence.push(itemEvidence);
    contacts.push(contact);
  }

  return {
    contacts,
    evidence,
    website: {
      offices: [],
      sectors: SECTOR_RULES.filter(([, pattern]) => pattern.test(text)).map(
        ([sector]) => sector,
      ),
      projectNames: [],
      hiringRoles: [],
      genericEmails: extractEmails(text).filter((email) => {
        const [local = "", emailDomain = ""] = email.split("@");
        return (
          GENERIC_EMAIL_PREFIXES.has(local) &&
          Boolean(companyDomain) &&
          canonicalDomain(emailDomain) === companyDomain
        );
      }),
      genericPhones: extractPhones(text),
      socialUrls: [],
    },
    links: [],
    pdfLinks: [],
  };
}
