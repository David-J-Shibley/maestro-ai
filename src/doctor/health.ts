import { loadConfig } from "../config/load-config.js";
import { detectLitellmProcess } from "./litellm-process.js";
import {
  formatValidationIssue,
  validateConfiguredModels,
} from "../provider/model-catalog.js";

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

  const validations = await validateConfiguredModels(config);
  for (const v of validations) {
    const ok = v.reachable && v.modelRegistered;
    checks.push({
      name: `${v.label} model`,
      pass: ok,
      detail: ok
        ? `OK (${v.latencyMs ?? "?"}ms) ${v.endpoint.provider}/${v.endpoint.model}`
        : formatValidationIssue(v) || v.error || "unavailable",
    });
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
    const res = await fetch("http://127.0.0.1:4000/v1/models", {
      headers: { Authorization: "Bearer sk-litellm-local" },
      signal: AbortSignal.timeout(3000),
    });
    return {
      name: "litellm_port",
      pass: res.ok,
      detail: res.ok ? "Port 4000 /v1/models OK" : `HTTP ${res.status}`,
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
  const info = detectLitellmProcess();
  return {
    name: "litellm_process",
    pass: info.running,
    detail: info.detail,
  };
}
