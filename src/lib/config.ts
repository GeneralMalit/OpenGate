import fs from "node:fs";
import path from "node:path";

export type Config = {
  server: {
    host: string;
    port: number;
  };
  upstream: {
    url: string;
  };
  auth: {
    header: string;
    keys: Array<{
      key: string;
      name: string;
      scopes: string[];
    }>;
  };
  rate_limit: {
    points: number;
    duration: number;
  };
  routes: Array<{
    path_prefix: string;
    required_scopes: string[];
  }>;
  audit: {
    enabled: boolean;
    db_path: string;
  };
  policies: {
    allowed_ips: string[];
  };
};

const DEFAULT_CONFIG_PATH = "opengate.config.json";

export function loadConfig(): Config {
  const configPath = process.env.OPENGATE_CONFIG ?? DEFAULT_CONFIG_PATH;
  const absolutePath = path.isAbsolute(configPath)
    ? configPath
    : path.join(process.cwd(), configPath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Config file not found: ${absolutePath}`);
  }

  const raw = fs.readFileSync(absolutePath, "utf-8");
  const data = JSON.parse(raw) as Config;

  return data;
}
