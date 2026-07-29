import { createHash } from "node:crypto";
import { getDomain } from "tldts";

const FREE_EMAIL_DOMAINS = new Set([
  "aol.com",
  "fastmail.com",
  "fastmail.fm",
  "gmail.com",
  "gmx.com",
  "gmx.co.uk",
  "gmx.de",
  "googlemail.com",
  "hey.com",
  "hotmail.co.uk",
  "hotmail.com",
  "icloud.com",
  "live.co.uk",
  "live.com",
  "mac.com",
  "mail.com",
  "me.com",
  "msn.com",
  "pm.me",
  "outlook.com",
  "outlook.co.uk",
  "proton.me",
  "protonmail.com",
  "tuta.com",
  "tutanota.com",
  "yahoo.ca",
  "yahoo.com.au",
  "yahoo.co.uk",
  "yahoo.com",
  "yahoo.de",
  "yahoo.es",
  "yahoo.fr",
  "yandex.com",
  "yandex.ru",
  "zoho.com",
]);

const COMPANY_SUFFIXES =
  /\b(?:limited|ltd|plc|llp|incorporated|inc|company|co)\b/giu;
const IDENTITY_QUALIFIERS = new Set(["group", "holdings", "uk"]);

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isBusinessEmail(value: string): boolean {
  const email = normalizeEmail(value);
  const domain = email.split("@")[1];
  return Boolean(domain && !FREE_EMAIL_DOMAINS.has(domain));
}

export function canonicalDomain(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  let hostname: string;
  try {
    hostname = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)
        ? trimmed
        : `https://${trimmed}`,
    ).hostname;
  } catch {
    return null;
  }

  const registrable = getDomain(hostname, { allowPrivateDomains: false });
  return (registrable ?? hostname).toLowerCase().replace(/^www\./u, "");
}

export function normalizeCompanyName(value: string): string {
  return collapseWhitespace(
    value
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(COMPANY_SUFFIXES, " ")
      .toLowerCase(),
  );
}

export function normalizePersonName(value: string): string {
  return collapseWhitespace(
    value
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
      .toLowerCase(),
  );
}

export function normalizeUkPhone(value: string): string | null {
  const cleaned = value.replace(/[^\d+]/gu, "");
  if (/^\+44\d{9,10}$/u.test(cleaned)) return cleaned;
  if (/^0\d{9,10}$/u.test(cleaned)) return `+44${cleaned.slice(1)}`;
  return null;
}

export function sameCompanyName(left: string, right: string): boolean {
  const a = normalizeCompanyName(left);
  const b = normalizeCompanyName(right);
  if (!a || !b) return false;
  if (a === b) return true;

  const aTokens = new Set(a.split(" "));
  const bTokens = new Set(b.split(" "));
  if (
    [...IDENTITY_QUALIFIERS].some(
      (qualifier) => aTokens.has(qualifier) !== bTokens.has(qualifier),
    )
  ) {
    return false;
  }
  const intersection = [...aTokens].filter((token) => bTokens.has(token)).length;
  const union = new Set([...aTokens, ...bTokens]).size;
  return union > 0 && intersection / union >= 0.8;
}

export function stableId(...parts: string[]): string {
  const digest = createHash("sha256")
    .update(parts.join("\u001f"))
    .digest("hex")
    .slice(0, 32);
  return `gsd_${digest}`;
}
