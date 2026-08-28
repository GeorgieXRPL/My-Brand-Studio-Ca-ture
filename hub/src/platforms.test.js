import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ENABLED_PLATFORMS,
  PLATFORMS,
  platformGuidanceFor,
  resolveEnabledPlatforms,
} from "./platforms.js";

test("unknown platforms are dropped; empty falls back to the default set", () => {
  assert.deepEqual(resolveEnabledPlatforms(null, null), DEFAULT_ENABLED_PLATFORMS);
  assert.deepEqual(resolveEnabledPlatforms({ enabled_platforms: [] }), DEFAULT_ENABLED_PLATFORMS);
  assert.ok(DEFAULT_ENABLED_PLATFORMS.includes("youtube"));
  assert.deepEqual(resolveEnabledPlatforms({ enabled_platforms: ["youtube", "nope", "reddit"] }), [
    "youtube",
    "reddit",
  ]);
});

test("a custom subset is not force-upgraded", () => {
  assert.deepEqual(resolveEnabledPlatforms({ enabled_platforms: ["x", "tiktok", "linkedin"] }), [
    "x",
    "tiktok",
    "linkedin",
  ]);
});

test("legacy six without youtube upgrades to include YouTube Shorts", () => {
  assert.deepEqual(
    resolveEnabledPlatforms({
      enabled_platforms: ["x", "facebook", "tiktok", "snapchat", "instagram", "linkedin"],
    }),
    DEFAULT_ENABLED_PLATFORMS
  );
});

test("request override wins over saved traits", () => {
  assert.deepEqual(
    resolveEnabledPlatforms({ enabled_platforms: ["x", "linkedin"] }, ["reddit", "youtube"]),
    ["reddit", "youtube"]
  );
});

test("youtube and reddit are first-class destinations; grok is not a post target", () => {
  assert.ok(!PLATFORMS.includes("grok"));
  assert.ok(PLATFORMS.includes("youtube"));
  assert.ok(PLATFORMS.includes("reddit"));
  const g = platformGuidanceFor(["grok", "youtube", "reddit"]);
  assert.ok(!g.includes("- grok:"));
  assert.match(g, /youtube:/);
  assert.match(g, /reddit:/);
  assert.ok(!g.includes("- tiktok:"));
});
