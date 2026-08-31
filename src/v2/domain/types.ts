/** Shared, persistence-agnostic types used by the v2 domain layer. */

export type QuotaPeriod = "day" | "month";

export interface RoleLimits {
  /** Maximum requests in a rolling token-bucket window. */
  rateLimitCount?: number | null;
  rateLimitWindowSeconds?: number | null;
  /** Maximum requests in the current calendar period. */
  quotaCount?: number | null;
  quotaPeriod?: QuotaPeriod | null;
}

export interface RolePermission {
  /** Null/undefined applies to every API; otherwise this API id only. */
  apiId?: string | null;
  method: string;
  pathPattern: string;
}

export interface RoleDefinition extends RoleLimits {
  id: string;
  enabled?: boolean;
  permissions: readonly RolePermission[];
}

export interface ApiKeyRecord {
  keyId: string;
  secretHash: string;
  expiresAt?: Date | string | number | null;
  revokedAt?: Date | string | number | null;
}

export interface TokenBucketState {
  tokens: number;
  updatedAtMs: number;
}

export interface QuotaState {
  count: number;
  bucketKey: string;
}
