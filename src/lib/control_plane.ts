import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createGateEngine } from "./engine.js";
import { resolveRoutePolicy } from "./policies.js";
import { loadConfig, migrateConfig, validateConfig } from "./config.js";
import { hashApiKey } from "./auth.js";
import type { RequestEnvelope } from "./request.js";
import type {
  ApiClientConfig,
  OpenGateConfig,
  RequestIdentity,
  ResolvedRoutePolicy,
  RoutePolicyConfig,
  UserConfig
} from "./types.js";

export type ControlPlaneResource = "organizations" | "users" | "apiKeys" | "routePolicies" | "config";

export type ControlPlaneLoggerAdapter = {
  emit: (event: ControlPlaneLogEvent) => void | Promise<void>;
  close?: () => Promise<void> | void;
};

export type ControlPlaneLogEvent = {
  timestamp: string;
  action: "get" | "export" | "import" | "issue" | "rotate" | "revoke" | "enable" | "disable" | "simulate" | "upsert";
  resource: ControlPlaneResource;
  targetId: string | null;
  actorIdentityType?: RequestIdentity["identityType"];
  actorSubject?: string;
  requestId?: string;
  summary?: string;
  diff?: Record<string, { before: unknown; after: unknown }>;
  details?: Record<string, unknown>;
};

export type ControlPlaneSimulationRequest = {
  method: string;
  path: string;
  headers?: Record<string, string | string[]>;
  cookies?: Record<string, string>;
  ip?: string;
  requestId?: string;
};

export type ControlPlaneSimulationResult = {
  requestId: string;
  routePolicyId: string;
  allowed: boolean;
  statusCode: number;
  message: string;
  blockReason: string | null;
  identityType: RequestIdentity["identityType"];
  identity: RequestIdentity;
};

export type ControlPlaneMutationResult<T> = {
  action: string;
  resource: ControlPlaneResource;
  targetId: string;
  before: T | null;
  after: T | null;
  diff: Record<string, { before: unknown; after: unknown }>;
};

export type IssueApiKeyInput = {
  clientId?: string;
  name: string;
  organizationId: string;
  userId: string;
  rawKey?: string;
  scopes?: string[];
  enabled?: boolean;
};

export type IssueApiKeyResult = ControlPlaneMutationResult<ApiClientConfig> & {
  rawKey: string;
};

export type RotateApiKeyInput = {
  clientId: string;
  versionId?: string;
  rawKey?: string;
  scopes?: string[];
  enabled?: boolean;
  notBefore?: string;
  expiresAt?: string;
};

export type RotateApiKeyResult = ControlPlaneMutationResult<ApiClientConfig> & {
  rawKey: string;
  versionId: string;
};

export type RevokeApiKeyInput = {
  clientId: string;
  versionId?: string;
};

export type ControlPlaneSource = {
  config?: OpenGateConfig;
  configPath?: string;
  autoSave?: boolean;
  logger?: ControlPlaneLoggerAdapter;
};

export type ControlPlaneRouteOptions = {
  basePath?: string;
  accessMode?: "authenticated" | "jwt" | "api_key";
};

export type ControlPlaneWorkspace = {
  readonly config: OpenGateConfig;
  load: () => OpenGateConfig;
  save: () => void;
  replaceConfig: (raw: unknown) => OpenGateConfig;
  exportConfig: () => string;
  listOrganizations: () => OpenGateConfig["organizations"];
  getOrganization: (id: string) => OpenGateConfig["organizations"][number] | null;
  upsertOrganization: (
    input: OpenGateConfig["organizations"][number]
  ) => ControlPlaneMutationResult<OpenGateConfig["organizations"][number]>;
  setOrganizationEnabled: (
    id: string,
    enabled: boolean
  ) => ControlPlaneMutationResult<OpenGateConfig["organizations"][number]>;
  listUsers: () => NonNullable<OpenGateConfig["users"]>;
  getUser: (id: string) => NonNullable<OpenGateConfig["users"]>[number] | null;
  upsertUser: (
    input: NonNullable<OpenGateConfig["users"]>[number]
  ) => ControlPlaneMutationResult<NonNullable<OpenGateConfig["users"]>[number]>;
  setUserEnabled: (
    id: string,
    enabled: boolean
  ) => ControlPlaneMutationResult<NonNullable<OpenGateConfig["users"]>[number]>;
  listApiKeys: () => OpenGateConfig["apiKeys"]["clients"];
  getApiKey: (id: string) => OpenGateConfig["apiKeys"]["clients"][number] | null;
  issueApiKey: (input: IssueApiKeyInput) => IssueApiKeyResult;
  rotateApiKey: (input: RotateApiKeyInput) => RotateApiKeyResult;
  revokeApiKey: (input: RevokeApiKeyInput) => ControlPlaneMutationResult<ApiClientConfig>;
  setApiKeyEnabled: (
    clientId: string,
    enabled: boolean,
    versionId?: string
  ) => ControlPlaneMutationResult<ApiClientConfig>;
  listRoutePolicies: () => OpenGateConfig["routePolicies"];
  getRoutePolicy: (id: string) => OpenGateConfig["routePolicies"][number] | null;
  upsertRoutePolicy: (
    input: RoutePolicyConfig
  ) => ControlPlaneMutationResult<RoutePolicyConfig>;
  setRoutePolicyEnabled: (
    id: string,
    enabled: boolean
  ) => ControlPlaneMutationResult<RoutePolicyConfig>;
  simulateRequest: (request: ControlPlaneSimulationRequest) => Promise<ControlPlaneSimulationResult>;
  logEvent: (event: ControlPlaneLogEvent) => Promise<void>;
};

