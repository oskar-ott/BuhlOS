// secret-box — AES-256-GCM envelopes for integration credentials (#247/#892).
//
// The ONLY module allowed to decrypt integration_connections token columns
// (docs/architecture/integration-credential-storage-adr.md). Envelope format:
//
//   v1.<base64url iv>.<base64url ciphertext>.<base64url auth-tag>
//
// * key: XERO_TOKEN_ENC_KEY env — 32 bytes, base64 (standard or url-safe),
//   per-environment, server-only. Validated on first use; never logged.
// * a fresh random 12-byte IV per encryption (identical plaintexts never
//   produce identical envelopes).
// * AAD binds the ciphertext to its purpose (e.g. 'integration:xero:refresh')
//   so an access-token envelope can't be replayed into the refresh column.
// * the 'v1' prefix is the key/format version — future key rotation can add
//   'v2' without pretending rotation is implemented today.
//
// Errors are TYPED and REDACTED: no plaintext, ciphertext or key material
// ever appears in an error message.

const crypto = require('crypto');

const ENV_KEY = 'XERO_TOKEN_ENC_KEY';
const VERSION = 'v1';
const IV_BYTES = 12;
const KEY_BYTES = 32;

class SecretBoxError extends Error {
  /** @param {'key_missing'|'key_invalid'|'malformed_envelope'|'unsupported_version'|'decrypt_failed'|'empty_plaintext'} code */
  constructor(code) {
    super(`secret-box: ${code}`);
    this.name = 'SecretBoxError';
    this.code = code;
  }
}

/** True when the encryption key env var is present AND well-formed. */
function encryptionKeyConfigured(env = process.env) {
  try {
    loadKey(env);
    return true;
  } catch {
    return false;
  }
}

function loadKey(env = process.env) {
  const raw = env[ENV_KEY];
  if (!raw || !String(raw).trim()) throw new SecretBoxError('key_missing');
  let key;
  try {
    // Accept standard or url-safe base64; Node's 'base64' decoder takes both.
    key = Buffer.from(String(raw).trim(), 'base64');
  } catch {
    throw new SecretBoxError('key_invalid');
  }
  if (key.length !== KEY_BYTES) throw new SecretBoxError('key_invalid');
  return key;
}

/**
 * Encrypt a secret string into a v1 envelope.
 * @param {string} plaintext non-empty secret
 * @param {{ aad: string, env?: object }} opts aad is REQUIRED — bind to purpose
 */
function seal(plaintext, opts) {
  if (typeof plaintext !== 'string' || plaintext === '') {
    throw new SecretBoxError('empty_plaintext');
  }
  const aad = opts && opts.aad;
  if (!aad || typeof aad !== 'string') throw new Error('secret-box: aad required');
  const key = loadKey(opts.env);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64url'),
    ct.toString('base64url'),
    tag.toString('base64url'),
  ].join('.');
}

/**
 * Decrypt a v1 envelope. Throws SecretBoxError on any tamper/format/key
 * problem — callers treat every failure as "credential unusable", never retry.
 * @param {string} envelope
 * @param {{ aad: string, env?: object }} opts must match the seal() aad
 */
function open(envelope, opts) {
  const aad = opts && opts.aad;
  if (!aad || typeof aad !== 'string') throw new Error('secret-box: aad required');
  if (typeof envelope !== 'string') throw new SecretBoxError('malformed_envelope');
  const parts = envelope.split('.');
  if (parts.length !== 4) throw new SecretBoxError('malformed_envelope');
  const [version, ivB64, ctB64, tagB64] = parts;
  if (version !== VERSION) throw new SecretBoxError('unsupported_version');
  const key = loadKey(opts.env);
  let iv, ct, tag;
  try {
    iv = Buffer.from(ivB64, 'base64url');
    ct = Buffer.from(ctB64, 'base64url');
    tag = Buffer.from(tagB64, 'base64url');
  } catch {
    throw new SecretBoxError('malformed_envelope');
  }
  if (iv.length !== IV_BYTES || tag.length !== 16) {
    throw new SecretBoxError('malformed_envelope');
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key, wrong AAD, or tampered ciphertext — indistinguishable by
    // design, and the message must never say more.
    throw new SecretBoxError('decrypt_failed');
  }
}

module.exports = {
  ENV_KEY,
  SecretBoxError,
  encryptionKeyConfigured,
  seal,
  open,
};
