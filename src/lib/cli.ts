import fs from "node:fs";
import path from "node:path";
import { ConfigValidationError, migrateConfig, validateConfigDetailed } from "./config.js";
import { createControlPlane } from "./control_plane.js";
import { createStarterBundle, type StarterRouteMode, type StarterTemplateName } from "./starter.js";

export type CliRunResult = {
  exitCode: number;
};

type ParsedCli = {
  command: string | null;
  args: Record<string, string | boolean>;
  positional: string[];
};

export async function runCli(argv: string[], cwd = process.cwd()): Promise<CliRunResult> {
  const parsed = parseCli(argv);

  try {
    switch (parsed.command) {
      case "init":
        runInitCommand(parsed, cwd);
        return { exitCode: 0 };
      case "validate":
        runValidateCommand(parsed, cwd);
        return { exitCode: 0 };
      case "migrate":
        runMigrateCommand(parsed, cwd);
        return { exitCode: 0 };
      case "control":
        await runControlCommand(parsed, cwd);
        return { exitCode: 0 };
      case "help":
      case null:
        printUsage();
        return { exitCode: 0 };
      default:
        console.error(`Unknown command: ${parsed.command}`);
        printUsage();
        return { exitCode: 1 };
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(error.message);
      if ("issues" in error && Array.isArray((error as { issues?: unknown }).issues)) {
        for (const issue of (error as { issues: Array<{ path: string; message: string }> }).issues) {
          console.error(`- ${issue.path}: ${issue.message}`);
        }
      }
      return { exitCode: 1 };
    }

    console.error("Unknown CLI error.");
    return { exitCode: 1 };
  }
}

function runInitCommand(parsed: ParsedCli, cwd: string) {
  const targetDir = resolveTargetDir(cwd, readOption(parsed, "dir") ?? ".");
  const template = normalizeStarterTemplate(readOption(parsed, "template"));
  const routeMode = template ? routeModeForTemplate(template) : normalizeRouteMode(readOption(parsed, "route") ?? "mixed");
  const force = readFlag(parsed, "force");
  const bundle = template ? createStarterBundle({ template, routeMode }) : createStarterBundle(routeMode);

  fs.mkdirSync(targetDir, { recursive: true });

  for (const [relativePath, content] of Object.entries(bundle.files)) {
    writeFilePath(path.join(targetDir, relativePath), content, force);
  }

  console.log(`Created OpenGate starter in ${targetDir}`);
  console.log(`Route mode: ${routeMode}`);
  console.log("Files:");
  for (const filePath of Object.keys(bundle.files)) {
    console.log(`- ${filePath}`);
  }
}

function runValidateCommand(parsed: ParsedCli, cwd: string) {
  const configPath = resolveConfigPath(cwd, readPathArg(parsed) ?? "opengate.config.json");
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
  const report = validateConfigDetailed(raw, path.dirname(configPath));

  if (!report.ok) {
    throw new ConfigValidationError(report.issues);
  }

  const warnings = report.warnings.length ? `\nWarnings:\n${report.warnings.map((warning) => `- ${warning}`).join("\n")}` : "";
  console.log(`Config valid: ${configPath}${warnings}`);
}

function runMigrateCommand(parsed: ParsedCli, cwd: string) {
  const configPath = resolveConfigPath(cwd, readPathArg(parsed) ?? "opengate.config.json");
  const outPath = parsed.args.out ? resolveOutputPath(cwd, String(parsed.args.out)) : `${configPath}.migrated.json`;
  const overwrite = readFlag(parsed, "write");
  const force = readFlag(parsed, "force");
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
  const report = migrateConfig(raw, path.dirname(configPath));
  const json = JSON.stringify(report.config, null, 2) + "\n";

  writeFilePath(outPath, json, overwrite || force);
  console.log(`Migrated config written to ${outPath}`);
  if (report.warnings.length) {
    console.log("Warnings:");
    for (const warning of report.warnings) {
      console.log(`- ${warning}`);
    }
  }
}

