import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/load-config.js";
import {
  CONFIG_PROFILES,
  isInstalledFromNpm,
  maestroHomeDir,
  mcpServerEntryPath,
  packageRoot,
  profileSourcePath,
  resolveConfigProfile,
  userConfigPath,
  userMcpConfigPath,
  type ConfigProfile,
} from "../config/package-paths.js";
import { listEndpointsForTier } from "../config/tier-config.js";
import { runDoctor } from "../doctor/health.js";
import type { RouterConfig } from "../types.js";
import { TIER_ORDER } from "../types.js";

export interface InitOptions {
  profile?: string;
  force?: boolean;
  skipDoctor?: boolean;
}

export interface InitReport {
  profile: ConfigProfile;
  maestroHome: string;
  configPath: string;
  mcpConfigPath: string;
  mcpConfig: Record<string, unknown>;
  ollama: { reachable: boolean; models: string[]; missing: string[] };
  litellm: { reachable: boolean };
  doctor?: Awaited<ReturnType<typeof runDoctor>>;
  nextSteps: string[];
}

export function listRequiredOllamaModels(config: RouterConfig): string[] {
  const models = new Set<string>();
  for (const tier of TIER_ORDER) {
    for (const ep of listEndpointsForTier(config, tier)) {
      if (ep.provider === "ollama") models.add(ep.model);
    }
  }
  return Array.from(models).sort();
}

