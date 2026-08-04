#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dryRunRoute, routedLLMCall } from "./routed-llm-call.js";
import { buildRoutingReport } from "./routing/report.js";
import { loadConfig } from "./config/load-config.js";
import { computeTelemetryStats, formatStatsReport, loadAllTelemetryRecords, loadTelemetryRecords } from "./telemetry/stats.js";
import { computeRoutingInsights, formatInsightsReport } from "./telemetry/analysis.js";
import { runWorkflow, dryRunWorkflow } from "./workflow/run-workflow.js";
import { buildEvaluatorHooks } from "./evaluator/shell-hooks.js";
import { recordStructuredFeedback } from "./telemetry/logger.js";
import { formatProgressLine } from "./workflow/progress.js";
import type { WorkflowProgressEvent } from "./workflow/progress.js";
import type { WorkflowRequest } from "./workflow/types.js";
import { runDoctor } from "./doctor/health.js";
import { runInit, formatInitReport } from "./init/setup.js";
import { startProxyServer } from "./proxy/server.js";
import type { ChatMessage, ModelTier, RouterOverrides } from "./types.js";
import { TIER_ORDER } from "./types.js";
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
    dryRunWorkflow: flags["dry-run-workflow"] === true,
    workflow: parseWorkflowFlag(flags.workflow),
    debug: flags.debug === true,
    session,
  };
}

