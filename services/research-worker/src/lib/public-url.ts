import { lookup as nodeLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";

export type DnsLookup = typeof nodeLookup;

export interface PublicUrlResolution {
  url: URL;
  addresses: LookupAddress[];
}

const BLOCKED_HOST_SUFFIXES = [".internal", ".local", ".localhost"];

function isPrivateIpv4(value: string): boolean {
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) {
    return true;
  }
  const [a = 0, b = 0] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(value: string): boolean {
  const normalized = value.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (/^fe[89ab]/u.test(normalized)) return true;
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
  return mapped ? isPrivateIpv4(mapped) : false;
}

export function isPrivateIp(value: string): boolean {
  const family = isIP(value);
  if (family === 4) return isPrivateIpv4(value);
  if (family === 6) return isPrivateIpv6(value);
  return true;
}

export async function resolvePublicHttpUrl(
  input: string | URL,
  lookup: DnsLookup = nodeLookup,
): Promise<PublicUrlResolution> {
  const url = input instanceof URL ? new URL(input) : new URL(input);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error("URLs containing credentials are not allowed");
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (
    hostname === "localhost" ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  ) {
    throw new Error(`Blocked non-public hostname: ${hostname}`);
  }

  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error(`Blocked private IP: ${hostname}`);
    return {
      url,
      addresses: [{ address: hostname, family: isIP(hostname) }],
    };
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error(`No DNS addresses for ${hostname}`);
  if (addresses.some(({ address }) => isPrivateIp(address))) {
    throw new Error(`Blocked hostname resolving to a private IP: ${hostname}`);
  }
  return { url, addresses };
}

export async function assertPublicHttpUrl(
  input: string | URL,
  lookup: DnsLookup = nodeLookup,
): Promise<URL> {
  return (await resolvePublicHttpUrl(input, lookup)).url;
}
