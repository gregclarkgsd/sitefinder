import { setTimeout as delay } from "node:timers/promises";
import type { LookupAddress, LookupOptions } from "node:dns";
import { Agent, fetch as undiciFetch } from "undici";
import {
  resolvePublicHttpUrl,
  type DnsLookup,
} from "./public-url.js";
import { canonicalDomain } from "./normalize.js";

export interface ResourceResponse {
  url: string;
  status: number;
  contentType: string;
  body: Uint8Array;
  headers: Headers;
}

export interface FetchResourceOptions {
  timeoutMs: number;
  maxBytes: number;
  userAgent: string;
  fetchImpl?: typeof fetch;
  lookup?: DnsLookup;
  extraHeaders?: Record<string, string>;
  retries?: number;
  allowedDomain?: string;
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter && /^\d+$/u.test(retryAfter)) {
    return Math.min(Number(retryAfter) * 1000, 10_000);
  }
  return Math.min(500 * 2 ** attempt, 4_000);
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

function pinnedLookup(addresses: LookupAddress[]) {
  return (
    _hostname: string,
    options: LookupOptions,
    callback: LookupCallback,
  ): void => {
    const requestedFamily =
      options.family === 4 || options.family === 6 ? options.family : 0;
    const candidates = requestedFamily
      ? addresses.filter(({ family }) => family === requestedFamily)
      : addresses;
    if (candidates.length === 0) {
      const error = new Error(
        `No validated address for requested family ${requestedFamily}`,
      ) as NodeJS.ErrnoException;
      error.code = "EAI_ADDRFAMILY";
      callback(error, []);
      return;
    }
    if (options.all) {
      callback(null, candidates);
      return;
    }
    const selected = candidates[0];
    if (!selected) {
      callback(new Error("No validated address"), []);
      return;
    }
    callback(null, selected.address, selected.family);
  };
}

function pinnedAgent(addresses: LookupAddress[]): Agent {
  return new Agent({
    connect: {
      lookup: pinnedLookup(addresses),
      autoSelectFamily: true,
    },
  });
}

async function readLimitedBody(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    throw new Error(`Response exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function fetchPublicResource(
  input: string | URL,
  options: FetchResourceOptions,
): Promise<ResourceResponse> {
  const fetchImpl =
    options.fetchImpl ?? (undiciFetch as unknown as typeof fetch);
  const retries = options.retries ?? 2;
  let resolved = await resolvePublicHttpUrl(input, options.lookup);

  for (let redirect = 0; redirect <= 5; redirect += 1) {
    if (
      options.allowedDomain &&
      canonicalDomain(resolved.url.hostname) !== options.allowedDomain
    ) {
      throw new Error(
        `Redirect left the approved company domain: ${resolved.url.hostname}`,
      );
    }
    const dispatcher = options.fetchImpl
      ? undefined
      : pinnedAgent(resolved.addresses);
    try {
      let response: Response | undefined;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        const requestInit: RequestInit & { dispatcher?: Agent } = {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(options.timeoutMs),
          headers: {
            accept:
              "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.2",
            "user-agent": options.userAgent,
            ...options.extraHeaders,
          },
          ...(dispatcher ? { dispatcher } : {}),
        };
        response = await fetchImpl(resolved.url, requestInit);

        if (
          attempt < retries &&
          (response.status === 429 || response.status >= 500)
        ) {
          await response.body?.cancel();
          await delay(retryDelay(response, attempt));
          continue;
        }
        break;
      }

      if (!response) {
        throw new Error(`No response from ${resolved.url.hostname}`);
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) {
          throw new Error(`Redirect without location from ${resolved.url}`);
        }
        resolved = await resolvePublicHttpUrl(
          new URL(location, resolved.url),
          options.lookup,
        );
        continue;
      }

      const body = await readLimitedBody(response, options.maxBytes);
      return {
        url: resolved.url.toString(),
        status: response.status,
        contentType: response.headers.get("content-type")?.toLowerCase() ?? "",
        body,
        headers: response.headers,
      };
    } finally {
      await dispatcher?.close();
    }
  }

  throw new Error(`Too many redirects for ${input.toString()}`);
}

export function decodeUtf8(body: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(body);
}

export async function fetchJson<T>(
  url: string | URL,
  init: RequestInit,
  options: {
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    maxBytes?: number;
    retries?: number;
  } = {},
): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const retries = options.retries ?? 2;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const response = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    });
    if (
      attempt < retries &&
      (response.status === 429 || response.status >= 500)
    ) {
      await response.body?.cancel();
      await delay(retryDelay(response, attempt));
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
    }
    const body = await readLimitedBody(response, options.maxBytes ?? 20_000_000);
    return JSON.parse(decodeUtf8(body)) as T;
  }
  throw new Error(`Request failed for ${new URL(url).hostname}`);
}
