#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createMaestroMcpServer } from "./mcp/server.js";

void serveStdio(createMaestroMcpServer);

console.error("Maestro AI MCP server running on stdio");