function parseWorkflowFlag(value: string | boolean | undefined): WorkflowRequest | undefined {
  if (typeof value !== "string") return undefined;
  const allowed = [
    "auto",
    "single-shot",
    "plan-execute-validate",
    "parallel-synthesis",
    "critique-revise",
    "implement-test-fix",
    "extract-normalize-validate",
    "critique",
    "implement-test-fix",
    "parallel-synthesis",
    "extract",
    "single",
  ];
  return allowed.includes(value) ? (value as WorkflowRequest) : undefined;
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

    if (command === "feedback") {
      const telemetryId =
        typeof flags["telemetry-id"] === "string"
          ? flags["telemetry-id"]
          : positional[0];
      if (!telemetryId) {
        throw new Error("Usage: maestro feedback <telemetry-id> [--rating N] [--accepted] [--note text]");
      }
      const rating =
        typeof flags.rating === "string" ? parseInt(flags.rating, 10) : undefined;
      const accepted =
        flags.accepted === true || flags.accepted === "true"
          ? true
          : flags.accepted === "false"
            ? false
            : undefined;
      const note =
        typeof flags.note === "string"
          ? flags.note
          : typeof flags.feedback === "string"
            ? flags.feedback
            : positional.slice(1).join(" ") || undefined;
      const config = loadConfig(typeof flags.config === "string" ? flags.config : undefined);
      const id = recordStructuredFeedback(config, {
        telemetryId,
        feedback: note,
        rating,
        accepted,
        sessionId: typeof flags["session-id"] === "string" ? flags["session-id"] : undefined,
      });
      if (json) {
        console.log(JSON.stringify({ ok: true, feedback_id: id, telemetry_id: telemetryId, rating, accepted }, null, 2));
      } else {
        console.log(`Recorded feedback ${id} for ${telemetryId}`);
      }
      return;
    }

    if (command === "call" || command === "ask") {
      const messages = readMessages(flags, positional);
      const configPath = typeof flags.config === "string" ? flags.config : undefined;
      const evaluatorContext = buildEvaluatorHooks({
        runTests: typeof flags["run-tests"] === "string" ? flags["run-tests"] : undefined,
        runBuild: typeof flags["run-build"] === "string" ? flags["run-build"] : undefined,
      });
      const hasHooks = Boolean(evaluatorContext.runTests || evaluatorContext.runBuild);

      if (overrides.dryRunWorkflow || overrides.workflow) {
        if (overrides.dryRunWorkflow) {
          const dry = await dryRunWorkflow(
            {
              messages,
              responseSchema: typeof flags.schema === "string" ? JSON.parse(flags.schema) : undefined,
              taskHints: parseTaskHints(flags),
              overrides,
              workflow: overrides.workflow ?? "auto",
            },
            { configPath }
          );
          if (json) {
            console.log(JSON.stringify(dry, null, 2));
          } else {
            console.log(dry.report);
          }
          return;
        }

        const quietProgress = flags["quiet-progress"] === true;
        const progressJson = flags["progress-json"] === true;
        const onProgress =
          quietProgress
            ? undefined
            : (event: WorkflowProgressEvent) => {
                if (progressJson) {
                  console.error(JSON.stringify(event));
                } else {
                  console.error(formatProgressLine(event));
                }
              };

        const result = await runWorkflow(
          {
            messages,
            responseSchema: typeof flags.schema === "string" ? JSON.parse(flags.schema) : undefined,
            taskHints: parseTaskHints(flags),
            overrides,
            workflow: overrides.workflow ?? "auto",
          },
          {
            configPath,
            evaluatorContext: hasHooks ? evaluatorContext : undefined,
            onProgress,
          }
        );

        if (json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          if (overrides.debug) {
            console.log(result.report.markdown);
            console.log("\n---\n");
          }
          console.log(result.finalOutput);
        }
        return;
      }

      const result = await routedLLMCall(
        {
          messages,
          responseSchema: typeof flags.schema === "string" ? JSON.parse(flags.schema) : undefined,
          taskHints: parseTaskHints(flags),
          overrides,
        },
        {
          configPath: typeof flags.config === "string" ? flags.config : undefined,
          evaluatorContext: hasHooks ? evaluatorContext : undefined,
        }
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

    if (command === "proxy") {
      const port =
        typeof flags.port === "string" ? parseInt(flags.port, 10) : 4100;
      const host =
        typeof flags.host === "string" ? flags.host : "127.0.0.1";
      const mode =
        typeof flags.mode === "string" && isRoutingMode(flags.mode)
          ? flags.mode
          : undefined;
      const maxTierRaw =
        typeof flags["max-tier"] === "string" ? flags["max-tier"] : undefined;
      const maxTier = maxTierRaw && TIER_ORDER.includes(maxTierRaw as ModelTier)
        ? (maxTierRaw as ModelTier)
        : undefined;
      const profile =
        typeof flags.profile === "string" ? flags.profile : "claude-code";
      const { host: h, port: p } = await startProxyServer({
        port,
        host,
        configPath: typeof flags.config === "string" ? flags.config : undefined,
        mode,
        maxTier,
        alwaysPreferLocal: Boolean(flags["prefer-local"]),
        sessionId:
          typeof flags["session-id"] === "string" ? flags["session-id"] : undefined,
        profile,
        verbose: !Boolean(flags.quiet),
      });
      console.log(`Maestro proxy listening on http://${h}:${p}`);
      console.log(`OpenAI  (Cursor):  base URL http://${h}:${p}/v1`);
      console.log(`Anthropic (Claude Code): ANTHROPIC_BASE_URL=http://${h}:${p}  (no /v1)`);
      console.log(`Profile: ${profile}`);
      if (maxTier) console.log(`Max tier capped at: ${maxTier}`);
      console.log(`Status: http://${h}:${p}/status`);
      console.log("Model id can stay sonnet/maestro/etc. — Maestro routes underneath.");
      console.log("Ctrl+C to stop.");
      await new Promise(() => {});
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

    if (command === "analyze" || command === "insights") {
      const config = loadConfig(typeof flags.config === "string" ? flags.config : undefined);
      const minSamples =
        typeof flags["min-samples"] === "string"
          ? parseInt(flags["min-samples"], 10)
          : config.routing.learnedMinSamples ?? 5;
      const useAll = flags.all === true || flags.all === "true" || flags.last === undefined;
      const records = useAll
        ? loadAllTelemetryRecords(config.telemetry.logPath)
        : loadTelemetryRecords(
            config.telemetry.logPath,
            typeof flags.last === "string" ? parseInt(flags.last, 10) : 50
          );
      const insights = computeRoutingInsights(records, { minSamples });
      if (json) {
        console.log(JSON.stringify(insights, null, 2));
      } else {
        console.log(formatInsightsReport(insights));
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
  maestro analyze [--all]             Telemetry routing insights & recommendations
  maestro insights                    Alias for analyze
  maestro feedback <telemetry-id>     Record rating/accepted feedback
  maestro proxy [--port 4100] [--profile claude-code] [--max-tier hosted_oss]
  maestro version                     Print package version

Profiles (for init):
  default       Ollama + LiteLLM (full tier stack)
  ollama-only   Local Ollama only — no LiteLLM required
  cloud-only    LiteLLM/cloud only — no Ollama required

Proxy harness profiles (--profile):
  claude-code   Omit tools on chitchat; plain-reply coercion (default)
  cursor        Keep tools attached (Cursor agent loops)
  openai        Generic OpenAI-compatible clients

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
  --workflow <pattern>     Workflow orchestration (auto|critique|implement-test-fix|parallel-synthesis|...)
  --dry-run-workflow       Preview workflow plan without executing
  --progress-json          Workflow progress as NDJSON on stderr
  --quiet-progress         Suppress workflow progress lines
  --run-tests <cmd>        Shell command for tests_pass evaluator (exit 0 = pass)
  --run-build <cmd>        Shell command for build_pass evaluator (exit 0 = pass)
  --rating <1-5>           Structured feedback rating
  --accepted / --accepted false   Whether result was accepted
  --note <text>            Feedback note (with maestro feedback)
  --telemetry-id <id>      Telemetry id for feedback (or positional)
  --port <n>               Proxy listen port (default 4100)
  --host <addr>            Proxy bind address (default 127.0.0.1)
  --profile <name>         Proxy harness profile (claude-code|cursor|openai)
  --quiet                  Proxy: quieter stderr logs
  --session-id <id>        Session id for sticky routing / budget
  --quality <fast|balanced|best>
  --risk <low|medium|high>
  --schema <json>          Response JSON schema object
  --session-id <id>        Session ID for budget tracking
  --budget-usd <n>         Session budget cap (enforced)
  --max-tier <tier>        Never route above this tier
  --always-prefer-local    Session policy: prefer local tiers
  --last <n>               Limit telemetry records (stats/analyze)
  --min-samples <n>        Min samples per task/tier for analyze (default 5)
  --all                    Analyze all telemetry records (analyze default)
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