export function createControlPlane(source?: OpenGateConfig | string | ControlPlaneSource): ControlPlaneWorkspace {
  const normalized = normalizeSource(source);
  const configPath = normalized.configPath ? path.resolve(normalized.configPath) : null;
  const baseDir = configPath ? path.dirname(configPath) : process.cwd();
  const autoSave = normalized.autoSave ?? Boolean(configPath);
  let config: OpenGateConfig;
  if (normalized.config) {
    config = migrateConfig(normalized.config, baseDir).config;
  } else {
    const loaded = loadInitialConfig(configPath);
    if (!loaded) {
      throw new Error("A control plane needs either a config object or a config path.");
    }
    config = loaded;
  }

  async function logEvent(event: ControlPlaneLogEvent) {
    if (!normalized.logger) {
      return;
    }

    await Promise.resolve(normalized.logger.emit(event)).catch(() => undefined);
  }

  function persist() {
    if (!autoSave || !configPath) {
      return;
    }

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  }

  function commit<T>(
    action: ControlPlaneLogEvent["action"],
    resource: ControlPlaneResource,
    targetId: string,
    before: T | null,
    after: T | null,
    details?: Record<string, unknown>
  ): ControlPlaneMutationResult<T> {
    const diff = diffEntity(before, after);
    persist();
    void logEvent({
      timestamp: new Date().toISOString(),
      action,
      resource,
      targetId,
      diff,
      details
    });

    return {
      action,
      resource,
      targetId,
      before,
      after,
      diff
    };
  }

  function listOrganizations() {
    return clone(config.organizations);
  }

  function getOrganization(id: string) {
    return clone(config.organizations.find((organization) => organization.id === id) ?? null);
  }

  function upsertOrganization(input: OpenGateConfig["organizations"][number]) {
    const index = config.organizations.findIndex((organization) => organization.id === input.id);
    const before = clone(index >= 0 ? config.organizations[index] : null);
    const after = {
      id: input.id,
      name: input.name,
      enabled: input.enabled ?? true
    };

    if (index >= 0) {
      config.organizations[index] = after;
    } else {
      config.organizations.push(after);
    }

    validateState(config, baseDir);
    return commit("upsert", "organizations", input.id, before, clone(after), { summary: `Organization ${input.id}` });
  }

  function setOrganizationEnabled(id: string, enabled: boolean) {
    const organization = requireOrganization(config, id);
    const before = clone(organization);
    organization.enabled = enabled;
    validateState(config, baseDir);
    return commit(enabled ? "enable" : "disable", "organizations", id, before, clone(organization));
  }

  function listUsers() {
    return clone(config.users ?? []);
  }

  function getUser(id: string) {
    return clone((config.users ?? []).find((user) => user.id === id) ?? null);
  }

  function upsertUser(input: NonNullable<OpenGateConfig["users"]>[number]) {
    const users = (config.users ??= []);
    const index = users.findIndex((user) => user.id === input.id);
    const before = clone(index >= 0 ? users[index] : null);
    const after = {
      id: input.id,
      name: input.name,
      organizationId: input.organizationId,
      email: input.email,
      enabled: input.enabled ?? true
    };

    if (index >= 0) {
      users[index] = after;
    } else {
      users.push(after);
    }

    validateState(config, baseDir);
    return commit("upsert", "users", input.id, before, clone(after));
  }

  function setUserEnabled(id: string, enabled: boolean) {
    const user = requireUser(config, id);
    const before = clone(user);
    user.enabled = enabled;
    validateState(config, baseDir);
    return commit(enabled ? "enable" : "disable", "users", id, before, clone(user));
  }

  function listApiKeys() {
    return clone(config.apiKeys.clients);
  }

  function getApiKey(id: string) {
    return clone(config.apiKeys.clients.find((client) => client.id === id) ?? null);
  }

  function issueApiKey(input: IssueApiKeyInput): IssueApiKeyResult {
    requireOrganization(config, input.organizationId);
    if (config.users?.length) {
      requireUserByOrg(config, input.organizationId, input.userId);
    }

    if (config.apiKeys.clients.some((client) => client.id === input.clientId)) {
      throw new Error(`API key client already exists: ${input.clientId}`);
    }

    const rawKey = input.rawKey ?? randomUUID();
    const clientId = input.clientId ?? `client-${randomUUID()}`;
    const client: ApiClientConfig = {
      id: clientId,
      name: input.name,
      organizationId: input.organizationId,
      userId: input.userId,
      keyVersions: [
        {
          id: `${clientId}-primary`,
          keyHash: hashApiKey(rawKey),
          createdAt: new Date().toISOString(),
          enabled: input.enabled ?? true
        }
      ],
      scopes: input.scopes ?? [],
      enabled: input.enabled ?? true
    };

    config.apiKeys.clients.push(client);
    validateState(config, baseDir);
    const result = commit("issue", "apiKeys", client.id, null, clone(client), {
      summary: `Issued API key client ${client.id}`
    }) as IssueApiKeyResult;
    return {
      ...result,
      rawKey
    };
  }

  function rotateApiKey(input: RotateApiKeyInput): RotateApiKeyResult {
    const client = requireApiKeyClient(config, input.clientId);
    const before = clone(client);
    const rawKey = input.rawKey ?? randomUUID();
    const versionId = input.versionId ?? `${client.id}-v${(client.keyVersions?.length ?? 0) + 1}`;
    const version = {
      id: versionId,
      keyHash: hashApiKey(rawKey),
      createdAt: new Date().toISOString(),
      notBefore: input.notBefore,
      expiresAt: input.expiresAt,
      enabled: input.enabled ?? true
    };

    client.keyVersions = [...(client.keyVersions ?? []), version];
    if (input.scopes?.length) {
      client.scopes = input.scopes;
    }
    if (typeof input.enabled === "boolean") {
      client.enabled = input.enabled;
    }

    validateState(config, baseDir);
    const result = commit("rotate", "apiKeys", client.id, before, clone(client), {
      summary: `Rotated API key client ${client.id}`,
      versionId
    }) as RotateApiKeyResult;
    return {
      ...result,
      rawKey,
      versionId
    };
  }

  function revokeApiKey(input: RevokeApiKeyInput) {
    const client = requireApiKeyClient(config, input.clientId);
    const before = clone(client);
    const version = input.versionId ? client.keyVersions?.find((item) => item.id === input.versionId) : latestKeyVersion(client);
    if (!version) {
      throw new Error(`API key version not found for client ${input.clientId}.`);
    }

    version.revokedAt = new Date().toISOString();
    version.enabled = false;
    validateState(config, baseDir);
    return commit("revoke", "apiKeys", client.id, before, clone(client), { versionId: version.id });
  }

  function setApiKeyEnabled(clientId: string, enabled: boolean, versionId?: string) {
    const client = requireApiKeyClient(config, clientId);
    const before = clone(client);
    if (versionId) {
      const version = client.keyVersions?.find((item) => item.id === versionId);
      if (!version) {
        throw new Error(`API key version not found: ${versionId}`);
      }
      version.enabled = enabled;
    } else {
      client.enabled = enabled;
    }

    validateState(config, baseDir);
    return commit(enabled ? "enable" : "disable", "apiKeys", client.id, before, clone(client), { versionId });
  }

  function listRoutePolicies() {
    return clone(config.routePolicies);
  }

  function getRoutePolicy(id: string) {
    return clone(config.routePolicies.find((policy) => policy.id === id) ?? null);
  }

  function upsertRoutePolicy(input: RoutePolicyConfig) {
    const index = config.routePolicies.findIndex((policy) => policy.id === input.id);
    const before = clone(index >= 0 ? config.routePolicies[index] : null);
    const after = {
      id: input.id,
      pathPrefix: input.pathPrefix,
      accessMode: input.accessMode,
      requiredScopes: input.requiredScopes ?? [],
      enabled: input.enabled ?? true
    };

    if (index >= 0) {
      config.routePolicies[index] = after;
    } else {
      config.routePolicies.push(after);
    }

    validateState(config, baseDir);
    return commit("upsert", "routePolicies", input.id, before, clone(after));
  }

  function setRoutePolicyEnabled(id: string, enabled: boolean) {
    const policy = requireRoutePolicy(config, id);
    const before = clone(policy);
    policy.enabled = enabled;
    validateState(config, baseDir);
    return commit(enabled ? "enable" : "disable", "routePolicies", id, before, clone(policy));
  }

  async function simulateRequest(request: ControlPlaneSimulationRequest): Promise<ControlPlaneSimulationResult> {
    const simulationConfig = clone(config);
    simulationConfig.audit = {
      ...simulationConfig.audit,
      enabled: false
    };
    simulationConfig.rateLimits = {
      ...simulationConfig.rateLimits,
      store: "memory"
    };

    const engine = createGateEngine({ config: simulationConfig });
    const routePolicy = resolveRoutePolicy(simulationConfig, request.path);
    const requestEnvelope: RequestEnvelope = {
      method: request.method,
      url: request.path,
      path: request.path,
      ip: request.ip ?? "127.0.0.1",
      requestId: request.requestId ?? randomUUID(),
      headers: request.headers ?? {},
      cookies: request.cookies
    };
    const evaluation = await engine.evaluateRequest(requestEnvelope, routePolicy, process.hrtime.bigint());
    await engine.close();

    const result: ControlPlaneSimulationResult = {
      requestId: requestEnvelope.requestId,
      routePolicyId: routePolicy.id,
      allowed: evaluation.allowed,
      statusCode: evaluation.allowed ? 200 : evaluation.statusCode,
      message: evaluation.allowed ? "allowed" : evaluation.message,
      blockReason: evaluation.allowed ? null : evaluation.context.blockReason,
      identityType: evaluation.context.identity.identityType,
      identity: evaluation.context.identity
    };

    await logEvent({
      timestamp: new Date().toISOString(),
      action: "simulate",
      resource: "config",
      targetId: routePolicy.id,
      requestId: requestEnvelope.requestId,
      summary: `Simulated ${request.method} ${request.path}`,
      details: {
        allowed: result.allowed,
        statusCode: result.statusCode,
        blockReason: result.blockReason
      }
    });

    return result;
  }

  function exportConfig() {
    return JSON.stringify(config, null, 2) + "\n";
  }

  function replaceConfig(raw: unknown) {
    config = migrateConfig(raw, baseDir).config;
    persist();
    void logEvent({
      timestamp: new Date().toISOString(),
      action: "import",
      resource: "config",
      targetId: configPath ?? "memory",
      summary: "Imported control plane config"
    });
    return config;
  }

  function save() {
    persist();
  }

  return {
    get config() {
      return config;
    },
    load() {
      return config;
    },
    save,
    replaceConfig,
    exportConfig,
    listOrganizations,
    getOrganization,
    upsertOrganization,
    setOrganizationEnabled,
    listUsers,
    getUser,
    upsertUser,
    setUserEnabled,
    listApiKeys,
    getApiKey,
    issueApiKey,
    rotateApiKey,
    revokeApiKey,
    setApiKeyEnabled,
    listRoutePolicies,
    getRoutePolicy,
    upsertRoutePolicy,
    setRoutePolicyEnabled,
    simulateRequest,
    logEvent
  };
}

