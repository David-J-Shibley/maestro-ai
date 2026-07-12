# Maestro AI

Dynamic model delegation for agentic coding harnesses. Maestro routes LLM calls across local Ollama models and cloud-hosted models (via LiteLLM) based on task difficulty, risk, tools, and context size.

## Quick start (new machine)

```bash
git clone https://github.com/David-J-Shibley/maestro-ai.git maestro-ai && cd maestro-ai
npm install && npm run build

maestro init                    # creates ~/.maestro-ai/, MCP config, checks models
# merge ~/.maestro-ai/mcp-config.json into Cursor MCP settings

ollama pull llama3.2:latest     # if init reports missing models
ollama pull qwen3:8b
maestro doctor
maestro route "summarize this README" --debug
```

**Ollama only?** `maestro init --profile ollama-only` — no LiteLLM required.

**Cloud only?** `maestro init --profile cloud-only` — LiteLLM + API keys, no Ollama.

Full setup guide: [docs/SETUP.md](docs/SETUP.md)

Vision & roadmap: [docs/VISION.md](docs/VISION.md)

Technical write-up: [docs/ARTICLE.md](docs/ARTICLE.md)

## Quick start (already configured)

```bash
npx maestro route "summarize this README" --debug
npx maestro ask "Rewrite this commit message to be clearer"
```

## Model tiers

| Tier | Default model | Endpoint | Use case |
|------|---------------|----------|----------|
| `local_fast` | `llama3.2:latest` | Ollama `:11434` | Short prompts, formatting, simple classification |
| `local_strong` | `glm` (primary) / `qwen3:8b` (fallback) | LiteLLM `:4000` → Ollama | Summarization, rewriting, extraction, simple edits |
| `hosted_oss` | `qwen3-coder-next` (primary) / `qwen3:8b` (fallback) | LiteLLM `:4000` → Ollama | Medium coding, debugging, refactoring |
| `premium` | `claude-sonnet-4-6` | LiteLLM `:4000` | Hard tasks, architecture, high risk, tool-heavy |

Config profiles in `config/` — edit `~/.maestro-ai/config.json` after `maestro init`.

## Prerequisites

| Profile | Needs |
|---------|-------|
| `default` | Ollama `:11434` + LiteLLM `:4000` + `FEATHERLESS_API_KEY` (+ AWS for premium) |
| `ollama-only` | Ollama only |
| `cloud-only` | LiteLLM + API keys |

```bash
npx maestro probe
npx maestro doctor
npx maestro stats --last 50
```

## Install options

```bash
# npm (published package)
npm install -g maestro-ai
npx maestro-ai init --profile ollama-only

# From source
git clone https://github.com/David-J-Shibley/maestro-ai.git
cd maestro-ai && npm install
```

See [docs/ARTICLE.md](docs/ARTICLE.md) for npm vs git clone, MCP setup, and programmatic API usage.

## Examples

Browser-based capability demos live under [`examples/`](./examples):

- [`examples/demo.html`](./examples/demo.html) — Claude Code capabilities overview
- [`examples/claude-code-demo.html`](./examples/claude-code-demo.html) — interactive Claude Code demo
- [`examples/delegate-subtask.sh`](./examples/delegate-subtask.sh) — shell hook delegating a subtask to Maestro

## Claude Code integration (MCP — recommended)

### Cursor

Run `maestro init`, then merge `~/.maestro-ai/mcp-config.json` into Cursor MCP settings.

For git clones, see `cursor-mcp-config.json` — init generates machine-specific paths.

### Claude Code

```bash
maestro init
# Use node path from ~/.maestro-ai/mcp-config.json
claude mcp add maestro-ai -- node <path-to>/dist/mcp-server.js
```

### MCP tools

| Tool | Purpose |
|------|---------|
| `maestro_route` | Analyze task → return tier/model (no LLM call). **Always** includes `analysis`, `debug`, `probe`, `fallback_reason`. |
| `maestro_ask` | Route + execute LLM call with auto-escalation. Response includes full `routing` report. |
| `maestro_probe` | Health-check each tier primary and fallback endpoints |
| `maestro_doctor` | Infrastructure diagnostics (process, port, `/v1/models`, env vars) |
| `maestro_stats` | Telemetry summary — tier mix, escalation rate, latency, cost |
| `maestro_feedback` | Record good/bad feedback on a prior `maestro_ask` response |

### MCP response shape

Every `maestro_route` / `maestro_ask` response includes:

```json
{
  "tier": "local_strong",
  "model": "qwen3:8b",
  "analysis": { "taskType": "...", "difficulty": "...", "riskLevel": "...", "signals": [] },
  "debug": ["rule: summarization → local_strong", "tier_fallback: litellm down → ollama qwen3:8b"],
  "probe": { "unavailable_tiers": ["hosted_oss"], "results": [] },
  "fallback_reason": "primary unavailable",
  "endpoint_source": "tier_fallback"
}
```

