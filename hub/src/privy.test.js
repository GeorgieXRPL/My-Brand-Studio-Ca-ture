import test from "node:test";
import assert from "node:assert/strict";
import { emailFromPrivyProfile, syntheticPrivyEmail } from "./privy.js";

test("prefers a linked email account", () => {
  const email = emailFromPrivyProfile({
    linked_accounts: [
      { type: "wallet", address: "0xabc" },
      { type: "email", address: "Ada@Example.com" },
      { type: "google_oauth", email: "other@example.com" },
    ],
  });
  assert.equal(email, "ada@example.com");
});

test("falls back to oauth email and camelCase linkedAccounts", () => {
  const email = emailFromPrivyProfile({
    linkedAccounts: [{ type: "google_oauth", email: "Ada@Example.com" }],
  });
  assert.equal(email, "ada@example.com");
});

test("returns empty when only a wallet is linked", () => {
  assert.equal(emailFromPrivyProfile({ linked_accounts: [{ type: "wallet", address: "0xabc" }] }), "");
});

test("builds a stable synthetic email from a Privy DID", () => {
  assert.equal(
    syntheticPrivyEmail("did:privy:clxyz123"),
    "privy.clxyz123@users.privy.invalid"
  );
});
