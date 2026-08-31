import { scrypt as nodeScrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import argon2 from "argon2";
const HASH_BYTES = 32;
const MAX_PASSWORD_BYTES = 1024;

/**
 * Password hashing is behind this interface so tests can supply a deterministic
 * implementation. Production defaults to Argon2id; the legacy scrypt helpers
 * remain here only to verify pre-release records if one was ever created.
 */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, encoded: string): Promise<boolean>;
}

export const defaultPasswordHasher: PasswordHasher = {
  hash: hashPassword,
  verify: verifyPassword
};

export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
    hashLength: HASH_BYTES
  });
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  try {
    validatePassword(password);
    if (encoded.startsWith("$argon2id$")) {
      return await argon2.verify(encoded, password);
    }
    return verifyLegacyScrypt(password, encoded);
  } catch {
    return false;
  }
}

/** Compatibility-only parser for values produced during early v2 development. */
async function verifyLegacyScrypt(password: string, encoded: string): Promise<boolean> {
  try {
    const match = /^scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/.exec(encoded);
    if (!match) return false;
    const [, nText, rText, pText, saltText, hashText] = match;
    const n = Number(nText);
    const r = Number(rText);
    const p = Number(pText);
    const salt = Buffer.from(saltText, "base64url");
    const expected = Buffer.from(hashText, "base64url");
    if (!Number.isSafeInteger(n) || n < 2 || (n & (n - 1)) !== 0 || r < 1 || p < 1 || salt.length < 8 || expected.length !== HASH_BYTES) return false;
    const actual = await derive(password, salt, expected.length, { N: n, r, p, maxmem: 128 * 1024 * 1024 });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch { return false; }
}

function derive(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(password, salt, keyLength, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

function validatePassword(password: string): void {
  if (typeof password !== "string" || password.length === 0) throw new Error("Password is required.");
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) throw new Error("Password is too long.");
}
