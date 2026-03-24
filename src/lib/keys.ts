import type { Config } from "./config.js";

export type ApiKeyRecord = {
  key: string;
  name: string;
  scopes: string[];
};

export function getApiKey(config: Config, rawKey: string | undefined): ApiKeyRecord | null {
  if (!rawKey) {
    return null;
  }

  const match = config.auth.keys.find((item) => item.key === rawKey);
  return match ?? null;
}

export function hasScopes(keyRecord: ApiKeyRecord, requiredScopes: string[]): boolean {
  if (!requiredScopes.length) {
    return true;
  }

  return requiredScopes.every((scope) => keyRecord.scopes.includes(scope));
}
