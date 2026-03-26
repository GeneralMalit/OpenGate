import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";

function resolveSourceTsImports() {
  return {
    name: "resolve-source-ts-imports",
    enforce: "pre" as const,
    resolveId(source: string, importer?: string) {
      if (!importer || !source.endsWith(".js")) {
        return null;
      }

      if (source.startsWith("node:") || source.includes("node_modules")) {
        return null;
      }

      const candidate = path.resolve(path.dirname(importer), source.replace(/\.js$/, ".ts"));
      if (fs.existsSync(candidate)) {
        return candidate;
      }

      return null;
    }
  };
}

export default defineConfig({
  plugins: [resolveSourceTsImports()],
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/cli.ts",
        "src/lib/types.ts",
        "src/**/*.d.ts",
        "src/types.d.ts"
      ],
      thresholds: {
        lines: 75
      }
    }
  }
});
