import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  askToolInputSchema,
  feedbackToolInputSchema,
  probeToolInputSchema,
  routeToolInputSchema,
  statsToolInputSchema,
} from "./schemas.js";
import {
  handleAskTool,
  handleDoctorTool,
  handleFeedbackTool,
  handleProbeTool,
  handleRouteTool,
  handleStatsTool,
} from "./tools.js";

function textResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

export function createMaestroMcpServer(): McpServer {
  const server = new McpServer(
    { name: "maestro-ai", version: "0.3.0" },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    "maestro_route",
    {
      title: "Maestro Route",
      description:
        "Analyze a task and return full routing report (tier, analysis, debug trace, probe status, fallback reason) without calling an LLM. Pass the literal user task in `prompt`.",
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
        "Route and execute an LLM call. Response always includes full routing report. Pass literal task text in `prompt`.",
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
    "maestro_probe",
    {
      title: "Maestro Probe",
      description: "Health-check each tier primary and fallback endpoints.",
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
        "Telemetry summary: tier distribution, success/escalation rates, latency, cost estimates.",
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
