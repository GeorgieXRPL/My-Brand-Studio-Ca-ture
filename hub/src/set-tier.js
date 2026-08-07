// Manually assign a plan tier until billing exists.
// Usage: npm run set-tier -- user@email.com creator|studio|free
import { db } from "./db.js";

const [email, tier] = process.argv.slice(2);
const valid = ["free", "creator", "studio"];

if (!email || !valid.includes(tier)) {
  console.log("Usage: npm run set-tier -- <email> <free|creator|studio>");
  process.exit(1);
}

const info = db.prepare("UPDATE users SET tier = ? WHERE email = ?").run(tier, email.toLowerCase());
if (!info.changes) {
  console.error(`No user found with email ${email}`);
  process.exit(1);
}
console.log(`${email} is now on the ${tier} tier.`);