export async function fetchOllamaModels(): Promise<{
  reachable: boolean;
  models: string[];
}> {
  try {
    const res = await fetch("http://localhost:11434/api/tags", {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { reachable: false, models: [] };
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    return {
      reachable: true,
      models: (data.models ?? []).map((m) => m.name),
    };
  } catch {
    return { reachable: false, models: [] };
  }
}

export function buildMcpConfig(configPath: string): Record<string, unknown> {
  const env: Record<string, string> = {
    MAESTRO_CONFIG: configPath,
    LITELLM_MASTER_KEY: process.env.LITELLM_MASTER_KEY ?? "sk-litellm-local",
  };
  if (process.env.FEATHERLESS_API_KEY) {
    env.FEATHERLESS_API_KEY = process.env.FEATHERLESS_API_KEY;
  }

  if (isInstalledFromNpm()) {
    return {
      mcpServers: {
        "maestro-ai": {
          command: "npx",
          args: ["-y", "maestro-mcp"],
          env,
        },
      },
    };
  }

  const entry = mcpServerEntryPath();
  return {
    mcpServers: {
      "maestro-ai": {
        command: "node",
        args: [entry],
        cwd: packageRoot(),
        env,
      },
    },
  };
}

export async function runInit(options: InitOptions = {}): Promise<InitReport> {
  const profile = resolveConfigProfile(options.profile ?? "default");
  const home = maestroHomeDir();
  const configPath = userConfigPath();
  const mcpConfigPath = userMcpConfigPath();
  const source = profileSourcePath(profile);

  if (!existsSync(source)) {
    throw new Error(`Bundled config not found: ${source}`);
  }

  mkdirSync(home, { recursive: true });

  if (!existsSync(configPath) || options.force) {
    copyFileSync(source, configPath);
  }

  const litellmYamlSource = join(packageRoot(), "config", "litellm-minimal.yaml");
  const litellmYamlDest = join(home, "litellm.yaml");
  if (existsSync(litellmYamlSource) && (!existsSync(litellmYamlDest) || options.force)) {
    copyFileSync(litellmYamlSource, litellmYamlDest);
  }

  const policySource = join(packageRoot(), "config", "default.policy.json");
  const policyDest = join(home, "policy.json");
  if (existsSync(policySource) && (!existsSync(policyDest) || options.force)) {
    copyFileSync(policySource, policyDest);
  }

  const envExampleSource = join(packageRoot(), ".env.example");
  const envExampleDest = join(home, ".env.example");
  if (existsSync(envExampleSource) && (!existsSync(envExampleDest) || options.force)) {
    copyFileSync(envExampleSource, envExampleDest);
  }

  const config = loadConfig(configPath);
  const requiredOllama = listRequiredOllamaModels(config);
  const ollamaStatus = await fetchOllamaModels();
  const installed = new Set(ollamaStatus.models);
  const missing = requiredOllama.filter((m) => !installed.has(m));

  const mcpConfig = buildMcpConfig(configPath);
  writeFileSync(mcpConfigPath, `${JSON.stringify(mcpConfig, null, 2)}\n`, "utf8");

  let litellmReachable = false;
  try {
    const res = await fetch("http://127.0.0.1:4000/health", {
      signal: AbortSignal.timeout(3000),
    });
    litellmReachable = res.ok;
  } catch {
    litellmReachable = false;
  }

  const nextSteps = buildNextSteps({
    profile,
    missing,
    ollamaReachable: ollamaStatus.reachable,
    litellmReachable,
    mcpConfigPath,
    home,
  });

  const report: InitReport = {
    profile,
    maestroHome: home,
    configPath,
    mcpConfigPath,
    mcpConfig,
    ollama: {
      reachable: ollamaStatus.reachable,
      models: ollamaStatus.models,
      missing,
    },
    litellm: { reachable: litellmReachable },
    nextSteps,
  };

  if (!options.skipDoctor) {
    report.doctor = await runDoctor(configPath);
  }

  return report;
}

function buildNextSteps(input: {
  profile: ConfigProfile;
  missing: string[];
  ollamaReachable: boolean;
  litellmReachable: boolean;
  mcpConfigPath: string;
  home: string;
}): string[] {
  const steps: string[] = [];

  if (!input.ollamaReachable && input.profile !== "cloud-only") {
    steps.push("Install and start Ollama: https://ollama.com");
  }

  for (const model of input.missing) {
    steps.push(`Pull Ollama model: ollama pull ${model}`);
  }

  if (input.profile !== "ollama-only" && !input.litellmReachable) {
    steps.push(
      `Start LiteLLM: litellm --config ${input.home}/litellm.yaml --port 4000`
    );
    steps.push(
      `Set FEATHERLESS_API_KEY (and AWS creds for premium) — see ${input.home}/.env.example`
    );
  }

  steps.push(`Merge MCP config from ${input.mcpConfigPath} into Cursor or Claude Code`);
  steps.push("Verify: maestro doctor");
  steps.push('Try: maestro route "summarize this paragraph" --debug');

  return steps;
}

export function formatInitReport(report: InitReport): string {
  const lines = [
    "Maestro AI — setup complete",
    "═".repeat(40),
    `Profile:     ${report.profile}`,
    `Config:      ${report.configPath}`,
    `MCP config:  ${report.mcpConfigPath}`,
    "",
    "Ollama:",
    `  Reachable: ${report.ollama.reachable ? "yes" : "no"}`,
  ];

  if (report.ollama.missing.length > 0) {
    lines.push(`  Missing models:`);
    for (const m of report.ollama.missing) lines.push(`    - ${m}`);
  } else if (report.ollama.reachable) {
    lines.push("  All required models present");
  }

  lines.push("", `LiteLLM: ${report.litellm.reachable ? "reachable" : "not running"}`, "");

  if (report.doctor) {
    lines.push(`Doctor: ${report.doctor.healthy ? "HEALTHY" : "ISSUES FOUND"}`);
    for (const c of report.doctor.checks.slice(0, 8)) {
      lines.push(`  ${c.pass ? "✓" : "✗"} ${c.name}: ${c.detail}`);
    }
    if (report.doctor.checks.length > 8) {
      lines.push(`  ... and ${report.doctor.checks.length - 8} more checks`);
    }
    lines.push("");
  }

  lines.push("Next steps:");
  for (const step of report.nextSteps) lines.push(`  • ${step}`);

  lines.push("", "Cursor MCP snippet (also saved to mcp-config.json):");
  lines.push(JSON.stringify(report.mcpConfig, null, 2));

  return lines.join("\n");
}

export { CONFIG_PROFILES };
