import { randomUUID } from "node:crypto";
import type {
  AdminRecord,
  AdminSessionRecord,
  AdminStore,
  ApiKeyCreateInput,
  ApiKeyMetadata,
  ApiRecord,
  ConsumerApiRoleRecord,
  ConsumerRecord,
  RolePermissionRecord,
  RoleRecord,
} from "./types.js";

/**
 * Small in-memory adapter used by the setup UI tests and local smoke examples.
 * The production server should supply the SQLite adapter from src/v2/data.
 */
export class MemoryAdminStore implements AdminStore {
  readonly admins = new Map<string, AdminRecord>();
  readonly sessions = new Map<string, AdminSessionRecord>();
  readonly apis = new Map<string, ApiRecord>();
  readonly roles = new Map<string, RoleRecord>();
  readonly permissions = new Map<string, RolePermissionRecord[]>();
  readonly consumers = new Map<string, ConsumerRecord>();
  readonly assignments = new Map<string, ConsumerApiRoleRecord>();
  readonly keys = new Map<string, ApiKeyMetadata & { secretHash: string }>();

  private id(): string { return randomUUID(); }
  private timestamp(): string { return new Date().toISOString(); }
  private assignmentKey(consumerId: string, apiId: string): string { return `${consumerId}:${apiId}`; }

  countAdmins(): number { return this.admins.size; }
  createAdmin(input: { email: string; passwordHash: string }): AdminRecord {
    if ([...this.admins.values()].some((a) => a.email === input.email)) throw new Error("duplicate admin email");
    const row = { id: this.id(), ...input, enabled: true, createdAt: this.timestamp() };
    this.admins.set(row.id, row); return row;
  }
  findAdminByEmail(email: string): AdminRecord | null { return [...this.admins.values()].find((a) => a.email === email) ?? null; }
  findAdminById(id: string): AdminRecord | null { return this.admins.get(id) ?? null; }

  createSession(input: Omit<AdminSessionRecord, "id" | "createdAt">): AdminSessionRecord {
    const row = { id: this.id(), createdAt: this.timestamp(), ...input };
    this.sessions.set(row.tokenHash, row); return row;
  }
  findSessionByTokenHash(tokenHash: string): AdminSessionRecord | null { return this.sessions.get(tokenHash) ?? null; }
  revokeSession(tokenHash: string, revokedAt: string): void {
    const row = this.sessions.get(tokenHash); if (row) row.revokedAt = revokedAt;
  }

  listApis(): ApiRecord[] { return [...this.apis.values()]; }
  findApi(id: string): ApiRecord | null { return this.apis.get(id) ?? null; }
  createApi(input: Omit<ApiRecord, "id" | "createdAt">): ApiRecord {
    if ([...this.apis.values()].some((a) => a.slug === input.slug)) throw new Error("duplicate api slug");
    const row = { id: this.id(), createdAt: this.timestamp(), ...input }; this.apis.set(row.id, row); return row;
  }
  updateApi(id: string, patch: Partial<Omit<ApiRecord, "id" | "createdAt">>): ApiRecord | null {
    const row = this.apis.get(id); if (!row) return null; Object.assign(row, patch); return row;
  }

  listRoles(): RoleRecord[] { return [...this.roles.values()]; }
  findRole(id: string): RoleRecord | null { return this.roles.get(id) ?? null; }
  createRole(input: Omit<RoleRecord, "id" | "createdAt">): RoleRecord {
    if ([...this.roles.values()].some((r) => r.name === input.name)) throw new Error("duplicate role name");
    const row = { id: this.id(), createdAt: this.timestamp(), ...input }; this.roles.set(row.id, row); return row;
  }
  updateRole(id: string, patch: Partial<Omit<RoleRecord, "id" | "createdAt">>): RoleRecord | null {
    const row = this.roles.get(id); if (!row) return null; Object.assign(row, patch); return row;
  }
  listRolePermissions(roleId: string): RolePermissionRecord[] { return [...(this.permissions.get(roleId) ?? [])]; }
  replaceRolePermissions(roleId: string, permissions: Array<Omit<RolePermissionRecord, "id" | "roleId">>): RolePermissionRecord[] {
    const rows = permissions.map((p) => ({ ...p, id: this.id(), roleId })); this.permissions.set(roleId, rows); return rows;
  }

  listConsumers(): ConsumerRecord[] { return [...this.consumers.values()]; }
  findConsumer(id: string): ConsumerRecord | null { return this.consumers.get(id) ?? null; }
  createConsumer(input: Omit<ConsumerRecord, "id" | "createdAt">): ConsumerRecord {
    const row = { id: this.id(), createdAt: this.timestamp(), ...input }; this.consumers.set(row.id, row); return row;
  }
  updateConsumer(id: string, patch: Partial<Omit<ConsumerRecord, "id" | "createdAt">>): ConsumerRecord | null {
    const row = this.consumers.get(id); if (!row) return null; Object.assign(row, patch); return row;
  }

  listAssignments(filters: { consumerId?: string; apiId?: string } = {}): ConsumerApiRoleRecord[] {
    return [...this.assignments.values()].filter((a) => (!filters.consumerId || a.consumerId === filters.consumerId) && (!filters.apiId || a.apiId === filters.apiId));
  }
  upsertAssignment(input: ConsumerApiRoleRecord): ConsumerApiRoleRecord {
    this.assignments.set(this.assignmentKey(input.consumerId, input.apiId), input); return input;
  }
  updateAssignment(consumerId: string, apiId: string, patch: Partial<Pick<ConsumerApiRoleRecord, "roleId" | "enabled">>): ConsumerApiRoleRecord | null {
    const row = this.assignments.get(this.assignmentKey(consumerId, apiId)); if (!row) return null; Object.assign(row, patch); return row;
  }

  listApiKeys(consumerId: string): ApiKeyMetadata[] { return [...this.keys.values()].filter((k) => k.consumerId === consumerId).map(({ secretHash: _secretHash, ...k }) => k); }
  createApiKey(input: ApiKeyCreateInput): ApiKeyMetadata {
    const { secretHash, ...metadata } = input; this.keys.set(metadata.keyId, { ...metadata, secretHash }); return metadata;
  }
  revokeApiKey(keyId: string, revokedAt: string): ApiKeyMetadata | null {
    const row = this.keys.get(keyId); if (!row) return null; row.revokedAt = revokedAt; const { secretHash: _secretHash, ...metadata } = row; return metadata;
  }
  findApiKey(keyId: string): ApiKeyMetadata | null {
    const row = this.keys.get(keyId); if (!row) return null; const { secretHash: _secretHash, ...metadata } = row; return metadata;
  }
}