async function runControlCommand(parsed: ParsedCli, cwd: string) {
  const [subcommand, resource, targetId] = parsed.positional;
  if (!subcommand || subcommand === "help") {
    printControlUsage();
    return;
  }

  const configPath = resolveConfigPath(cwd, readOption(parsed, "file") ?? "opengate.config.json");
  const controlPlane = createControlPlane(configPath);

  switch (subcommand) {
    case "list":
      console.log(JSON.stringify(readListResource(controlPlane, resource), null, 2));
      return;
    case "get":
      console.log(JSON.stringify(readGetResource(controlPlane, resource, targetId), null, 2));
      return;
    case "export":
      writeControlExport(controlPlane, parsed, cwd);
      return;
    case "import":
      importControlConfig(controlPlane, parsed, cwd);
      return;
    case "issue":
      console.log(JSON.stringify(issueControlApiKey(controlPlane, parsed), null, 2));
      return;
    case "rotate":
      console.log(JSON.stringify(rotateControlApiKey(controlPlane, resource, targetId, parsed), null, 2));
      return;
    case "revoke":
      console.log(JSON.stringify(revokeControlApiKey(controlPlane, resource, targetId, parsed), null, 2));
      return;
    case "enable":
      console.log(JSON.stringify(setControlEnabled(controlPlane, resource, targetId, true, parsed), null, 2));
      return;
    case "disable":
      console.log(JSON.stringify(setControlEnabled(controlPlane, resource, targetId, false, parsed), null, 2));
      return;
    case "simulate":
      console.log(JSON.stringify(await simulateControlRequest(controlPlane, parsed), null, 2));
      return;
    default:
      throw new Error(`Unknown control command: ${subcommand}`);
  }
}

function writeFilePath(filePath: string, content: string, force: boolean) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(filePath) && !force) {
    throw new Error(`Refusing to overwrite existing file: ${filePath}. Use --force to replace it.`);
  }

  fs.writeFileSync(filePath, content, "utf8");
}

function resolveTargetDir(cwd: string, dir: string) {
  return path.isAbsolute(dir) ? dir : path.join(cwd, dir);
}

function resolveConfigPath(cwd: string, configPath: string) {
  return path.isAbsolute(configPath) ? configPath : path.join(cwd, configPath);
}

function resolveOutputPath(cwd: string, outputPath: string) {
  return path.isAbsolute(outputPath) ? outputPath : path.join(cwd, outputPath);
}

function parseCli(argv: string[]): ParsedCli {
  const positional: string[] = [];
  const args: Record<string, string | boolean> = {};
  let command: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value) {
      continue;
    }

    if (!command && !value.startsWith("-")) {
      command = value;
      continue;
    }

    if (value.startsWith("--")) {
      const [flagName, inlineValue] = value.slice(2).split("=", 2);
      if (!flagName) {
        continue;
      }

      if (inlineValue !== undefined) {
        args[flagName] = inlineValue;
        continue;
      }

      const next = argv[index + 1];
      if (next && !next.startsWith("-")) {
        args[flagName] = next;
        index += 1;
        continue;
      }

      args[flagName] = true;
      continue;
    }

    positional.push(value);
  }

  if (!command && positional.length > 0) {
    command = positional.shift() ?? null;
  }

  return {
    command,
    args,
    positional
  };
}

function readPathArg(parsed: ParsedCli) {
  return parsed.args.file ? String(parsed.args.file) : parsed.positional[0] ?? null;
}

function readOption(parsed: ParsedCli, key: string) {
  const value = parsed.args[key];
  return typeof value === "string" ? value : null;
}

function readFlag(parsed: ParsedCli, key: string) {
  return parsed.args[key] === true;
}

function normalizeRouteMode(input: string): StarterRouteMode {
  if (input === "public" || input === "jwt" || input === "api_key" || input === "mixed") {
    return input;
  }

  throw new Error(`Unsupported starter route mode: ${input}`);
}

function printUsage() {
  console.log(`OpenGate CLI

Usage:
  opengate init [--dir <path>] [--route public|jwt|api_key|mixed] [--template website|api|partner] [--force]
  opengate validate [--file <path>]
  opengate migrate [--file <path>] [--out <path>] [--write] [--force]
  opengate control <list|get|export|import|issue|rotate|revoke|enable|disable|simulate> ...

Commands:
  init      Create a starter config, starter server, demo credentials, and sample audit file.
  validate  Validate a config file and print friendly errors.
  migrate   Normalize legacy config shapes into the current Phase 2 format.
  control   Inspect and manage organizations, users, API keys, and route policies.
`);
}

function normalizeStarterTemplate(input: string | null) {
  if (!input) {
    return null;
  }

  if (input === "website" || input === "api" || input === "partner") {
    return input as StarterTemplateName;
  }

  throw new Error(`Unsupported starter template: ${input}`);
}

function routeModeForTemplate(template: StarterTemplateName): StarterRouteMode {
  switch (template) {
    case "website":
      return "public";
    case "api":
      return "jwt";
    case "partner":
      return "api_key";
    default:
      return "mixed";
  }
}

