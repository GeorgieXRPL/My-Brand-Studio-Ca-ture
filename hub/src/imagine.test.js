import test from "node:test";
import assert from "node:assert/strict";
import { buildVideoPrompt } from "./imagine.js";

test("video prompt includes vibe/style/audience and caps voice", () => {
  const longVoice = "x".repeat(500);
  const prompt = buildVideoPrompt({
    topic: "morning lift",
    hook: "no excuses",
    beats: ["bar on back"],
    brandVoice: longVoice,
    vibe: "Raw & unfiltered",
    content_style: "Behind-the-scenes",
    target_audience: "local tradies",
  });
  assert.match(prompt, /Raw & unfiltered/);
  assert.match(prompt, /Behind-the-scenes/);
  assert.match(prompt, /local tradies/);
  assert.ok(!prompt.includes("never say synergy"));
  const vibeIdx = prompt.indexOf("Brand vibe:");
  const slice = prompt.slice(vibeIdx, vibeIdx + 230);
  assert.ok(slice.length <= 230);
});

test("video prompt omits never-use even if accidentally passed as voice", () => {
  const prompt = buildVideoPrompt({
    topic: "coffee",
    brandVoice: "warm",
    vibe: "Calm & authentic",
  });
  assert.match(prompt, /Calm & authentic/);
  assert.ok(!prompt.includes("NEVER USE"));
});
