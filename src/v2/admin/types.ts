import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { UpstreamValidationOptions } from "../proxy/upstream.js";

export interface AdminRecord {
  id: string;
  email: string;
  passwordHash: string;
  enabled: boolean;
  createdAt: string;
}

export interface AdminSessionRecord {
  id: string;
  adminId: string;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
  revokedAt?: string | null;
}

export interface ApiRecord {
  id: string;
  name: string;
  slug: string;
  upstreamBaseUrl: string;
  enabled: boolean;
  createdAt: string;
}

export interface RoleRecord {
  id: string;
  name: string;
  description?: string | null;
  rateLimitCount?: number | null;
  rateLimitWindowSeconds?: number | null;
  quotaCount?: number | null;
  quotaPeriod?: "day" | "month" | null;
  enabled: boolean;
  createdAt: string;
}

export interface RolePermissionRecord {
  id: string;
  roleId: string;
  apiId?: string | null;
  method: string;
  pathPattern: string;
}

export interface ConsumerRecord {
  id: string;
  name: string;
  externalReference?: string | null;
  enabled: boolean;
  createdAt: string;
}

export interface ConsumerApiRoleRecord {
  consumerId: string;
  apiId: string;
  roleId: string;
  assignedAt: string;
  enabled: boolean;
}

export interface ApiKeyMetadata {
  id: string;
  consumerId: string;
  keyId: string;
  label?: string | null;
  createdAt: string;
  expiresAt?: string | null;
  revokedAt?: string | null;
  lastUsedAt?: string | null;
}

export interface ApiKeyCreateInput extends ApiKeyMetadata {
  secretHash: string;
}

export interface AdminAuditEvent {
  occurredAt: string;
  adminId?: string | null;
  action: string;
  resource: string;
  resourceId?: string | null;
}

export interface GatewayAuditEvent {
  id?: number;
  occurredAt: string;
  requestId: string;
  apiId: string | null;
  consumerId: string | null;
  roleId: string | null;
  keyId: string | null;
  method: string;
  path: string;
  statusCode: number;
  outcome: string;
  reason?: string | null;
  latencyMs: number;
  upstreamStatus?: number | null;
}

export interface AdminStore {
  countAdmins(): Promise<number> | number;
  createAdmin(input: { email: string; passwordHash: string }): Promise<AdminRecord> | AdminRecord;
  findAdminByEmail(email: string): Promise<AdminRecord | null> | AdminRecord | null;
  findAdminById(id: string): Promise<AdminRecord | null> | AdminRecord | null;

  createSession(input: Omit<AdminSessionRecord, "id" | "createdAt">): Promise<AdminSessionRecord> | AdminSessionRecord;
  findSessionByTokenHash(tokenHash: string): Promise<AdminSessionRecord | null> | AdminSessionRecord | null;
  revokeSession(tokenHash: string, revokedAt: string): Promise<void> | void;

  listApis(): Promise<ApiRecord[]> | ApiRecord[];
  findApi(id: string): Promise<ApiRecord | null> | ApiRecord | null;
  createApi(input: Omit<ApiRecord, "id" | "createdAt">): Promise<ApiRecord> | ApiRecord;
  updateApi(id: string, patch: Partial<Omit<ApiRecord, "id" | "createdAt">>): Promise<ApiRecord | null> | ApiRecord | null;

  listRoles(): Promise<RoleRecord[]> | RoleRecord[];
  findRole(id: string): Promise<RoleRecord | null> | RoleRecord | null;
  createRole(input: Omit<RoleRecord, "id" | "createdAt">): Promise<RoleRecord> | RoleRecord;
  updateRole(id: string, patch: Partial<Omit<RoleRecord, "id" | "createdAt">>): Promise<RoleRecord | null> | RoleRecord | null;
  listRolePermissions(roleId: string): Promise<RolePermissionRecord[]> | RolePermissionRecord[];
  replaceRolePermissions(roleId: string, permissions: Array<Omit<RolePermissionRecord, "id" | "roleId">>): Promise<RolePermissionRecord[]> | RolePermissionRecord[];

  listConsumers(): Promise<ConsumerRecord[]> | ConsumerRecord[];
  findConsumer(id: string): Promise<ConsumerRecord | null> | ConsumerRecord | null;
  createConsumer(input: Omit<ConsumerRecord, "id" | "createdAt">): Promise<ConsumerRecord> | ConsumerRecord;
  updateConsumer(id: string, patch: Partial<Omit<ConsumerRecord, "id" | "createdAt">>): Promise<ConsumerRecord | null> | ConsumerRecord | null;

  listAssignments(filters?: { consumerId?: string; apiId?: string }): Promise<ConsumerApiRoleRecord[]> | ConsumerApiRoleRecord[];
  upsertAssignment(input: ConsumerApiRoleRecord): Promise<ConsumerApiRoleRecord> | ConsumerApiRoleRecord;
  updateAssignment(consumerId: string, apiId: string, patch: Partial<Pick<ConsumerApiRoleRecord, "roleId" | "enabled">>): Promise<ConsumerApiRoleRecord | null> | ConsumerApiRoleRecord | null;

  listApiKeys(consumerId: string): Promise<ApiKeyMetadata[]> | ApiKeyMetadata[];
  createApiKey(input: ApiKeyCreateInput): Promise<ApiKeyMetadata> | ApiKeyMetadata;
  revokeApiKey(keyId: string, revokedAt: string): Promise<ApiKeyMetadata | null> | ApiKeyMetadata | null;
  findApiKey(keyId: string): Promise<ApiKeyMetadata | null> | ApiKeyMetadata | null;

  /** Optional control-plane audit hooks. The proxy audit stream may use a richer repository. */
  appendAdminAudit?(event: AdminAuditEvent): Promise<void> | void;
  listAdminAudit?(filters?: { action?: string; resource?: string; limit?: number; offset?: number }): Promise<AdminAuditEvent[]> | AdminAuditEvent[];
  listAuditEvents?(filters?: { apiId?: string; consumerId?: string; outcome?: string; requestId?: string; limit?: number; offset?: number }): Promise<GatewayAuditEvent[]> | GatewayAuditEvent[];
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, encoded: string): Promise<boolean>;
}

export interface AdminRouteOptions {
  store: AdminStore;
  prefix?: string;
  sessionCookieName?: string;
  csrfCookieName?: string;
  sessionTtlSeconds?: number;
  secureCookies?: boolean;
  keyPepper?: string;
  sessionSecret?: string;
  upstreamValidationOptions?: UpstreamValidationOptions;
  passwordHasher?: PasswordHasher;
  now?: () => Date;
  idFactory?: () => string;
}

export interface AdminRequest extends FastifyRequest {
  openGateAdmin?: AdminRecord;
  openGateSession?: AdminSessionRecord;
}

export type AdminReply = FastifyReply;
export type AdminApp = FastifyInstance;
