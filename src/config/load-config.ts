import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelTier, RouterConfig } from "../types.js";
import { normalizeModels, type RawTierEntry } from "./tier-config.js";
import { userConfigPath } from "./package-paths.js";
import { loadPolicy } from "./policy.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const REQUIRED_TIERS: ModelTier[] = [
  "local_fast",
  "local_strong",
  "hosted_oss",
  "premium",
];

export function expandPath(path: string): string {
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

/** Interpolate ${VAR} and ${VAR:-default} in config strings. */
export function interpolateEnv(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, expr: string) => {
    const defaultMatch = expr.match(/^([^:]+):-(.+)$/);
    if (defaultMatch) {
      const [, name, defaultValue] = defaultMatch;
      return process.env[name ?? ""] ?? defaultValue ?? "";
    }
    return process.env[expr] ?? "";
  });
}

function deepInterpolate(value: unknown): unknown {
  if (typeof value === "string") {
    return interpolateEnv(value);
  }
  if (Array.isArray(value)) {
    return value.map(deepInterpolate);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, deepInterpolate(v)])
    );
  }
  return value;
}

export function parseRouterConfig(raw: unknown): RouterConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error("Config must be a JSON object");
  }

  const interpolated = deepInterpolate(raw) as Record<string, unknown>;
  const rawModels = interpolated.models as Record<string, RawTierEntry>;

  if (!rawModels) {
    throw new Error("models section is required");
  }

  for (const tier of REQUIRED_TIERS) {
    if (!rawModels[tier]) {
      throw new Error(`Missing model config for tier: ${tier}`);
    }
  }

  const config: RouterConfig = {
    models: normalizeModels(rawModels),
    routing: interpolated.routing as RouterConfig["routing"],
    telemetry: interpolated.telemetry as RouterConfig["telemetry"],
    premiumPool: interpolated.premiumPool as RouterConfig["premiumPool"],
  };

  if (!config.routing?.defaultTier) {
    throw new Error("routing.defaultTier is required");
  }

  config.telemetry ??= { enabled: true, logPath: "~/.maestro-ai/telemetry.jsonl" };
  config.telemetry.logPath = expandPath(config.telemetry.logPath);

  return config;
}

export function attachPolicy(config: RouterConfig, policyPath?: string): RouterConfig {
  config.policy = loadPolicy(policyPath);
  return config;
}

export function defaultConfigPath(): string {
  const packageRoot = join(__dirname, "..", "..");
  return join(packageRoot, "config", "default.config.json");
}

export function loadConfig(configPath?: string): RouterConfig {
  const resolved =
    configPath ??
    process.env.MAESTRO_CONFIG ??
    process.env.MODEL_ROUTER_CONFIG ??
    (existsSync(userConfigPath()) ? userConfigPath() : defaultConfigPath());

  const path = resolve(resolved);
  if (!existsSync(path)) {
    throw new Error(`Config file not found: ${path}`);
  }

  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return attachPolicy(parseRouterConfig(raw));
}

export function loadConfigFromString(json: string): RouterConfig {
  return attachPolicy(parseRouterConfig(JSON.parse(json) as unknown));
}
