import { execSync } from "node:child_process";
import { loadConfig } from "../config/load-config.js";
import { listEndpointsForTier } from "../config/tier-config.js";
import { probeEndpoint } from "../provider/probe.js";
import type { ModelTier } from "../types.js";
import { TIER_ORDER } from "../types.js";

export interface DoctorCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface DoctorReport {
  healthy: boolean;
  checks: DoctorCheck[];
  timestamp: string;
}

export async function runDoctor(configPath?: string): Promise<DoctorReport> {
  const config = loadConfig(configPath);
  const checks: DoctorCheck[] = [];

  checks.push(await checkOllama());
  checks.push(await checkLitellmPort());
  checks.push(await checkLitellmModels(config));
  checks.push(checkFeatherlessKey());
  checks.push(checkLitellmProcess());

  for (const tier of TIER_ORDER) {
    const endpoints = listEndpointsForTier(config, tier);
    for (let i = 0; i < endpoints.length; i++) {
      const ep = endpoints[i]!;
      const label = i === 0 ? `${tier} primary` : `${tier} fallback`;
      const result = await probeEndpoint(ep);
      checks.push({
        name: label,
        pass: result.available,
        detail: result.available
          ? `OK (${result.latencyMs}ms) ${ep.provider}/${ep.model}`
          : result.error ?? "unavailable",
      });
    }
  }

  return {
    healthy: checks.every((c) => c.pass || c.name === "litellm_process"),
    checks,
    timestamp: new Date().toISOString(),
  };
}

async function checkOllama(): Promise<DoctorCheck> {
  try {
    const res = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(3000) });
    return {
      name: "ollama",
      pass: res.ok,
      detail: res.ok ? "Ollama API responding" : `HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      name: "ollama",
      pass: false,
      detail: err instanceof Error ? err.message : "not reachable",
    };
  }
}

async function checkLitellmPort(): Promise<DoctorCheck> {
  try {
    const res = await fetch("http://127.0.0.1:4000/health", { signal: AbortSignal.timeout(3000) });
    return {
      name: "litellm_port",
      pass: res.ok,
      detail: res.ok ? "Port 4000 accepting connections" : `HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      name: "litellm_port",
      pass: false,
      detail: err instanceof Error ? err.message : "port 4000 not listening",
    };
  }
}

async function checkLitellmModels(config: ReturnType<typeof loadConfig>): Promise<DoctorCheck> {
  const ep = config.models.hosted_oss.primary;
  const key = ep.apiKey ?? "sk-litellm-local";
  try {
    const res = await fetch(`${ep.baseUrl.replace(/\/$/, "")}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    });
    return {
      name: "litellm_models",
      pass: res.ok,
      detail: res.ok ? "/v1/models OK" : `HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      name: "litellm_models",
      pass: false,
      detail: err instanceof Error ? err.message : "models endpoint failed",
    };
  }
}

function checkFeatherlessKey(): DoctorCheck {
  const key = process.env.FEATHERLESS_API_KEY;
  return {
    name: "featherless_api_key",
    pass: Boolean(key && key.length > 8),
    detail: key ? "FEATHERLESS_API_KEY is set" : "FEATHERLESS_API_KEY not set (needed for hosted tiers)",
  };
}

function checkLitellmProcess(): DoctorCheck {
  try {
    const out = execSync("pgrep -fl litellm 2>/dev/null || true", { encoding: "utf8" }).trim();
    const hasProcess = out.length > 0;
    return {
      name: "litellm_process",
      pass: hasProcess,
      detail: hasProcess ? out.split("\n")[0] ?? "running" : "no litellm process found",
    };
  } catch {
    return { name: "litellm_process", pass: false, detail: "could not check process" };
  }
}
