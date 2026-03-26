import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(rootDir, "docs-site", "src");
const outputDir = path.join(rootDir, "docs-site", "dist");
const packageJsonPath = path.join(rootDir, "package.json");

const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
const version = packageJson.version;
const versionDir = path.join(sourceDir, "versions", version);

await fs.rm(outputDir, { recursive: true, force: true });
await fs.mkdir(outputDir, { recursive: true });

await copyDirectory(sourceDir, outputDir);

if (!(await exists(versionDir))) {
  throw new Error(`Missing versioned docs directory: ${path.relative(rootDir, versionDir)}`);
}

console.log(`Built docs site for version ${version}`);

async function copyDirectory(source, destination) {
  await fs.mkdir(destination, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, destinationPath);
      continue;
    }

    await fs.copyFile(sourcePath, destinationPath);
  }
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