`debug` and `probe` are always present — not gated on `debug: true`.

Every response also includes **`explanation`** — a human-readable decision card (`explanation.markdown`, `explanation.why[]`) describing why this model was chosen.

After **`maestro_ask`**, when the evaluator runs, the card also includes a **validation outcome**:

```
Selected: local_fast
Validation: failed schema check
Escalated to: local_strong
Final result: passed
Why: local output was incomplete
```

Telemetry records include an `attemptLog` with per-attempt pass/fail and failed checks.

### Routing modes (v0.7+)

Operator control plane — one flag constrains tier selection, escalation, and retries:

| Mode | Behavior |
|------|----------|
| `balanced` | Default (cost-aware heuristics + escalation) |
| `local-only` | Cap at `local_strong` — no cloud |
| `cheapest` | Prefer local tiers, nudge to lowest viable |
| `fastest` | Favor `local_fast`, no same-tier retries |
| `best-quality` | Bias toward premium / hosted OSS |
| `private` | Localhost only, privacy policy enforced |

```bash
maestro route "summarize this" --mode cheapest --debug
maestro ask "refactor auth module" --mode local-only --json
```

MCP: pass `mode` on `maestro_route` / `maestro_ask`. Telemetry and `maestro stats` report per-mode success rates.

### Routing policy

Declarative rules in `~/.maestro-ai/policy.json` (copied on `maestro init`):

- Task-type → tier overrides (e.g. architecture → premium)
- Privacy keywords → cap to local tiers
- Sensitive high-risk code → stay on localhost

See [docs/VISION.md](docs/VISION.md) for the orchestration roadmap.

Pass once per chat session via MCP or CLI:

| Field | Effect |
|-------|--------|
| `session_id` | Correlate calls for budget tracking |
| `max_tier` | Cap spend — never route above this tier |
| `budget_usd` | **Enforced** — caps tier selection and blocks escalation when exhausted |
| `always_prefer_local` | Prefer `local_fast` / `local_strong` when rules allow |

### CLAUDE.md instructions

```markdown
## Maestro AI (MCP)

Use Maestro MCP tools to offload cheap subtasks:

- **maestro_route** — check which tier a task needs before handling it yourself
- **maestro_ask** — delegate summarize/rewrite/extract/format/classify subtasks

Pass the literal task in `prompt`, not a meta routing description.
Keep complex coding, architecture, multi-file edits, and tool-heavy work in your own session.
```

## CLI

```bash
maestro init [--profile ollama-only]   # first-time setup
maestro ask "<task>" --json
maestro route "<task>" --debug
maestro doctor
maestro stats --last 50
```

## Programmatic API

```ts
import { routedLLMCall, dryRunRoute, routedLLMStream } from "maestro-ai";

const result = await routedLLMCall({
  messages: [{ role: "user", content: "Extract function names from this code." }],
  taskHints: { type: "extraction", quality: "balanced", risk: "low" },
  overrides: { session: { maxTier: "hosted_oss", alwaysPreferLocal: true } },
});
```

### Harness adapters

- `benchyRouteSubtask` / `benchyDelegate` — Benchy sub-prompt delegation
- `resolveMaestroModel` — Vercel AI `resolveModel()` replacement
- `examples/delegate-subtask.sh` — shell hook for Claude Code / Benchy

## Configuration

After `maestro init`: `~/.maestro-ai/config.json`

Bundled profiles: `config/default.config.json`, `config/ollama-only.config.json`, `config/cloud-only.config.json`

Override via `MAESTRO_CONFIG` env var.

Telemetry: `~/.maestro-ai/telemetry.jsonl`

LiteLLM starter: `config/litellm-minimal.yaml` → copied to `~/.maestro-ai/litellm.yaml` on init.

## Routing rules

**Premium** — hard, high risk, tool-heavy + code, long context, system architecture.

**Hosted OSS** — medium coding, debugging, refactoring.

**Local strong** — summarization, rewriting, extraction, non-trivial edits.

**Local fast** — simple tasks, formatting, HTML/UI demos.

**LiteLLM down?** `local_strong` and `hosted_oss` fall back to Ollama `qwen3:8b`.

## Tests

```bash
npm test
```

## Migration from `model-router`

| Old | New |
|-----|-----|
| `model-router/` | `maestro-ai/` |
| `npx model-router` | `npx maestro` |
| `model_router_route` | `maestro_route` |
| `MODEL_ROUTER_CONFIG` | `MAESTRO_CONFIG` |
| `~/.model-router/` | `~/.maestro-ai/` |
