import test from "node:test";
import assert from "node:assert/strict";
import { asList, voiceGuideBlocks, EXAMPLE_POST_CAP } from "./voiceGuide.js";
import { mergeProfileUpdate, exportProfilePayload } from "./profile.js";

test("empty traits add no guide blocks", () => {
  assert.equal(voiceGuideBlocks({}), "");
  assert.equal(voiceGuideBlocks(null), "");
});

test("never / always / examples are labeled and capped", () => {
  const block = voiceGuideBlocks({
    never_use: ["synergy", "hustle", "grind", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
    always_use: "mates, fair dinkum",
    example_posts: ["one", "two", "three", "four"],
  });
  assert.match(block, /NEVER USE:/);
  assert.match(block, /ALWAYS PREFER:/);
  assert.match(block, /EXAMPLES/);
  assert.ok(!block.includes("four"));
  assert.equal(asList(["one", "two", "three", "four"], EXAMPLE_POST_CAP).length, 3);
  assert.ok(block.split("\n").filter((l) => l.startsWith("- ")).length <= 14);
});

test("PUT merge keeps omitted brand_voice and merges traits", () => {
  const existing = {
    goals: "grow",
    projects: "app",
    brand_voice: "plain and specific",
    traits: { vibe: "Calm & authentic", never_use: ["synergy"] },
  };
  const merged = mergeProfileUpdate(existing, { goals: "grow more", traits: { text_provider: "claude" } });
  assert.equal(merged.brand_voice, "plain and specific");
  assert.equal(merged.projects, "app");
  assert.equal(merged.goals, "grow more");
  assert.equal(merged.traits.vibe, "Calm & authentic");
  assert.equal(merged.traits.text_provider, "claude");
  assert.deepEqual(merged.traits.never_use, ["synergy"]);
});

test("export includes traits and watermark", () => {
  const out = exportProfilePayload({
    goals: "g",
    projects: "p",
    brand_voice: "v",
    traits: { text_provider: "grok" },
    watermark_media_url: "/media/abc",
  });
  assert.equal(out.watermark_media_url, "/media/abc");
  assert.equal(out.traits.text_provider, "grok");
});
