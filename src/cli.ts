#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dryRunRoute, routedLLMCall } from "./routed-llm-call.js";
import { buildRoutingReport } from "./routing/report.js";
import { loadConfig } from "./config/load-config.js";
import { computeTelemetryStats, formatStatsReport, loadTelemetryRecords } from "./telemetry/stats.js";
import { runDoctor } from "./doctor/health.js";
import { runInit, formatInitReport } from "./init/setup.js";
import type { ChatMessage, ModelTier, RouterOverrides } from "./types.js";
import { formatProbeSummary } from "./routing/probe-summary.js";
import { isRoutingMode } from "./routing/modes.js";
import { PACKAGE_VERSION } from "./version.js";

function parseArgs(argv: string[]): {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
} {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let command = "help";

  const args = [...argv];
  if (args.length > 0 && !args[0]?.startsWith("-")) {
    command = args.shift() ?? "help";
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { command, positional, flags };
}

function buildOverrides(flags: Record<string, string | boolean>): RouterOverrides {
  const session =
    typeof flags["session-id"] === "string" ||
    typeof flags["budget-usd"] === "string" ||
    typeof flags["max-tier"] === "string" ||
    flags["always-prefer-local"] === true ||
    flags["always-prefer-local"] === "true"
      ? {
          sessionId:
            typeof flags["session-id"] === "string" ? flags["session-id"] : undefined,
          budgetUsd:
            typeof flags["budget-usd"] === "string"
              ? parseFloat(flags["budget-usd"])
              : undefined,
          maxTier:
            typeof flags["max-tier"] === "string"
              ? (flags["max-tier"] as ModelTier)
              : undefined,
          alwaysPreferLocal:
            flags["always-prefer-local"] === true ||
            flags["always-prefer-local"] === "true",
        }
      : undefined;

  return {
    modelTier: typeof flags["model-tier"] === "string" ? (flags["model-tier"] as ModelTier) : undefined,
    mode:
      typeof flags.mode === "string" && isRoutingMode(flags.mode) ? flags.mode : undefined,
    preferLocal: flags["prefer-local"] === true || flags["prefer-local"] === "true",
    premiumOnly: flags["premium-only"] === true,
    dryRunRouting: flags["dry-run-routing"] === true,
    debug: flags.debug === true,
    session,
  };
}

function readMessages(flags: Record<string, string | boolean>, positional: string[]): ChatMessage[] {
  if (typeof flags.messages === "string") {
    return JSON.parse(flags.messages) as ChatMessage[];
  }

  if (typeof flags.file === "string") {
    const raw = readFileSync(flags.file, "utf8");
    const parsed = JSON.parse(raw) as { messages?: ChatMessage[] } | ChatMessage[];
    if (Array.isArray(parsed)) return parsed;
    return parsed.messages ?? [];
  }

  const prompt = positional.join(" ") || (typeof flags.prompt === "string" ? flags.prompt : "");
  if (!prompt) throw new Error("Provide a prompt positional arg, --prompt, --file, or --messages");

  const messages: ChatMessage[] = [];
  if (typeof flags.system === "string") {
    messages.push({ role: "system", content: flags.system });
  }
  messages.push({ role: "user", content: prompt });
  return messages;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(PACKAGE_VERSION);
    return;
  }

  const { command, positional, flags } = parseArgs(argv);

  if (command === "version") {
    console.log(PACKAGE_VERSION);
    return;
  }

  const overrides = buildOverrides(flags);
  const json = flags.json === true;

  try {
    if (command === "help" || command === "--help" || flags.help === true) {
      printHelp();
      return;
    }

    if (command === "route" || command === "dry-run") {
      const messages = readMessages(flags, positional);
      const config = loadConfig(typeof flags.config === "string" ? flags.config : undefined);
      const result = await dryRunRoute(
        {
          messages,
          taskHints: parseTaskHints(flags),
          overrides: { ...overrides, dryRunRouting: command === "dry-run" || overrides.dryRunRouting },
        },
        { config }
      );

      if (json) {
        const chars = messages.map((m) => m.content).join("\n").length;
        const report = buildRoutingReport({
          routing: result.routing,
          analysis: result.analysis,
          probe: result.probe,
          contextTokens: Math.ceil(chars / 4),
          config,
        });
        console.log(JSON.stringify(report, null, 2));
      } else {
        printRouteResult(result, { debug: true, fullProbe: false });
        const chars = messages.map((m) => m.content).join("\n").length;
        const report = buildRoutingReport({
          routing: result.routing,
          analysis: result.analysis,
          probe: result.probe,
          contextTokens: Math.ceil(chars / 4),
          config,
        });
        console.log("\n" + report.explanation.markdown);
      }
      return;
    }

    if (command === "call" || command === "ask") {
      const messages = readMessages(flags, positional);
      const result = await routedLLMCall(
        {
          messages,
          responseSchema: typeof flags.schema === "string" ? JSON.parse(flags.schema) : undefined,
          taskHints: parseTaskHints(flags),
          overrides,
        },
        { configPath: typeof flags.config === "string" ? flags.config : undefined }
      );

      if (json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        if (overrides.debug) {
          printRouteResult(
            { analysis: result.analysis, routing: result.routing },
            { debug: true, fullProbe: false }
          );
        }
        console.log(result.response.content);
        if (overrides.debug) {
          console.error(`\n[tier=${result.routing.tier} model=${result.routing.model} escalated=${result.escalated}]`);
        }
      }
      return;
    }

    if (command === "probe") {
      const { probeAllTiers } = await import("./provider/probe.js");
      const config = loadConfig(typeof flags.config === "string" ? flags.config : undefined);
      const result = await probeAllTiers(config);
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (command === "doctor") {
      const report = await runDoctor(typeof flags.config === "string" ? flags.config : undefined);
      if (json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(`Maestro Doctor — ${report.healthy ? "HEALTHY" : "ISSUES FOUND"}`);
        for (const c of report.checks) {
          console.log(`  ${c.pass ? "✓" : "✗"} ${c.name}: ${c.detail}`);
        }
      }
      return;
    }

    if (command === "init") {
      const report = await runInit({
        profile: typeof flags.profile === "string" ? flags.profile : undefined,
        force: flags.force === true,
        skipDoctor: flags["skip-doctor"] === true,
      });
      if (json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatInitReport(report));
      }
      return;
    }

    if (command === "stats") {
      const config = loadConfig(typeof flags.config === "string" ? flags.config : undefined);
      const limit = typeof flags.last === "string" ? parseInt(flags.last, 10) : 50;
      const records = loadTelemetryRecords(config.telemetry.logPath, limit);
      const stats = computeTelemetryStats(records);
      if (json) {
        console.log(JSON.stringify(stats, null, 2));
      } else {
        console.log(formatStatsReport(stats, limit));
      }
      return;
    }

    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

function parseTaskHints(flags: Record<string, string | boolean>) {
  if (typeof flags["task-type"] !== "string") return undefined;
  return {
    type: flags["task-type"] as import("./types.js").TaskType,
    quality: typeof flags.quality === "string" ? (flags.quality as import("./types.js").QualityPreference) : undefined,
    risk: typeof flags.risk === "string" ? (flags.risk as import("./types.js").RiskLevel) : undefined,
  };
}

function printRouteResult(
  result: {
    analysis: import("./types.js").TaskAnalysis;
    routing: import("./types.js").RoutingDecision;
    probe?: {
      unavailable?: Set<import("./types.js").ModelTier> | import("./types.js").ModelTier[];
      tiers?: import("./provider/probe.js").TierProbeStatus[];
      results?: unknown[];
    };
  },
  options: { debug?: boolean; fullProbe?: boolean } = {}
): void {
  const { analysis, routing } = result;
  const debug = options.debug ?? false;
  console.log("Maestro AI Routing Decision");
  console.log("===========================");
  console.log(`Tier:     ${routing.tier}`);
  if (routing.requestedTier && routing.requestedTier !== routing.tier) {
    console.log(`Requested: ${routing.requestedTier}`);
  }
  console.log(`Model:    ${routing.model}`);
  console.log(`Provider: ${routing.provider}`);
  console.log(`Base URL: ${routing.baseUrl}`);
  if (routing.endpointSource) console.log(`Endpoint: ${routing.endpointSource}`);
  console.log(`Reason:   ${routing.reason}`);
  if (routing.fallbackReason) console.log(`Fallback: ${routing.fallbackReason}`);
  if (routing.fallbackTier) console.log(`Next tier: ${routing.fallbackTier}`);
  console.log("");
  console.log("Task Analysis");
  console.log(`  Type:       ${analysis.taskType}`);
  console.log(`  Difficulty: ${analysis.difficulty}`);
  console.log(`  Risk:       ${analysis.riskLevel}`);
  console.log(`  Tools:      ${analysis.requiresToolUse}`);
  console.log(`  Code:       ${analysis.requiresCodeReasoning}`);
  console.log(`  Long ctx:   ${analysis.requiresLongContext}`);
  console.log(`  Structured: ${analysis.requiresStructuredOutput}`);
  console.log(`  Confidence: ${analysis.confidence.toFixed(2)}`);

  if (routing.debug?.length) {
    console.log("\nDebug trace:");
    for (const line of routing.debug) console.log(`  - ${line}`);
  }

  if (result.probe && debug) {
    console.log("\nProbe:");
    if (options.fullProbe) {
      console.log(JSON.stringify(result.probe, null, 2));
    } else {
      console.log(`  ${formatProbeSummary(result.probe)}`);
      console.log("  (use --json for full probe data)");
    }
  }
}

function printHelp(): void {
  console.log(`Maestro AI — dynamic model routing for agent harnesses

Usage:
  maestro route <prompt>              Show routing decision without calling LLM
  maestro dry-run <prompt>            Alias for route --dry-run-routing
  maestro call <prompt>               Route and execute LLM call
  maestro ask <prompt>                Alias for call (Claude-friendly)
  maestro probe                       Check tier endpoint availability
  maestro init [--profile <name>]     First-time setup (~/.maestro-ai, MCP config)
  maestro doctor                      Diagnose Ollama, LiteLLM, API keys
  maestro stats [--last N]            Telemetry summary (default 50)
  maestro version                     Print package version

Profiles (for init):
  default       Ollama + LiteLLM (full tier stack)
  ollama-only   Local Ollama only — no LiteLLM required
  cloud-only    LiteLLM/cloud only — no Ollama required

Flags:
  --version, -v            Print package version and exit
  --model-tier <tier>      Force tier (local_fast|local_strong|hosted_oss|premium)
  --prefer-local           Prefer local tiers when possible
  --premium-only           Always use premium tier
  --dry-run-routing        Print routing only, no LLM call
  --debug                  Verbose routing explanation (compact probe summary)
  --json                   JSON output
  --config <path>          Config file path
  --system <text>          System prompt
  --prompt <text>          User prompt (alternative to positional)
  --file <path>            JSON file with { messages: [...] }
  --messages <json>        Inline messages JSON
  --task-type <type>       Task hint (code_edit, summarization, ...)
  --mode <mode>            Routing mode (balanced|local-only|cheapest|fastest|best-quality|private)
  --quality <fast|balanced|best>
  --risk <low|medium|high>
  --schema <json>          Response JSON schema object
  --session-id <id>        Session ID for budget tracking
  --budget-usd <n>         Session budget cap (enforced)
  --max-tier <tier>        Never route above this tier
  --always-prefer-local    Session policy: prefer local tiers
  --profile <name>         Config profile for init (default|ollama-only|cloud-only)
  --force                  Overwrite existing ~/.maestro-ai config on init
  --skip-doctor            Skip doctor check during init

Environment:
  MAESTRO_CONFIG               Path to config JSON
  MAESTRO_TELEMETRY_PATH       Telemetry JSONL path
  LITELLM_MASTER_KEY           API key for LiteLLM proxy
  FEATHERLESS_API_KEY          Featherless API (hosted tiers)

First-time setup:
  maestro init                    # copies config, writes MCP snippet, checks models
  maestro init --profile ollama-only

Claude Code integration:
  Ask Claude to delegate cheap tasks via:
    npx maestro ask "summarize this diff" --json
  Or check routing before a big task:
    npx maestro route "refactor auth module" --debug
`);
}

main();
