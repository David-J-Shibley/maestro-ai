#!/usr/bin/env node
/**
 * Demo: cache-aware sticky in one process (in-memory sticky store).
 * Usage: node examples/demo-sticky.mjs
 */
import { loadConfig } from "../dist/config/load-config.js";
import { dryRunRoute } from "../dist/routed-llm-call.js";
import { setStickyTier, clearStickyStore, getStickyTier } from "../dist/proxy/session-sticky.js";

const config = loadConfig();
const sessionId = "demo-sticky-session";
const prompt = "Refactor this medium module and add types.";

clearStickyStore();

const baseline = await dryRunRoute(
  {
    messages: [{ role: "user", content: prompt }],
    overrides: {},
  },
  { config }
);

setStickyTier(sessionId, "premium");

const sticky = await dryRunRoute(
  {
    messages: [{ role: "user", content: prompt }],
    overrides: {
      session: {
        sessionId,
        stickyTier: getStickyTier(sessionId),
      },
    },
  },
  { config }
);

console.log("Without sticky session:");
console.log(`  Tier:   ${baseline.routing.tier}`);
console.log(`  Reason: ${baseline.routing.reason}`);
console.log("");
console.log("After prior turn used premium (cache-aware sticky):");
console.log(`  Tier:   ${sticky.routing.tier}`);
console.log(`  Reason: ${sticky.routing.reason}`);