function printControlUsage() {
  console.log(`OpenGate Control Plane

Usage:
  opengate control list organizations|users|api-keys|route-policies [--file <config>]
  opengate control get organizations|users|api-keys|route-policies <id> [--file <config>]
  opengate control export [--file <config>] [--out <path>]
  opengate control import --input <path> [--file <config>]
  opengate control issue api-key --name <name> --organization <orgId> --user <userId> [--client-id <id>] [--raw-key <key>] [--scopes a,b]
  opengate control rotate api-key <clientId> [--version-id <id>] [--raw-key <key>] [--scopes a,b]
  opengate control revoke api-key <clientId> [--version-id <id>]
  opengate control enable|disable organization|user|api-key|route-policy <id> [--version-id <id>]
  opengate control simulate --method GET --path /api [--headers '{\"x-api-key\":\"...\"}'] [--cookies '{\"opengate_jwt\":\"...\"}']
`);
}

function readListResource(controlPlane: ReturnType<typeof createControlPlane>, resource: string | undefined) {
  switch (normalizeResource(resource)) {
    case "organizations":
      return controlPlane.listOrganizations();
    case "users":
      return controlPlane.listUsers();
    case "apiKeys":
      return controlPlane.listApiKeys();
    case "routePolicies":
      return controlPlane.listRoutePolicies();
    default:
      throw new Error(`Unsupported resource for list: ${resource ?? "missing"}`);
  }
}

function readGetResource(controlPlane: ReturnType<typeof createControlPlane>, resource: string | undefined, id: string | undefined) {
  if (!id) {
    throw new Error("Missing resource id.");
  }

  const result = (() => {
    switch (normalizeResource(resource)) {
      case "organizations":
        return controlPlane.getOrganization(id);
      case "users":
        return controlPlane.getUser(id);
      case "apiKeys":
        return controlPlane.getApiKey(id);
      case "routePolicies":
        return controlPlane.getRoutePolicy(id);
      default:
        throw new Error(`Unsupported resource for get: ${resource ?? "missing"}`);
    }
  })();

  if (!result) {
    throw new Error(`${resource ?? "resource"} not found: ${id}`);
  }

  return result;
}

function writeControlExport(controlPlane: ReturnType<typeof createControlPlane>, parsed: ParsedCli, cwd: string) {
  const outPath = readOption(parsed, "out");
  const json = controlPlane.exportConfig();

  if (outPath) {
    const resolved = resolveOutputPath(cwd, outPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, json, "utf8");
    console.log(`Exported config to ${resolved}`);
    return;
  }

  console.log(json.trimEnd());
}

function importControlConfig(controlPlane: ReturnType<typeof createControlPlane>, parsed: ParsedCli, cwd: string) {
  const inputPath = readOption(parsed, "input");
  if (!inputPath) {
    throw new Error("Missing --input path for control import.");
  }

  const resolved = resolveOutputPath(cwd, inputPath);
  const raw = JSON.parse(fs.readFileSync(resolved, "utf8")) as unknown;
  controlPlane.replaceConfig(raw);
  controlPlane.save();
  console.log(`Imported config from ${resolved}`);
}

function issueControlApiKey(controlPlane: ReturnType<typeof createControlPlane>, parsed: ParsedCli) {
  const name = readOption(parsed, "name");
  const organizationId = readOption(parsed, "organization") ?? readOption(parsed, "organizationId");
  const userId = readOption(parsed, "user") ?? readOption(parsed, "userId");

  if (!name || !organizationId || !userId) {
    throw new Error("Missing required fields for api-key issuance.");
  }

  return controlPlane.issueApiKey({
    clientId: readOption(parsed, "client-id") ?? readOption(parsed, "clientId") ?? undefined,
    name,
    organizationId,
    userId,
    rawKey: readOption(parsed, "raw-key") ?? readOption(parsed, "rawKey") ?? undefined,
    scopes: readCsvOption(parsed, "scopes"),
    enabled: readBooleanOption(parsed, "enabled")
  });
}