export function registerControlPlaneRoutes(
  app: unknown,
  gate: {
    registerProtectedRoute: (...args: any[]) => void;
  },
  controlPlane: ControlPlaneWorkspace,
  options: ControlPlaneRouteOptions = {}
) {
  const basePath = options.basePath ?? "/admin";
  const accessMode = options.accessMode ?? "authenticated";

  const protectedRoute = (pathSuffix: string, method: string, handler: (request: any, reply: any) => unknown) => {
    gate.registerProtectedRoute(app, {
      path: `${basePath}${pathSuffix}`,
      method,
      accessMode,
      handler
    });
  };

  protectedRoute("/organizations", "GET", async () => controlPlane.listOrganizations());
  protectedRoute("/organizations/:id", "GET", async (request) => controlPlane.getOrganization(request.params.id));
  protectedRoute("/organizations/:id/enable", "POST", async (request) => controlPlane.setOrganizationEnabled(request.params.id, true));
  protectedRoute("/organizations/:id/disable", "POST", async (request) => controlPlane.setOrganizationEnabled(request.params.id, false));

  protectedRoute("/users", "GET", async () => controlPlane.listUsers());
  protectedRoute("/users/:id", "GET", async (request) => controlPlane.getUser(request.params.id));
  protectedRoute("/users/:id/enable", "POST", async (request) => controlPlane.setUserEnabled(request.params.id, true));
  protectedRoute("/users/:id/disable", "POST", async (request) => controlPlane.setUserEnabled(request.params.id, false));

  protectedRoute("/api-keys", "GET", async () => controlPlane.listApiKeys());
  protectedRoute("/api-keys/:id", "GET", async (request) => controlPlane.getApiKey(request.params.id));
  protectedRoute("/api-keys/issue", "POST", async (request) => controlPlane.issueApiKey(request.body));
  protectedRoute("/api-keys/:clientId/rotate", "POST", async (request) => controlPlane.rotateApiKey({
    clientId: request.params.clientId,
    ...request.body
  }));
  protectedRoute("/api-keys/:clientId/revoke", "POST", async (request) => controlPlane.revokeApiKey({
    clientId: request.params.clientId,
    ...request.body
  }));
  protectedRoute("/api-keys/:clientId/enable", "POST", async (request) => controlPlane.setApiKeyEnabled(request.params.clientId, true, request.body?.versionId));
  protectedRoute("/api-keys/:clientId/disable", "POST", async (request) => controlPlane.setApiKeyEnabled(request.params.clientId, false, request.body?.versionId));

  protectedRoute("/route-policies", "GET", async () => controlPlane.listRoutePolicies());
  protectedRoute("/route-policies/:id", "GET", async (request) => controlPlane.getRoutePolicy(request.params.id));
  protectedRoute("/route-policies/:id/enable", "POST", async (request) => controlPlane.setRoutePolicyEnabled(request.params.id, true));
  protectedRoute("/route-policies/:id/disable", "POST", async (request) => controlPlane.setRoutePolicyEnabled(request.params.id, false));

  protectedRoute("/export", "GET", async () => JSON.parse(controlPlane.exportConfig()));
  protectedRoute("/import", "POST", async (request) => controlPlane.replaceConfig(request.body));
  protectedRoute("/simulate", "POST", async (request) => controlPlane.simulateRequest(request.body));
}

