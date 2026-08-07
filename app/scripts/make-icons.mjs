// Generates the PNG icons required by the Play Store / richer install UI
// from public/icon.svg. Run: node scripts/make-icons.mjs
import sharp from "sharp";
import { readFileSync } from "node:fs";

const svg = readFileSync(new URL("../public/icon.svg", import.meta.url));

// Standard icons: straight rasterization.
await sharp(svg).resize(192, 192).png().toFile("public/icon-192.png");
await sharp(svg).resize(512, 512).png().toFile("public/icon-512.png");

// Maskable icon: full-bleed background with the artwork inside the 80% safe zone.
const inner = await sharp(svg).resize(410, 410).png().toBuffer();
await sharp({
  create: { width: 512, height: 512, channels: 4, background: "#0b0f1a" },
})
  .composite([{ input: inner, gravity: "center" }])
  .png()
  .toFile("public/icon-512-maskable.png");

// Apple touch icon (iOS home screen): 180x180, opaque background —
// iOS renders transparency as black, so bake the brand background in.
const appleInner = await sharp(svg).resize(150, 150).png().toBuffer();
await sharp({
  create: { width: 180, height: 180, channels: 4, background: "#0b0f1a" },
})
  .composite([{ input: appleInner, gravity: "center" }])
  .png()
  .toFile("public/apple-touch-icon.png");

console.log("Icons written: icon-192.png, icon-512.png, icon-512-maskable.png, apple-touch-icon.png");
