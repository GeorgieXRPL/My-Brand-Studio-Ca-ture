import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ENABLED_PLATFORMS,
  PLATFORMS,
  platformGuidanceFor,
  resolveEnabledPlatforms,
} from "./platforms.js";

test("unknown platforms are dropped; empty falls back to original six", () => {
  assert.deepEqual(resolveEnabledPlatforms(null, null), DEFAULT_ENABLED_PLATFORMS);
  assert.deepEqual(resolveEnabledPlatforms({ enabled_platforms: [] }), DEFAULT_ENABLED_PLATFORMS);
  assert.deepEqual(resolveEnabledPlatforms({ enabled_platforms: ["youtube", "nope", "reddit"] }), [
    "youtube",
    "reddit",
  ]);
});

test("request override wins over saved traits", () => {
  assert.deepEqual(
    resolveEnabledPlatforms({ enabled_platforms: ["x", "linkedin"] }, ["grok", "youtube"]),
    ["grok", "youtube"]
  );
});

test("grok, youtube, reddit are first-class destinations", () => {
  assert.ok(PLATFORMS.includes("grok"));
  assert.ok(PLATFORMS.includes("youtube"));
  assert.ok(PLATFORMS.includes("reddit"));
  const g = platformGuidanceFor(["grok", "youtube", "reddit"]);
  assert.match(g, /grok:/);
  assert.match(g, /youtube:/);
  assert.match(g, /reddit:/);
  assert.ok(!g.includes("- tiktok:"));
});
