import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * api/_lib/secret-box.js (#247/#892) — AES-256-GCM envelopes for integration
 * credentials. Round trip, IV uniqueness, tamper/wrong-key/wrong-AAD
 * rejection, malformed envelopes, and redacted errors (no plaintext or key
 * material in any message).
 */

const requireFromHere = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const secretBox = requireFromHere("../../../api/_lib/secret-box.js");

const KEY = Buffer.alloc(32, 7).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 9).toString("base64");
const env = { XERO_TOKEN_ENC_KEY: KEY };
const AAD = "integration:xero:access";
const SECRET = "super-secret-refresh-token-value";

describe("secret-box", () => {
  it("round-trips a secret", () => {
    const envelope = secretBox.seal(SECRET, { aad: AAD, env });
    expect(envelope.startsWith("v1.")).toBe(true);
    expect(envelope).not.toContain(SECRET);
    expect(secretBox.open(envelope, { aad: AAD, env })).toBe(SECRET);
  });

  it("produces unique ciphertext for identical plaintext (fresh IV)", () => {
    const a = secretBox.seal(SECRET, { aad: AAD, env });
    const b = secretBox.seal(SECRET, { aad: AAD, env });
    expect(a).not.toBe(b);
  });

  it("detects ciphertext tampering", () => {
    const envelope = secretBox.seal(SECRET, { aad: AAD, env });
    const parts = envelope.split(".");
    // flip the FIRST ciphertext character (always 6 significant bits — the
    // last char's low bits are padding and a flip there may decode identically)
    parts[2] = (parts[2].startsWith("A") ? "B" : "A") + parts[2].slice(1);
    expect(() => secretBox.open(parts.join("."), { aad: AAD, env })).toThrowError(
      expect.objectContaining({ code: "decrypt_failed" })
    );
  });

  it("fails with the wrong key", () => {
    const envelope = secretBox.seal(SECRET, { aad: AAD, env });
    expect(() =>
      secretBox.open(envelope, { aad: AAD, env: { XERO_TOKEN_ENC_KEY: OTHER_KEY } })
    ).toThrowError(expect.objectContaining({ code: "decrypt_failed" }));
  });

  it("binds the AAD — an access envelope cannot open as a refresh envelope", () => {
    const envelope = secretBox.seal(SECRET, { aad: AAD, env });
    expect(() =>
      secretBox.open(envelope, { aad: "integration:xero:refresh", env })
    ).toThrowError(expect.objectContaining({ code: "decrypt_failed" }));
  });

  it("rejects malformed envelopes and unsupported versions", () => {
    expect(() => secretBox.open("not-an-envelope", { aad: AAD, env })).toThrowError(
      expect.objectContaining({ code: "malformed_envelope" })
    );
    expect(() => secretBox.open("v9.a.b.c", { aad: AAD, env })).toThrowError(
      expect.objectContaining({ code: "unsupported_version" })
    );
    expect(() => secretBox.open("v1.a.b", { aad: AAD, env })).toThrowError(
      expect.objectContaining({ code: "malformed_envelope" })
    );
  });

  it("rejects a missing or malformed key, with a value-free message", () => {
    expect(() => secretBox.seal(SECRET, { aad: AAD, env: {} })).toThrowError(
      expect.objectContaining({ code: "key_missing" })
    );
    expect(() =>
      secretBox.seal(SECRET, { aad: AAD, env: { XERO_TOKEN_ENC_KEY: "dG9vLXNob3J0" } })
    ).toThrowError(expect.objectContaining({ code: "key_invalid" }));
    expect(secretBox.encryptionKeyConfigured({})).toBe(false);
    expect(secretBox.encryptionKeyConfigured(env)).toBe(true);
  });

  it("never leaks plaintext or key material in error messages", () => {
    const envelope = secretBox.seal(SECRET, { aad: AAD, env });
    const tampered = "v1." + envelope.split(".").slice(1).reverse().join(".");
    try {
      secretBox.open(tampered, { aad: AAD, env });
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = String((err as Error).message) + String((err as Error).stack || "");
      expect(msg).not.toContain(SECRET);
      expect(msg).not.toContain(KEY);
    }
  });

  it("refuses empty plaintext", () => {
    expect(() => secretBox.seal("", { aad: AAD, env })).toThrowError(
      expect.objectContaining({ code: "empty_plaintext" })
    );
  });
});