function normalizeSource(source?: OpenGateConfig | string | ControlPlaneSource): ControlPlaneSource {
  if (!source) {
    return {};
  }

  if (typeof source === "string") {
    return { configPath: source };
  }

  if ("routePolicies" in source) {
    return { config: source };
  }

  return source;
}

function loadInitialConfig(configPath: string | null) {
  if (!configPath) {
    return undefined;
  }

  return loadConfig(configPath);
}

function validateState(config: OpenGateConfig, baseDir: string) {
  validateConfig(config, baseDir);
}

function requireOrganization(config: OpenGateConfig, id: string) {
  const organization = config.organizations.find((item) => item.id === id);
  if (!organization) {
    throw new Error(`Organization not found: ${id}`);
  }

  return organization;
}

function requireUser(config: OpenGateConfig, id: string) {
  const user = config.users?.find((item) => item.id === id);
  if (!user) {
    throw new Error(`User not found: ${id}`);
  }

  return user;
}

function requireUserByOrg(config: OpenGateConfig, organizationId: string, userId: string) {
  const user = config.users?.find((item) => item.organizationId === organizationId && item.id === userId);
  if (!user) {
    throw new Error(`User not found: ${userId}`);
  }

  return user;
}

function requireApiKeyClient(config: OpenGateConfig, id: string) {
  const client = config.apiKeys.clients.find((item) => item.id === id);
  if (!client) {
    throw new Error(`API key client not found: ${id}`);
  }

  return client;
}

function requireRoutePolicy(config: OpenGateConfig, id: string) {
  const policy = config.routePolicies.find((item) => item.id === id);
  if (!policy) {
    throw new Error(`Route policy not found: ${id}`);
  }

  return policy;
}

function latestKeyVersion(client: ApiClientConfig) {
  const versions = client.keyVersions ?? [];
  return versions[versions.length - 1] ?? null;
}

function diffEntity(before: unknown, after: unknown) {
  const diff: Record<string, { before: unknown; after: unknown }> = {};
  const beforeRecord = isRecord(before) ? before : {};
  const afterRecord = isRecord(after) ? after : {};
  const keys = new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)]);

  for (const key of keys) {
    const beforeValue = beforeRecord[key];
    const afterValue = afterRecord[key];
    if (JSON.stringify(beforeValue) !== JSON.stringify(afterValue)) {
      diff[key] = { before: beforeValue ?? null, after: afterValue ?? null };
    }
  }

  return diff;
}

function clone<T>(value: T): T {
  return value === null || value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
