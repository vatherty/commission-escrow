import { describe, expect, test } from "bun:test";
import { scryptSync } from "node:crypto";
import { hashPassword, newInviteCode, newToken, tokenHash, verifyPassword } from "../server/src/auth";

/* Gate A parity: password fixtures generated with the OLD (artifact)
   code's exact parameters must verify under the standalone verifier —
   the stored formats are the contract.
   - Argon2id: Bun.password, memoryCost 19456, timeCost 2 → "$argon2id$…"
   - scrypt current: N=2^17, r=8, p=1, maxmem 256MB → "scrypt$131072$<salt>$<hash>"
   - scrypt legacy: Node default cost → "<salt>:<hash>" */

const PW = "correct horse battery staple 9";

describe("password hash format parity", () => {
  test("argon2id fixture (old parameters) verifies", async () => {
    const stored = await Bun.password.hash(PW, { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 });
    expect(stored.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(PW, stored)).toBe(true);
    expect(await verifyPassword("wrong password entirely", stored)).toBe(false);
  });

  test("scrypt$ fixture (N=2^17) verifies", async () => {
    const salt = "0123456789abcdeffedcba9876543210";
    const hash = scryptSync(PW, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }).toString("hex");
    const stored = `scrypt$131072$${salt}$${hash}`;
    expect(await verifyPassword(PW, stored)).toBe(true);
    expect(await verifyPassword("wrong password entirely", stored)).toBe(false);
  });

  test("legacy salt:hash fixture (Node default scrypt) verifies", async () => {
    const salt = "aabbccddeeff00112233445566778899";
    const hash = scryptSync(PW, salt, 64).toString("hex");
    const stored = `${salt}:${hash}`;
    expect(await verifyPassword(PW, stored)).toBe(true);
    expect(await verifyPassword("wrong password entirely", stored)).toBe(false);
  });

  test("new hashes use the preferred format and verify", async () => {
    const stored = await hashPassword(PW);
    expect(stored.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(PW, stored)).toBe(true);
  });

  test("malformed stored hashes never verify", async () => {
    expect(await verifyPassword(PW, "")).toBe(false);
    expect(await verifyPassword(PW, "scrypt$only$two")).toBe(false);
    expect(await verifyPassword(PW, "nocolon")).toBe(false);
  });
});

describe("token + invite primitives", () => {
  test("session tokens are 256-bit hex; hashes are sha256 hex", () => {
    const t = newToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash(t)).not.toBe(t);
    expect(newToken()).not.toBe(t);
  });

  test("invite codes: 15 unambiguous chars grouped 5-5-5", () => {
    for (let i = 0; i < 20; i++) {
      const code = newInviteCode();
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    }
  });
});
