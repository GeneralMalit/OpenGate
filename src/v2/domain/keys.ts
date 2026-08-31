import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ApiKeyRecord } from "./types.js";

const KEY_PREFIX = "ogk";
const KEY_ID_BYTES = 12;
const SECRET_BYTES = 32;
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface IssuedApiKey {
  /** The complete secret. Return this to an administrator once only. */
  rawKey: string;
  keyId: string;
  secretHash: string;
}

export interface ParsedApiKey {
  keyId: string;
  secret: string;
}

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}

/** Generate a key whose raw value is safe to show once and never persist. */
export function issueApiKey(pepper: string, random = randomBytes): IssuedApiKey {
  if (!pepper) throw new Error("API-key pepper is required.");
  const keyId = base64Url(random(KEY_ID_BYTES));
  const secret = base64Url(random(SECRET_BYTES));
  const rawKey = `${KEY_PREFIX}_${keyId}_${secret}`;
  return { rawKey, keyId, secretHash: hashApiKeySecret(secret, pepper) };
}

export function parseApiKey(rawKey: string): ParsedApiKey | null {
  if (typeof rawKey !== "string") return null;
  if (!rawKey.startsWith(`${KEY_PREFIX}_`)) return null;
  const keyId = rawKey.slice(KEY_PREFIX.length + 1, KEY_PREFIX.length + 1 + 16);
  const separator = KEY_PREFIX.length + 1 + 16;
  if (rawKey[separator] !== "_") return null;
  const secret = rawKey.slice(separator + 1);
  if (!KEY_ID_PATTERN.test(keyId) || !SECRET_PATTERN.test(secret)) return null;
  return { keyId, secret };
}

/** HMAC, rather than a bare digest, makes a database leak insufficient to test keys offline. */
export function hashApiKeySecret(secret: string, pepper: string): string {
  if (!pepper) throw new Error("API-key pepper is required.");
  return createHmac("sha256", pepper).update(secret, "utf8").digest("hex");
}

export interface ApiKeyVerificationOptions {
  now?: Date;
  consumerEnabled?: boolean;
}

export function verifyApiKey(
  rawKey: string,
  record: ApiKeyRecord,
  pepper: string,
  options: ApiKeyVerificationOptions = {}
): boolean {
  const parsed = parseApiKey(rawKey);
  if (!parsed || parsed.keyId !== record.keyId || options.consumerEnabled === false) return false;
  if (record.revokedAt != null || isExpired(record.expiresAt, options.now ?? new Date())) return false;

  const expected = Buffer.from(record.secretHash, "hex");
  const actual = Buffer.from(hashApiKeySecret(parsed.secret, pepper), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function isExpired(value: Date | string | number | null | undefined, now: Date): boolean {
  if (value == null) return false;
  const expires = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return !Number.isFinite(expires) || expires <= now.getTime();
}

export const API_KEY_FORMAT = "ogk_<16-char-key-id>_<43-char-secret>";
