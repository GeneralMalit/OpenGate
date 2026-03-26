import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs: string[] = [];
const npmCli = process.env.npm_execpath ?? "";

if (!npmCli) {
  throw new Error("Missing npm_execpath.");
}

afterAll(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("package distribution", () => {
  it("packs and installs the root and adapter packages", () => {
    const packDir = makeTempDir();
    const installDir = makeTempDir();

    const rootTarball = packPackage(rootDir, packDir);
    const fastifyTarball = packPackage(path.join(rootDir, "packages", "fastify"), packDir);
    const expressTarball = packPackage(path.join(rootDir, "packages", "express"), packDir);

    fs.writeFileSync(
      path.join(installDir, "package.json"),
      JSON.stringify(
        {
          name: "opengate-smoke",
          private: true,
          type: "module"
        },
        null,
        2
      )
    );

    execFileSync(process.execPath, [npmCli, "install", rootTarball, fastifyTarball, expressTarball], {
      cwd: installDir,
      stdio: "pipe"
    });

    const result = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        [
          'import assert from "node:assert/strict";',
          'import { createStarterBundle } from "opengate";',
          'import { createFastifyOpenGate } from "@opengate/fastify";',
          'import { createExpressOpenGate } from "@opengate/express";',
          'assert.equal(typeof createStarterBundle, "function");',
          'assert.equal(typeof createFastifyOpenGate, "function");',
          'assert.equal(typeof createExpressOpenGate, "function");',
          'const bundle = createStarterBundle({ template: "website" });',
          'assert.equal(bundle.template, "website");',
          'console.log("smoke-ok");'
        ].join(" ")
      ],
      {
        cwd: installDir,
        encoding: "utf8"
      }
    );

    expect(result).toContain("smoke-ok");
    expect(fs.existsSync(path.join(packDir, path.basename(rootTarball)))).toBe(true);
    expect(fs.existsSync(path.join(packDir, path.basename(fastifyTarball)))).toBe(true);
    expect(fs.existsSync(path.join(packDir, path.basename(expressTarball)))).toBe(true);
  });

  it("builds the versioned docs site", () => {
    execFileSync(process.execPath, [npmCli, "run", "docs:build"], {
      cwd: rootDir,
      stdio: "pipe"
    });

    expect(fs.existsSync(path.join(rootDir, "docs-site", "dist", "index.html"))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, "docs-site", "dist", "versions", "0.1.0", "install.html"))).toBe(true);
    expect(fs.readFileSync(path.join(rootDir, "docs-site", "dist", "index.html"), "utf8")).toContain("OpenGate Docs");
  });
});

function packPackage(packageDir: string, packDir: string) {
  const stdout = execFileSync(process.execPath, [npmCli, "pack", "--json", "--pack-destination", packDir], {
    cwd: packageDir,
    encoding: "utf8"
  });
  const result = JSON.parse(stdout) as Array<{ filename: string }>;
  const filename = result[0]?.filename;

  if (!filename) {
    throw new Error(`Failed to pack package in ${packageDir}`);
  }

  return path.join(packDir, filename);
}

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opengate-phase7-"));
  tempDirs.push(dir);
  return dir;
}
