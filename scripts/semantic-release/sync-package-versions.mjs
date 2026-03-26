import fs from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const version = process.argv[2];

if (!version) {
  throw new Error("Expected a release version argument.");
}

const files = [
  "package.json",
  "package-lock.json",
  path.join("packages", "express", "package.json"),
  path.join("packages", "fastify", "package.json")
];

async function readJson(filePath) {
  const raw = await fs.readFile(path.join(rootDir, filePath), "utf8");
  return JSON.parse(raw);
}

async function writeJson(filePath, value) {
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(path.join(rootDir, filePath), raw);
}

const rootPackage = await readJson("package.json");
rootPackage.version = version;
await writeJson("package.json", rootPackage);

const lockFile = await readJson("package-lock.json");
lockFile.version = version;
if (lockFile.packages?.[""]) {
  lockFile.packages[""].version = version;
}
for (const workspacePath of ["packages/express", "packages/fastify"]) {
  const entry = lockFile.packages?.[workspacePath];
  if (entry) {
    entry.version = version;
    if (entry.peerDependencies?.opengate) {
      entry.peerDependencies.opengate = `^${version}`;
    }
  }
}
await writeJson("package-lock.json", lockFile);

for (const packagePath of [
  path.join("packages", "express", "package.json"),
  path.join("packages", "fastify", "package.json")
]) {
  const pkg = await readJson(packagePath);
  pkg.version = version;
  if (pkg.peerDependencies?.opengate) {
    pkg.peerDependencies.opengate = `^${version}`;
  }
  await writeJson(packagePath, pkg);
}

console.log(`Synced workspace versions to ${version}`);
