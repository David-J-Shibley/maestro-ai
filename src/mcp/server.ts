import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  askToolInputSchema,
  analyzeToolInputSchema,
  feedbackToolInputSchema,
  probeToolInputSchema,
  routeToolInputSchema,
  statsToolInputSchema,
  workflowToolInputSchema,
} from "./schemas.js";
import {
  handleAnalyzeTool,
  handleAskTool,
  handleDoctorTool,
  handleFeedbackTool,
  handleProbeTool,
  handleRouteTool,
  handleStatsTool,
  handleWorkflowTool,
} from "./tools.js";

import { PACKAGE_VERSION } from "../version.js";

function textResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

export function createMaestroMcpServer(): McpServer {
  const server = new McpServer(
    { name: "maestro-ai", version: PACKAGE_VERSION },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    "maestro_route",
    {
      title: "Maestro Route",
      description:
        "Analyze a task and return routing decision + explanation. Compact by default; pass debug:true for full probe/debug. Pass the literal user task in `prompt`.",
      inputSchema: routeToolInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => textResult(await handleRouteTool(input))
  );

  server.registerTool(
    "maestro_ask",
    {
      title: "Maestro Ask",
      description:
        "Route and execute an LLM call (or workflow if `workflow` is set). Compact routing report by default; pass debug:true for full details.",
      inputSchema: askToolInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => textResult(await handleAskTool(input))
  );

  server.registerTool(
    "maestro_workflow",
    {
      title: "Maestro Workflow",
      description:
        "Run multi-step workflow orchestration (auto, critique, implement-test-fix, parallel-synthesis, plan-execute-validate, extract). Pass dry_run_workflow:true to preview the plan.",
      inputSchema: workflowToolInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => textResult(await handleWorkflowTool(input))
  );

  server.registerTool(
    "maestro_probe",
    {
      title: "Maestro Probe",
      description:
        "Health-check each tier primary and fallback endpoints (cached ~30s; pass force:true to refresh).",
      inputSchema: probeToolInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => textResult(await handleProbeTool(input))
  );

  server.registerTool(
    "maestro_doctor",
    {
      title: "Maestro Doctor",
      description:
        "Diagnose Maestro AI infrastructure: Ollama, LiteLLM port/models, FEATHERLESS_API_KEY, per-tier endpoints.",
      inputSchema: z.object({
        config_path: z.string().optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => textResult(await handleDoctorTool(input))
  );

  server.registerTool(
    "maestro_stats",
    {
      title: "Maestro Stats",
      description:
        "Telemetry summary: tier distribution, success/escalation rates, latency, cost estimates. Pass insights: true for routing analysis.",
      inputSchema: statsToolInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => textResult(await handleStatsTool(input))
  );

  server.registerTool(
    "maestro_analyze",
    {
      title: "Maestro Analyze",
      description:
        "Aggregate telemetry into per-task routing insights, recommendations, and learned-routing readiness. Use before enabling learnedRoutingHints.",
      inputSchema: analyzeToolInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => textResult(await handleAnalyzeTool(input))
  );

  server.registerTool(
    "maestro_feedback",
    {
      title: "Maestro Feedback",
      description:
        "Record user feedback on a prior maestro_ask response (good/bad/note) for routing tuning.",
      inputSchema: feedbackToolInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => textResult(await handleFeedbackTool(input))
  );

  return server;
}

/** @deprecated Use createMaestroMcpServer */
export const createModelRouterMcpServer = createMaestroMcpServer;
