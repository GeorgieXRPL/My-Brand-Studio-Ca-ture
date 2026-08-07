// Prints a pairing QR code for the phone app.
// Usage:  npm run qr -- https://your-tunnel.trycloudflare.com
//         (or set HUB_PUBLIC_URL in .env and just run: npm run qr)

import qrcode from "qrcode-terminal";

const url = (process.argv[2] || process.env.HUB_PUBLIC_URL || "").trim().replace(/\/$/, "");
const token = (process.env.HUB_TOKEN || "").trim();

if (!url) {
  console.error("No hub URL. Pass it as an argument:\n  npm run qr -- https://your-tunnel.trycloudflare.com");
  process.exit(1);
}
if (!token) {
  console.error("HUB_TOKEN is not set in .env - nothing to pair with.");
  process.exit(1);
}

const payload = JSON.stringify({ app: "brand-studio", hub: url, token });

console.log(`\nPairing code for ${url}`);
console.log("On your phone: Setup -> Scan setup code\n");
qrcode.generate(payload, { small: true });
console.log("\nAnyone who scans this code gets full access to your hub - don't share it.\n");
