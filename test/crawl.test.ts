import assert from "node:assert/strict";
import test from "node:test";
import { crawlCompanyWebsite } from "../src/crawler/crawl.js";
import type { CompanySeed } from "../src/types.js";

test("stops after robots.txt fails without requesting a sitemap or page", async () => {
  const paths: string[] = [];
  const progressMessages: string[] = [];
  const fetchMock = (async (input: string | URL | Request) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input
          : input.url,
    );
    paths.push(url.pathname);
    return new Response("Unavailable", { status: 500 });
  }) as typeof fetch;
  const company: CompanySeed = {
    id: "robots-failure",
    name: "Robots Failure Test Ltd",
    domain: "203.0.113.10",
    websiteUrl: "https://203.0.113.10",
    source: "file",
  };

  const result = await crawlCompanyWebsite(company, {
    maxPages: 3,
    maxPdfs: 0,
    delayMs: 0,
    timeoutMs: 1_000,
    userAgent: "GSD-Sales-Enrichment-Test/1.0",
    fetchImpl: fetchMock,
    onProgress: async (event) => {
      progressMessages.push(event.message);
    },
  });

  assert.deepEqual([...new Set(paths)], ["/robots.txt"]);
  assert.equal(result.pagesVisited.length, 0);
  assert.equal(
    result.pagesSkipped.some(({ reason }) => reason === "blocked_by_robots"),
    true,
  );
  assert.deepEqual(progressMessages, [
    "Website rules were unavailable, so the crawl stopped safely.",
  ]);
});

test("honours a cancellation before fetching the next public page", async () => {
  const paths: string[] = [];
  const fetchMock = (async (input: string | URL | Request) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input
          : input.url,
    );
    paths.push(url.pathname);
    if (url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nAllow: /", { status: 200 });
    }
    if (url.pathname === "/sitemap.xml") {
      return new Response("Not found", { status: 404 });
    }
    return new Response("<html></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  }) as typeof fetch;

  const result = await crawlCompanyWebsite(
    {
      id: "cancelled-crawl",
      name: "Cancelled Crawl Ltd",
      domain: "203.0.113.10",
      websiteUrl: "https://203.0.113.10",
      source: "file",
    },
    {
      maxPages: 3,
      maxPdfs: 0,
      delayMs: 0,
      timeoutMs: 1_000,
      userAgent: "GSD-Sales-Enrichment-Test/1.0",
      fetchImpl: fetchMock,
      onProgress: async (event) =>
        event.kind === "page" ? "stop" : "continue",
    },
  );

  assert.deepEqual([...new Set(paths)], ["/robots.txt", "/sitemap.xml"]);
  assert.equal(result.pagesVisited.length, 0);
  assert.equal(
    result.warnings.includes("Research run was cancelled by the operator."),
    true,
  );
});

test("rejects a website URL belonging to a different company domain", async () => {
  let requests = 0;
  const fetchMock = (async () => {
    requests += 1;
    return new Response("Unexpected request");
  }) as typeof fetch;

  await assert.rejects(
    crawlCompanyWebsite(
      {
        id: "mismatched-domain",
        name: "Example Ltd",
        domain: "example.com",
        websiteUrl: "https://news.ycombinator.com/",
        source: "file",
      },
      {
        maxPages: 1,
        maxPdfs: 0,
        delayMs: 0,
        timeoutMs: 1_000,
        userAgent: "GSD-Sales-Enrichment-Test/1.0",
        fetchImpl: fetchMock,
      },
    ),
    /Website domain does not match company domain/u,
  );
  assert.equal(requests, 0);
});

test("does not follow a redirect outside the approved company domain", async () => {
  const requests: string[] = [];
  const fetchMock = (async (input: string | URL | Request) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input
          : input.url,
    );
    requests.push(url.hostname);
    if (url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nAllow: /", { status: 200 });
    }
    if (url.pathname === "/sitemap.xml") {
      return new Response("Not found", { status: 404 });
    }
    return new Response(null, {
      status: 302,
      headers: { location: "https://203.0.113.11/unrelated" },
    });
  }) as typeof fetch;

  const result = await crawlCompanyWebsite(
    {
      id: "cross-domain-redirect",
      name: "Redirect Test Ltd",
      domain: "203.0.113.10",
      websiteUrl: "https://203.0.113.10",
      source: "file",
    },
    {
      maxPages: 1,
      maxPdfs: 0,
      delayMs: 0,
      timeoutMs: 1_000,
      userAgent: "GSD-Sales-Enrichment-Test/1.0",
      fetchImpl: fetchMock,
    },
  );

  assert.equal(requests.includes("203.0.113.11"), false);
  assert.equal(result.pagesVisited.length, 0);
  assert.equal(
    result.pagesSkipped.some(({ reason }) =>
      reason.includes("Redirect left the approved company domain"),
    ),
    true,
  );
});
