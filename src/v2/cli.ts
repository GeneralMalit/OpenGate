#!/usr/bin/env node

/**
 * The v2 command line boundary.
 *
 * The command parser intentionally has no knowledge of the database or HTTP
 * server.  The application composition layer supplies those operations via
 * `runtime`.  Keeping this boundary small makes `bootstrap-admin` safe to
 * exercise in tests and lets the server evolve without making the CLI a
 * second application.
 */

import { stdin as processStdin, stdout as processStdout, stderr as processStderr } from "node:process";

export type BootstrapAdminInput = {
  email: string;
  password: string;
};

export type ServeOptions = {
  host: string;
  port: number;
  databaseUrl: string;
  keyPepper: string;
  sessionSecret: string;
  publicBaseUrl: string | null;
  trustedProxyHops: number;
};

export type V2CliRuntime = {
  bootstrapAdmin: (input: BootstrapAdminInput) => Promise<{ id?: string; email?: string } | void> | { id?: string; email?: string } | void;
  serve: (options: ServeOptions) => Promise<void> | void;
  migrate?: (options: { databaseUrl: string }) => Promise<void> | void;
};

export type CliIo = {
  write: (message: string) => void;
  error: (message: string) => void;
  readPassword?: (prompt: string) => Promise<string>;
  readStdin?: () => Promise<string>;
};

export type ParsedV2Cli = {
  command: "bootstrap-admin" | "serve" | "migrate" | "help";
  options: Record<string, string | boolean>;
};

export type V2CliRunOptions = {
  env?: NodeJS.ProcessEnv;
  io?: Partial<CliIo>;
  runtime?: V2CliRuntime;
};

export type V2CliRunResult = {
  exitCode: number;
  error?: string;
};

const USAGE = `OpenGate v2

Usage:
  opengate bootstrap-admin --email <email>
  opengate serve [--host <host>] [--port <port>] [--database <path>]
  opengate migrate [--database <path>]

bootstrap-admin reads the password interactively (or with --password-stdin).
The password is never accepted as a command-line option.

Environment:
  OPENGATE_DATABASE_URL       SQLite database path (default: ./data/opengate.sqlite)
  OPENGATE_KEY_PEPPER         Secret used to verify consumer keys
  OPENGATE_SESSION_SECRET     Secret used to sign administrator sessions
  OPENGATE_BIND_HOST          Listen address (default: 127.0.0.1)
  OPENGATE_PORT                Listen port (default: 8080)
  OPENGATE_PUBLIC_BASE_URL     Public gateway URL (optional)
  OPENGATE_TRUSTED_PROXY_HOPS Trusted proxy hop count (default: 0)
`;

const COMMANDS = new Set<ParsedV2Cli["command"]>(["bootstrap-admin", "serve", "migrate", "help"]);

