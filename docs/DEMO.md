# Maestro AI — demo guide

Reproducible demos for “why Maestro?” — for yourself, a screen recording, or a skeptical LiteLLM user.

**Time:** ~10 minutes (CLI only) or ~20 minutes (CLI + Claude Code proxy).

---

## Prerequisites

```bash
cd maestro-ai
npm install && npm run build
maestro init          # or: maestro init --profile ollama-only
```

| Track | Needs running |
|-------|----------------|
| **A — Routing only** | Nothing (dry-run) |
| **B — Live answers** | Ollama (+ LiteLLM for hosted tiers) |
| **C — Claude Code proxy** | Ollama + LiteLLM; optional Bedrock for premium |

```bash
maestro doctor        # see what’s up
```

---

## Track A — Routing demo (no LLM calls)

Shows the **decision layer**: same “agent,” different tier per prompt. No API keys required.

```bash
chmod +x examples/run-routing-demo.sh
./examples/run-routing-demo.sh
```

**What to point at while it runs:**

| Step | Prompt | Expected tier | Point |
|------|--------|---------------|-------|
| 1 | `hi are you working` | `local_fast` or `local_strong` | Fail-soft — not Bedrock on “testing”/chitchat |
| 2 | simple HTML page | `local_fast` | Easy UI stays local |
| 3 | medium refactor | `hosted_oss` | Coding work bumps up |
| 4 | event sourcing architecture | `premium` | Hard + architecture → cloud premium |
| 5 | rewrite + `--workload orchestrator` | `hosted_oss`+ | Explicit role floor |
| 6 | format + `--workload formatter` | local | Explicit role cap |
| 7 | sticky session | `premium` | Cache-aware — won’t soft-downgrade from prior premium turn |

**Single commands** (for live typing):

```bash
maestro route "hi" --debug
maestro route "Design system architecture for event sourcing." --debug
maestro route "Refactor this module." --workload orchestrator --debug
```

Talking line:

> LiteLLM aliases pick one model per name. Maestro picks a tier **per message** — and you can still use workload roles when you *want* names like orchestrator.

---

## Track B — Live `maestro ask` (optional)

Proves routing + execution + escalation path (needs backends).

```bash
maestro ask "Summarize: Maestro routes by task difficulty." --json | jq '.routing.tier, .routing.reason'
maestro ask "Debug why this API returns 500." --json | jq '.routing.tier, .routing.model'
```

With verification hooks (implement-test-fix story):

```bash
maestro ask "Fix the failing test in src/foo.ts" \
  --workflow implement-test-fix \
  --run-tests "npm test -- src/foo.test.ts"
```

---

## Track C — Claude Code proxy (best for video)

This is the “I don’t want to dumbly re-point Claude at Ollama” demo.

### 1. Start backends

Terminal 1 — Ollama (if not already running):

```bash
ollama serve
```

Terminal 2 — LiteLLM (default profile):

```bash
litellm --config ~/.maestro-ai/litellm.yaml --port 4000
```

Terminal 3 — Maestro proxy:

```bash
maestro proxy --port 4100 --profile claude-code --prefer-local
# Optional cap if Bedrock/AWS not set up:
# maestro proxy --port 4100 --max-tier hosted_oss --prefer-local
```

Terminal 4 — watch routes (macOS has no `watch`; use a loop):

```bash
while true; do
  clear
  date
  curl -s http://127.0.0.1:4100/status | jq '.recentRoutes[-5:]'
  sleep 1
done
```

Or with Homebrew: `brew install watch` then:

```bash
watch -n1 'curl -s http://127.0.0.1:4100/status | jq "{version, profile, maxTier, recentRoutes}"'
```

### 2. Point Claude Code at Maestro

In Claude Code settings (or env):

```json
{
  "env": {
    "CLAUDE_CODE_USE_BEDROCK": "false",
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:4100",
    "ANTHROPIC_AUTH_TOKEN": "maestro",
    "ANTHROPIC_MODEL": "maestro"
  }
}
```

`ANTHROPIC_BASE_URL` must **not** end in `/v1`.

Restart Claude Code after changing settings.

### 3. Scripted conversation (record this)

Do these **in order** in one Claude Code session. Glance at Terminal 4 (`/status`) between turns.

| # | You type | What should happen | Say this |
|---|----------|-------------------|----------|
| 1 | `hi` | `local_fast` / `local_strong`, tools omitted | “Chitchat doesn’t hit Bedrock or pay premium.” |
| 2 | `make a simple html hello world page` | stays local | “Easy work stays on Ollama/GLM.” |
| 3 | `look in this repo for how routing works and summarize` | `hosted_oss`+, tools on | “Real agent work gets tools + stronger tier.” |
| 4 | `design event-sourcing architecture with failure modes` | `premium` (if Bedrock up) or `hosted_oss` (if capped) | “Hard architecture escalates — with evidence.” |
| 5 | `ok thanks` | sticky / local (cache-aware) | “Follow-up doesn’t thrash tiers for no reason.” |

### 4. What LiteLLM-only wouldn’t do

In the same session, a static alias always hits the same model. You’d need **your agent** to:

- detect chitchat vs refactor vs architecture,
- swap model names per message,
- handle Claude’s tool catalog + mid-loop behavior,
- escalate on failure.

Maestro does that at the proxy/decision layer.

Full comparison: [COMPARISON.md](./COMPARISON.md)

---

## Track D — MCP demo (Cursor / Claude Code tools)

If MCP is wired (`maestro init` → merge `mcp-config.json`):

Ask the harness:

1. *“Use maestro_route on: hi”* → show tier + explanation
2. *“Use maestro_route on: design microservices architecture”* → premium
3. *“Use maestro_stats with insights true”* → telemetry story

No proxy required — good for “decision card” screenshots.

---

## Recording tips

1. **Layout:** proxy logs (Terminal 3) + `/status` (Terminal 4) on screen; Claude Code beside them.
2. **Length:** 3–5 minutes is enough — Track A script + 3 Claude Code turns.
3. **Hook (first 15s):** “Same Claude Code session — local for hi, cloud for architecture, no routing code in the agent.”
4. **Punchline:** show `recentRoutes` in `/status` changing tiers per message.

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Everything routes premium | `--prefer-local`; check `maestro route "hi" --debug` |
| Bedrock / AWS errors | `maestro proxy --max-tier hosted_oss` |
| `hi` shows fake tool JSON | v1.2.1+ plain-reply; restart proxy |
| Sticky not visible in CLI dry-run | Use `node examples/demo-sticky.mjs` (same process); proxy sticky needs `maestro proxy` + real traffic |
| `hi` hangs / no response | Rebuild proxy (`npm run build`); v1.9.1+ skips upstream for chitchat plain turns and opens SSE immediately. Check `maestro doctor` if non-chitchat hangs (LiteLLM/Ollama down). |
| Empty `/status` recentRoutes | Restart proxy on latest build; routes log after each completed request. |

More: [SETUP.md](./SETUP.md#troubleshooting)

---

## Quick share links

- Repo: https://github.com/David-J-Shibley/maestro-ai
- npm: `npx maestro-ai@latest` / `maestro init`
- Comparison doc: [COMPARISON.md](./COMPARISON.md)
