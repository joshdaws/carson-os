/**
 * Tool secret encryption using AES-256-GCM.
 *
 * Key derivation:
 *   1. If CARSONOS_SECRET env var is set: PBKDF2 with fixed salt
 *   2. Otherwise: generate a 32-byte key and persist to ~/.carsonos/.secret
 *      with mode 0600. The operator MUST back up this file or all stored
 *      secrets become undecryptable.
 *
 * Encrypted format: base64( iv[12] || authTag[16] || ciphertext )
 */

import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PBKDF2_SALT = Buffer.from("carsonos-tool-secrets-v1");
const PBKDF2_ITERATIONS = 100_000;
const KEY_LEN = 32; // 256 bits
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey: Buffer | null = null;

/**
 * Derive or load the encryption key. Cached per-process.
 * Override for tests via `setKeyForTesting`.
 */
export function getEncryptionKey(dataDir?: string): Buffer {
  if (cachedKey) return cachedKey;

  const envSecret = process.env.CARSONOS_SECRET;
  if (envSecret) {
    cachedKey = pbkdf2Sync(envSecret, PBKDF2_SALT, PBKDF2_ITERATIONS, KEY_LEN, "sha256");
    return cachedKey;
  }

  const keyfile = join(dataDir ?? homedir() + "/.carsonos", ".secret");
  if (existsSync(keyfile)) {
    const raw = readFileSync(keyfile);
    if (raw.length !== KEY_LEN) {
      throw new Error(
        `Keyfile at ${keyfile} is corrupted (expected ${KEY_LEN} bytes, got ${raw.length}). ` +
          `Restore from backup or delete and re-enter secrets.`,
      );
    }
    cachedKey = raw;
    return cachedKey;
  }

  // Generate and persist
  const newKey = randomBytes(KEY_LEN);
  writeFileSync(keyfile, newKey);
  try {
    chmodSync(keyfile, 0o600);
  } catch {
    /* chmod unsupported on some filesystems; continue */
  }
  console.warn(
    `[tool-secrets] Generated new encryption key at ${keyfile}. ` +
      `BACK IT UP. If lost, all stored tool secrets become undecryptable.`,
  );
  cachedKey = newKey;
  return cachedKey;
}

/** For tests only. */
export function setKeyForTesting(key: Buffer | null): void {
  cachedKey = key;
}

/** Encrypt plaintext. Returns base64 string. */
export function encryptSecret(plaintext: string, dataDir?: string): string {
  const key = getEncryptionKey(dataDir);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

/** Decrypt ciphertext. Throws on tamper or key mismatch. */
export function decryptSecret(encoded: string, dataDir?: string): string {
  const key = getEncryptionKey(dataDir);
  const buf = Buffer.from(encoded, "base64");
  if (buf.length < IV_LEN + TAG_LEN) {
    throw new Error("Encrypted secret is too short (corrupted or wrong format)");
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** Round-trip test used at boot to verify the key still decrypts existing secrets. */
export function verifyKeyWorks(sampleEncrypted: string, dataDir?: string): boolean {
  try {
    decryptSecret(sampleEncrypted, dataDir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Simple redaction helper. Given a list of secret values, replace each occurrence
 * in the input string with [REDACTED:key_name]. Used by activity_log writes.
 */
export function redactSecrets(
  input: string,
  secrets: Array<{ keyName: string; value: string }>,
): string {
  let out = input;
  for (const { keyName, value } of secrets) {
    if (!value) continue;
    // Only redact values longer than 6 chars to avoid trivial matches
    if (value.length < 6) continue;
    out = out.split(value).join(`[REDACTED:${keyName}]`);
  }
  return out;
}

/** Constant-time comparison of two secret strings (e.g. for token checks). */
export function secretsEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}