export function parseV2Cli(argv: string[]): ParsedV2Cli {
  const [rawCommand, ...rest] = argv;
  const command = rawCommand === undefined || rawCommand === "-h" || rawCommand === "--help"
    ? "help"
    : rawCommand;

  if (!COMMANDS.has(command as ParsedV2Cli["command"])) {
    throw new Error(`Unknown command: ${command}`);
  }

  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token) continue;
    if (token === "-h" || token === "--help") {
      options.help = true;
      continue;
    }
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const withoutPrefix = token.slice(2);
    const equalIndex = withoutPrefix.indexOf("=");
    const name = equalIndex === -1 ? withoutPrefix : withoutPrefix.slice(0, equalIndex);
    const inlineValue = equalIndex === -1 ? undefined : withoutPrefix.slice(equalIndex + 1);
    if (!name) throw new Error("Option name cannot be empty");

    if (name === "password") {
      throw new Error("Refusing --password because command-line arguments can be recorded; use interactive input or --password-stdin.");
    }

    const allowed = command === "bootstrap-admin"
      ? ["email", "password-stdin", "help"]
      : command === "serve"
        ? ["host", "port", "database", "key-pepper", "session-secret", "public-base-url", "trusted-proxy-hops", "help"]
        : command === "migrate"
          ? ["database", "help"]
          : ["help"];
    if (!allowed.includes(name)) throw new Error(`Unknown option for ${command}: --${name}`);
    if (Object.prototype.hasOwnProperty.call(options, name)) throw new Error(`Option --${name} was provided more than once`);

    const expectsValue = !["help", "password-stdin"].includes(name);
    if (!expectsValue) {
      if (inlineValue !== undefined) throw new Error(`Option --${name} does not take a value`);
      options[name] = true;
      continue;
    }

    if (inlineValue !== undefined) {
      if (inlineValue.length === 0) throw new Error(`Option --${name} requires a value`);
      options[name] = inlineValue;
      continue;
    }

    const value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Option --${name} requires a value`);
    options[name] = value;
    index += 1;
  }

  return { command: command as ParsedV2Cli["command"], options };
}

export function createBootstrapAdminInput(email: string, password: string): BootstrapAdminInput {
  const normalizedEmail = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw new Error("A valid administrator email is required.");
  }
  if (password.length < 12) {
    throw new Error("Administrator password must be at least 12 characters.");
  }
  return { email: normalizedEmail, password };
}

export function createServeOptions(env: NodeJS.ProcessEnv = process.env, options: Record<string, string | boolean> = {}): ServeOptions {
  const get = (option: string, variable: keyof NodeJS.ProcessEnv, fallback: string) => {
    const value = options[option] ?? env[variable] ?? fallback;
    if (typeof value !== "string" || value.trim() === "") throw new Error(`Option --${option} requires a value`);
    return value.trim();
  };
  const port = parseInteger(get("port", "OPENGATE_PORT", "8080"), "port", 1, 65535);
  const trustedProxyHops = parseInteger(get("trusted-proxy-hops", "OPENGATE_TRUSTED_PROXY_HOPS", "0"), "trusted-proxy-hops", 0, 32);
  const publicBaseUrl = options["public-base-url"] ?? env.OPENGATE_PUBLIC_BASE_URL;

  return {
    host: get("host", "OPENGATE_BIND_HOST", "127.0.0.1"),
    port,
    databaseUrl: get("database", "OPENGATE_DATABASE_URL", "./data/opengate.sqlite"),
    keyPepper: get("key-pepper", "OPENGATE_KEY_PEPPER", ""),
    sessionSecret: get("session-secret", "OPENGATE_SESSION_SECRET", ""),
    publicBaseUrl: publicBaseUrl === undefined || publicBaseUrl === true ? null : String(publicBaseUrl).trim() || null,
    trustedProxyHops
  };
}

function parseInteger(value: string, name: string, minimum: number, maximum: number): number {
  if (!/^[0-9]+$/.test(value)) throw new Error(`Option --${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Option --${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function defaultIo(): CliIo {
  return {
    write: (message) => processStdout.write(`${message}\n`),
    error: (message) => processStderr.write(`${message}\n`),
    readPassword: () => readPasswordInteractively()
  };
}

async function readPasswordInteractively(): Promise<string> {
  if (!processStdin.isTTY) throw new Error("Interactive password input is unavailable; pipe a password with --password-stdin.");
  return new Promise((resolve, reject) => {
    const input = processStdin;
    const output = processStdout;
    let value = "";
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\r" || character === "\n") {
          input.setRawMode?.(false);
          input.pause();
          input.off("data", onData);
          output.write("\n");
          resolve(value);
        } else if (character === "\u0003") {
          input.setRawMode?.(false);
          input.pause();
          input.off("data", onData);
          reject(new Error("Password input cancelled."));
        } else if (character === "\u007f") {
          value = value.slice(0, -1);
        } else {
          value += character;
        }
      }
    };
    output.write("Administrator password: ");
    input.resume();
    input.setRawMode?.(true);
    input.on("data", onData);
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of processStdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").replace(/[\r\n]+$/, "");
}

export async function runV2Cli(argv: string[], runOptions: V2CliRunOptions = {}): Promise<V2CliRunResult> {
  const io = { ...defaultIo(), ...runOptions.io };
  try {
    const parsed = parseV2Cli(argv);
    if (parsed.command === "help" || parsed.options.help === true) {
      io.write(USAGE.trimEnd());
      return { exitCode: 0 };
    }
    if (!runOptions.runtime) throw new Error("The v2 runtime is not configured. Start OpenGate through its application entrypoint.");

    if (parsed.command === "bootstrap-admin") {
      const email = parsed.options.email;
      if (typeof email !== "string") throw new Error("bootstrap-admin requires --email <email>");
      const passwordInput = parsed.options["password-stdin"] === true
        ? await (io.readStdin ?? readStdin)()
        : await (io.readPassword ?? readPasswordInteractively)("Administrator password: ");
      const password = passwordInput.replace(/[\r\n]+$/, "");
      const input = createBootstrapAdminInput(email, password);
      const result = await runOptions.runtime.bootstrapAdmin(input);
      io.write(`Bootstrap administrator created${result && result.email ? `: ${result.email}` : "."}`);
      return { exitCode: 0 };
    }

    const env = runOptions.env ?? process.env;
    if (parsed.command === "serve") {
      const options = createServeOptions(env, parsed.options);
      if (!options.keyPepper || !options.sessionSecret) {
        throw new Error("OPENGATE_KEY_PEPPER and OPENGATE_SESSION_SECRET are required before serving.");
      }
      await runOptions.runtime.serve(options);
      return { exitCode: 0 };
    }

    if (parsed.command === "migrate") {
      if (!runOptions.runtime.migrate) throw new Error("The configured runtime does not support migrations.");
      const configuredDatabase = parsed.options.database ?? env.OPENGATE_DATABASE_URL ?? "./data/opengate.sqlite";
      if (typeof configuredDatabase !== "string" || configuredDatabase.trim() === "") throw new Error("Option --database requires a value");
      const databaseUrl = configuredDatabase.trim();
      await runOptions.runtime.migrate({ databaseUrl });
      io.write(`Migrations applied to ${databaseUrl}.`);
      return { exitCode: 0 };
    }

    return { exitCode: 0 };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown CLI error.";
    io.error(message);
    return { exitCode: 1, error: message };
  }
}

export { USAGE as V2_CLI_USAGE };

// This file is also a valid executable once the application composition layer
// supplies the runtime.  Keeping the executable entrypoint side-effect free
// when imported is important for tests and for embedders.
if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}`) {
  const result = await runV2Cli(process.argv.slice(2));
  process.exitCode = result.exitCode;
}
