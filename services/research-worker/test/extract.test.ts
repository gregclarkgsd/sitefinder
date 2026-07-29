import assert from "node:assert/strict";
import test from "node:test";
import { extractHtmlPage, extractPdfText } from "../src/crawler/extract.js";
import type { CompanySeed } from "../src/types.js";

const company: CompanySeed = {
  id: "company-1",
  name: "Example Construction Ltd",
  domain: "example-construction.test",
  websiteUrl: "https://example-construction.test",
  source: "file",
};

test("extracts evidence-backed team contacts from HTML and JSON-LD", () => {
  const html = `
    <html>
      <body>
        <div class="team-member">
          <h3 class="name">Alice Morgan</h3>
          <p class="role">Senior Quantity Surveyor</p>
          <a href="mailto:alice.morgan@example-construction.test">Email</a>
          <a href="https://www.linkedin.com/in/alice-example">Profile</a>
        </div>
        <script type="application/ld+json">
          {
            "@type": "Person",
            "name": "Benjamin Carter",
            "jobTitle": "Commercial Manager",
            "email": "benjamin.carter@example-construction.test"
          }
        </script>
        <figure class="image_frame">
          <img src="/team/charlotte.jpg" alt="Charlotte Davies">
          <p class="wp-caption-text">Contracts Manager</p>
        </figure>
      </body>
    </html>`;

  const result = extractHtmlPage(
    company,
    "https://example-construction.test/team",
    html,
    "2026-07-27T12:00:00.000Z",
  );

  assert.equal(result.contacts.length, 3);
  assert.deepEqual(
    result.contacts.map((contact) => contact.roleCategory).sort(),
    ["commercial", "contracts", "quantity_surveying"],
  );
  const alice = result.contacts.find((contact) => contact.name === "Alice Morgan");
  assert.equal(alice?.jobTitle, "Senior Quantity Surveyor");
  assert.equal(
    alice?.emails[0]?.value,
    "alice.morgan@example-construction.test",
  );
  assert.equal(alice?.confidence, 0.9);
  assert.equal(result.evidence.length, 3);
});

test("treats careers-page roles as hiring signals rather than people", () => {
  const html = `
    <html><body>
      <article class="vacancy">
        <h2>Procurement Manager</h2>
        <p>Join our growing commercial team.</p>
      </article>
    </body></html>`;
  const result = extractHtmlPage(
    company,
    "https://example-construction.test/careers/procurement-manager",
    html,
    "2026-07-27T12:00:00.000Z",
  );

  assert.equal(result.contacts.length, 0);
  assert.deepEqual(result.website.hiringRoles, ["Procurement Manager"]);
});

test("cleans a title suffix from a person's name and title", () => {
  const html = `
    <html><body>
      <article class="profile">
        <h2>Sean McGrath – Pre-Construction Commercial Director</h2>
      </article>
    </body></html>`;
  const result = extractHtmlPage(
    company,
    "https://example-construction.test/team",
    html,
    "2026-07-27T12:00:00.000Z",
  );

  assert.equal(result.contacts.length, 1);
  assert.equal(result.contacts[0]?.name, "Sean McGrath");
  assert.equal(result.contacts[0]?.jobTitle, "Commercial Director");
});

test("does not treat company or role headings as person names", () => {
  const html = `
    <html><body>
      <article>
        <img alt="Tom Myers Example Construction">
        <h2>A senior site manager's mission to transform his former school</h2>
      </article>
      <article>
        <h2>Managing Director</h2>
        <p>Peter joined the company as a contracts manager.</p>
      </article>
    </body></html>`;
  const result = extractHtmlPage(
    company,
    "https://example-construction.test/news",
    html,
    "2026-07-27T12:00:00.000Z",
  );

  assert.equal(result.contacts.length, 0);
});

test("does not mark a current team member former from biography history", () => {
  const html = `
    <html><body>
      <div class="team-member">
        <h3>Frank Vanderwalt</h3>
        <p class="role">Project Director</p>
        <p>Previously worked for another contractor.</p>
      </div>
    </body></html>`;
  const result = extractHtmlPage(
    company,
    "https://example-construction.test/team",
    html,
    "2026-07-27T12:00:00.000Z",
  );

  assert.equal(result.contacts[0]?.employmentStatus, "current");
});

test("extracts a named role from bounded PDF text", () => {
  const result = extractPdfText(
    company,
    "https://example-construction.test/project-team.pdf",
    "Project team\nCharlotte Davies\nProject Manager\ncharlotte.davies@example-construction.test",
    "2026-07-27T12:00:00.000Z",
  );

  assert.equal(result.contacts.length, 1);
  assert.equal(result.contacts[0]?.name, "Charlotte Davies");
  assert.equal(result.contacts[0]?.roleCategory, "project_management");
  assert.equal(result.contacts[0]?.confidence, 0.68);
});

test("does not attribute third-party generic PDF emails to the company", () => {
  const result = extractPdfText(
    company,
    "https://example-construction.test/project-team.pdf",
    [
      "Project team",
      "Charlotte Davies",
      "Project Manager",
      "info@architects.example",
      "sales@example-construction.test",
    ].join("\n"),
    "2026-07-27T12:00:00.000Z",
  );

  assert.deepEqual(result.website.genericEmails, [
    "sales@example-construction.test",
  ]);
});
