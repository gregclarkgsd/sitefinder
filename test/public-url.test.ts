import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPublicHttpUrl,
  isPrivateIp,
} from "../src/lib/public-url.js";

test("blocks loopback, private and link-local targets", () => {
  assert.equal(isPrivateIp("127.0.0.1"), true);
  assert.equal(isPrivateIp("10.20.30.40"), true);
  assert.equal(isPrivateIp("169.254.1.2"), true);
  assert.equal(isPrivateIp("192.168.1.1"), true);
  assert.equal(isPrivateIp("::1"), true);
  assert.equal(isPrivateIp("8.8.8.8"), false);
});

test("rejects hostnames resolving to private addresses", async () => {
  const privateLookup = (async () => [
    { address: "10.0.0.5", family: 4 as const },
  ]) as never;
  await assert.rejects(
    assertPublicHttpUrl("https://example.test", privateLookup),
    /private IP/u,
  );
});

test("accepts public HTTP targets", async () => {
  const publicLookup = (async () => [
    { address: "203.0.113.10", family: 4 as const },
  ]) as never;
  const url = await assertPublicHttpUrl("https://example.test/team", publicLookup);
  assert.equal(url.pathname, "/team");
});
