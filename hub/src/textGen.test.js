import test from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt } from "./textGen.js";

test("system prompt keeps brand_voice and injects NEVER USE / ALWAYS PREFER / EXAMPLES", () => {
  const prompt = buildSystemPrompt({
    goals: "grow a local brand",
    projects: "tradie app",
    brand_voice: "plain, specific, no coach voice",
    traits: {
      vibe: "Raw & unfiltered",
      never_use: ["synergy", "hustle"],
      always_use: ["mates"],
      example_posts: ["Posted the job as it was.", "two", "three", "four"],
    },
  });
  assert.match(prompt, /plain, specific, no coach voice/);
  assert.match(prompt, /NEVER USE/);
  assert.match(prompt, /ALWAYS PREFER/);
  assert.match(prompt, /EXAMPLES/);
  assert.match(prompt, /synergy/);
  assert.ok(!prompt.includes("four"));
});

test("empty new fields stay backward compatible", () => {
  const prompt = buildSystemPrompt({ brand_voice: "warm" });
  assert.match(prompt, /warm/);
  assert.ok(!prompt.includes("NEVER USE"));
  assert.ok(!prompt.includes("ALWAYS PREFER"));
  assert.ok(!prompt.includes("EXAMPLES"));
});