function rotateControlApiKey(
  controlPlane: ReturnType<typeof createControlPlane>,
  resource: string | undefined,
  targetId: string | undefined,
  parsed: ParsedCli
) {
  const clientId = normalizeResource(resource) === "apiKeys" ? targetId : undefined;
  const resolvedClientId = clientId ?? readOption(parsed, "client-id") ?? readOption(parsed, "clientId");

  if (!resolvedClientId) {
    throw new Error("Missing API key client id.");
  }

  return controlPlane.rotateApiKey({
    clientId: resolvedClientId,
    versionId: readOption(parsed, "version-id") ?? readOption(parsed, "versionId") ?? undefined,
    rawKey: readOption(parsed, "raw-key") ?? readOption(parsed, "rawKey") ?? undefined,
    scopes: readCsvOption(parsed, "scopes"),
    enabled: readBooleanOption(parsed, "enabled"),
    notBefore: readOption(parsed, "not-before") ?? readOption(parsed, "notBefore") ?? undefined,
    expiresAt: readOption(parsed, "expires-at") ?? readOption(parsed, "expiresAt") ?? undefined
  });
}

function revokeControlApiKey(
  controlPlane: ReturnType<typeof createControlPlane>,
  resource: string | undefined,
  targetId: string | undefined,
  parsed: ParsedCli
) {
  const clientId = normalizeResource(resource) === "apiKeys" ? targetId : undefined;
  const resolvedClientId = clientId ?? readOption(parsed, "client-id") ?? readOption(parsed, "clientId");

  if (!resolvedClientId) {
    throw new Error("Missing API key client id.");
  }

  return controlPlane.revokeApiKey({
    clientId: resolvedClientId,
    versionId: readOption(parsed, "version-id") ?? readOption(parsed, "versionId") ?? undefined
  });
}

function setControlEnabled(
  controlPlane: ReturnType<typeof createControlPlane>,
  resource: string | undefined,
  targetId: string | undefined,
  enabled: boolean,
  parsed: ParsedCli
) {
  if (!targetId) {
    throw new Error("Missing target id.");
  }

  const versionId = readOption(parsed, "version-id") ?? readOption(parsed, "versionId") ?? undefined;

  switch (normalizeResource(resource)) {
    case "organizations":
      return controlPlane.setOrganizationEnabled(targetId, enabled);
    case "users":
      return controlPlane.setUserEnabled(targetId, enabled);
    case "apiKeys":
      return controlPlane.setApiKeyEnabled(targetId, enabled, versionId);
    case "routePolicies":
      return controlPlane.setRoutePolicyEnabled(targetId, enabled);
    default:
      throw new Error(`Unsupported resource for enable/disable: ${resource ?? "missing"}`);
  }
}

async function simulateControlRequest(controlPlane: ReturnType<typeof createControlPlane>, parsed: ParsedCli) {
  const method = readOption(parsed, "method");
  const pathName = readOption(parsed, "path");
  if (!method || !pathName) {
    throw new Error("Missing --method or --path for control simulate.");
  }

  return controlPlane.simulateRequest({
    method,
    path: pathName,
    ip: readOption(parsed, "ip") ?? undefined,
    requestId: readOption(parsed, "request-id") ?? readOption(parsed, "requestId") ?? undefined,
    headers: readHeadersJsonOption(parsed, "headers"),
    cookies: readCookiesJsonOption(parsed, "cookies")
  });
}

function normalizeResource(resource: string | undefined): "organizations" | "users" | "apiKeys" | "routePolicies" {
  switch (resource) {
    case "organization":
    case "organizations":
    case "org":
    case "orgs":
      return "organizations";
    case "user":
    case "users":
      return "users";
    case "api-key":
    case "api-keys":
    case "key":
    case "keys":
      return "apiKeys";
    case "route-policy":
    case "route-policies":
    case "policy":
    case "policies":
      return "routePolicies";
    default:
      throw new Error(`Unsupported control-plane resource: ${resource ?? "missing"}`);
  }
}

function readCsvOption(parsed: ParsedCli, key: string) {
  const value = readOption(parsed, key);
  if (!value) {
    return undefined;
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readHeadersJsonOption(parsed: ParsedCli, key: string) {
  const value = readOption(parsed, key);
  if (!value) {
    return undefined;
  }

  return JSON.parse(value) as Record<string, string | string[]>;
}

function readCookiesJsonOption(parsed: ParsedCli, key: string) {
  const value = readOption(parsed, key);
  if (!value) {
    return undefined;
  }

  return JSON.parse(value) as Record<string, string>;
}

function readBooleanOption(parsed: ParsedCli, key: string) {
  const value = parsed.args[key];
  if (value === true) {
    return true;
  }

  if (typeof value === "string") {
    if (value === "true") {
      return true;
    }

    if (value === "false") {
      return false;
    }
  }

  return undefined;
}
