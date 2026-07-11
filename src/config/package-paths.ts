import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Root of the maestro-ai package (works from dist/ or node_modules/). */
export function packageRoot(): string {
  return join(__dirname, "..", "..");
}

export function maestroHomeDir(): string {
  return join(homedir(), ".maestro-ai");
}

export function userConfigPath(): string {
  return join(maestroHomeDir(), "config.json");
}

export function userMcpConfigPath(): string {
  return join(maestroHomeDir(), "mcp-config.json");
}

export function bundledConfigPath(profile: string): string {
  return join(packageRoot(), "config", `${profile}.config.json`);
}

export const CONFIG_PROFILES = ["default", "ollama-only", "cloud-only"] as const;
export type ConfigProfile = (typeof CONFIG_PROFILES)[number];

export function resolveConfigProfile(name: string): ConfigProfile {
  const normalized = name === "default" ? "default" : name;
  if (!CONFIG_PROFILES.includes(normalized as ConfigProfile)) {
    throw new Error(
      `Unknown profile "${name}". Choose: ${CONFIG_PROFILES.join(", ")}`
    );
  }
  return normalized as ConfigProfile;
}

export function profileSourcePath(profile: ConfigProfile): string {
  if (profile === "default") {
    return join(packageRoot(), "config", "default.config.json");
  }
  return bundledConfigPath(profile);
}

export function isInstalledFromNpm(): boolean {
  const root = packageRoot();
  return root.includes(`${join("node_modules", "maestro-ai")}`);
}

export function mcpServerEntryPath(): string {
  const entry = join(packageRoot(), "dist", "mcp-server.js");
  if (!existsSync(entry)) {
    throw new Error(
      "MCP server not built. Run: npm install && npm run build (in maestro-ai directory)"
    );
  }
  return entry;
}
