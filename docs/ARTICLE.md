# Building Maestro AI: Routing LLM Calls So Your Agent Doesn't Burn Sonnet on Summaries

*How we built a harness-agnostic model router for Cursor and Claude Code — and what broke along the way.*

When you use Claude Sonnet for everything in Cursor, you pay premium prices for work a local Llama could handle in two seconds. When you use only Ollama, you get worse results on architecture reviews and multi-step refactors.

We wanted a middle layer: **cheap by default, escalate when the task actually needs it.** Not a new chatbot — a dispatcher the existing agent could call for subtasks.

That layer became **[Maestro AI](https://github.com/David-J-Shibley/maestro-ai)**.

## The mental model

Think of your coding agent as a conductor. It should keep architecture, multi-file edits, and complex reasoning. Maestro is the section leader who picks which musician plays each part:

- A quick HTML demo → local Llama
- A paragraph summary → local strong (or hosted GLM)
- A medium refactor → hosted Qwen Coder
- System design with trade-offs → Claude Sonnet

The conductor doesn't stop conducting. It delegates the small solos.

## Why not just use Cursor's model picker?

Cursor picks one model per chat. Agent sessions spawn dozens of implicit subtasks — summarize this file, rewrite this message, extract these fields, format this JSON. The harness doesn't automatically route those to cheaper models.

Maestro adds **per-call routing** with:

1. Task analysis before any LLM call
2. Automatic escalation if the answer fails quality checks
3. Fallback when infrastructure is down (LiteLLM zombie, Ollama only, etc.)
4. Session budgets so a long chat can't silently rack up premium spend

## Architecture in five pieces

### 1. Task analyzer (heuristics, not ML — yet)

We classify prompts with deterministic rules: keywords, patterns, tool presence, context size. Examples:

- `"summarize this README"` → `summarization`, easy, low risk → `local_strong`
- `"Design system architecture for event sourcing"` → `architecture`, hard → `premium`
- `"make me an HTML demo page"` → `code_edit`, easy → `local_fast`

Early versions had painful false positives. The word **"design"** in "design a simple HTML landing page" triggered architecture routing and sent demo pages to Sonnet. We fixed that with bounded patterns: `isSimpleUiTask()`, `isDemoShowcaseTask()`, and stricter `SYSTEM_ARCHITECTURE_SIGNALS` vs casual "design" usage.

Another gotcha: agents sent **meta-prompts** to the router — *"Determine routing for building a demonstration of model-router capabilities"* — instead of the literal task. That hit architecture keywords again. MCP tool descriptions now explicitly say: pass the literal task, not a routing meta-description.

### 2. Model router (rules + caps)

Routing is a decision tree:

```
hard / high-risk / tool+code / long context / architecture → premium
medium coding / debugging / refactoring → hosted_oss
summarization / rewriting / extraction → local_strong
easy / formatting / simple UI → local_fast
```

Then overlays:

- **Session `max_tier`** — never exceed hosted_oss in this chat
- **Session `budget_usd`** — sum telemetry spend; cap tier as budget depletes
- **`always_prefer_local`** — bias easy tasks to Ollama when safe
- **Availability** — if the chosen tier is down, fall back within tier or escalate

### 3. Tier fallbacks (infra-aware, not just tier-aware)

Our stack:

- **Ollama** on `:11434` — llama3.2, qwen3:8b
- **LiteLLM** on `:4000` — proxies to Featherless (GLM, Qwen Coder) and Bedrock (Sonnet)

Config shape:

```json
"local_strong": {
  "primary": { "provider": "litellm", "model": "glm", "baseUrl": "http://localhost:4000/v1" },
  "fallback": { "provider": "ollama", "model": "qwen3:8b", "baseUrl": "http://localhost:11434/v1" }
}
```

When LiteLLM dies, `local_strong` stays on-tier via Ollama — it doesn't jump to premium or drop to tiny Llama for a summarization task.

We learned this the hard way: a **zombie LiteLLM process** existed but wasn't listening on `:4000`. Routing failed mysteriously until we built `maestro doctor` — process check, port check, `/v1/models`, `FEATHERLESS_API_KEY`, per-tier endpoint probes.

### 4. Evaluator + escalation loop

`routedLLMCall()` doesn't fire-and-forget. After each call:

- **Non-empty** — meaningful visible text (not whitespace or invisible Unicode)
- **No refusal** — "I cannot help..." patterns
- **Valid JSON** — if schema requested
- **Tool-call schema** — if tools were provided
- **Content integrity** — `completion_tokens > 0` but no visible text? Fail and escalate.

If checks fail → retry same tier (once) → escalate to next tier → log telemetry.

We hit a real bug here: GLM returned an **empty string after 130 seconds**, but `non_empty` passed. Root cause cluster:

1. `trim().length > 0` let through `\u0000` and zero-width characters
2. Content lived in `reasoning_content` or array parts we didn't parse
3. `ProviderError("empty")` didn't trigger escalation

Fix: shared `content-extract.ts`, `hasMeaningfulContent()`, explicit empty escalation, `content_integrity` check for token-without-text.

### 5. MCP-first integration

Agents don't shell out reliably. Maestro exposes MCP tools:

| Tool | Purpose |
|------|---------|
| `maestro_route` | Dry-run routing — no LLM call |
| `maestro_ask` | Route + execute + auto-escalate |
| `maestro_doctor` | Infrastructure diagnostics |
| `maestro_stats` | Telemetry dashboard |
| `maestro_feedback` | Thumbs up/down for tuning |

Every route/ask response includes a **full routing report**: analysis, debug trace, probe status, fallback reason. We learned that hiding debug behind `debug: true` cost two debugging rounds — visibility is now always on.

## Session policy: cheap chats on purpose

Pass once per session:

```json
{
  "session_id": "cursor-main",
  "budget_usd": 0.50,
  "max_tier": "hosted_oss",
  "always_prefer_local": true
}
```

Budget is **enforced** — telemetry sums spend per `session_id`, caps tier selection, blocks escalation when exhausted.

## Install from npm

Maestro is published on npm as [`maestro-ai`](https://www.npmjs.com/package/maestro-ai). You don't need to clone the repo — the package ships the compiled CLI, MCP server, and bundled config profiles.

### Global install (recommended for daily use)

```bash
npm install -g maestro-ai

maestro init --profile ollama-only   # or default / cloud-only
ollama pull llama3.2:latest
ollama pull qwen3:8b
maestro doctor
maestro route "summarize this paragraph" --debug
```

Two binaries are exposed:

| Command | What it runs |
|---------|----------------|
| `maestro` | CLI — `init`, `route`, `ask`, `doctor`, `stats`, … |
| `maestro-mcp` | MCP server for Cursor / Claude Code |

`npm install` runs `prepare`, which builds `dist/` from TypeScript — consumers get a ready-to-run package, not raw source.

### One-shot (no global install)

```bash
npx maestro-ai init --profile ollama-only
npx maestro route "rewrite this commit message" --debug
npx maestro-mcp   # run MCP server once (stdio)
```

`npx` downloads the package on first use and caches it. Good for trying Maestro or CI scripts that need a single routed call.

### Cursor MCP (npm path)

After `maestro init`, check `~/.maestro-ai/mcp-config.json`. For npm installs it typically looks like:

```json
{
  "mcpServers": {
    "maestro-ai": {
      "command": "npx",
      "args": ["-y", "maestro-mcp"],
      "env": {
        "MAESTRO_CONFIG": "/Users/you/.maestro-ai/config.json",
        "LITELLM_MASTER_KEY": "sk-litellm-local"
      }
    }
  }
}
```

No hardcoded clone paths — `npx maestro-mcp` resolves the binary from the published package. Merge that block into Cursor → Settings → MCP and reload.

### Programmatic use in your own Node project

```bash
npm install maestro-ai
```

```ts
import { routedLLMCall, dryRunRoute } from "maestro-ai";

const preview = await dryRunRoute({
  messages: [{ role: "user", content: "Extract dates from this email." }],
});

console.log(preview.routing.tier, preview.routing.model);

const result = await routedLLMCall({
  messages: [{ role: "user", content: "Extract dates from this email." }],
  overrides: {
    session: { sessionId: "my-app", maxTier: "hosted_oss", budgetUsd: 0.25 },
  },
});

console.log(result.response.content);
console.log(result.telemetryId);
```

Config and telemetry still live under `~/.maestro-ai/` (created by `maestro init`). Override with `MAESTRO_CONFIG` if you want a project-local config file.

### npm vs git clone

| | **npm** | **git clone** |
|---|---------|----------------|
| Best for | Using Maestro, MCP, CLI | Contributing, patching routing rules |
| Install | `npm install -g maestro-ai` | `git clone` + `npm install` |
| MCP | `npx maestro-mcp` | `node dist/mcp-server.js` in clone |
| Updates | `npm update -g maestro-ai` | `git pull` + `npm run build` |

We dogfood the npm package locally too: `npm pack` produces a tarball you can install with `npm install -g ./maestro-ai-0.4.1.tgz` to verify the published artifact before release.

## Making it usable on other machines

Personal hardcoded paths don't scale — whether you install from npm or clone the repo, start with `maestro init`:

1. Creates `~/.maestro-ai/`
2. Copies a config profile (`default`, `ollama-only`, `cloud-only`)
3. Writes portable MCP config (`npx maestro-mcp` when npm-installed)
4. Lists missing `ollama pull` models
5. Copies LiteLLM starter yaml + `.env.example`

Colleagues can run `maestro init --profile ollama-only` with **no LiteLLM, no cloud keys** — just Ollama.

## What we deliberately didn't build (yet)

- **Learned routing** — need ~500+ labeled telemetry rows first
- **A/B tier experiments** — stubs exist, no data yet
- **Premium pool rotation** — Sonnet vs Opus vs GPT by availability
- **ML classifier** — heuristics + escalation are enough for v1

Rules stay the floor; ML can sit on top later.

## Tech choices

| Choice | Why |
|--------|-----|
| TypeScript standalone package | Fits Cursor MCP, CLI, npm, any Node harness |
| Raw `fetch` to `/v1/chat/completions` | Ollama and LiteLLM are OpenAI-compatible |
| JSONL telemetry | Simple, grep-friendly, no DB |
| Vitest | Fast, 77 tests covering routing edge cases |
| MCP over custom HTTP | Agents already speak MCP natively |

No LangChain. The router is ~27 source files; you can read the whole thing in an afternoon.

## Results in practice

What works well:

- Offloading summarize/rewrite/extract from the main agent session
- Staying on Ollama when LiteLLM is down
- `maestro doctor` catching zombie processes before routing fails
- Budget caps preventing runaway premium spend in long sessions

What's still manual:

- Tuning routing rules from telemetry (data accumulating)
- LiteLLM lifecycle (start, env vars, Featherless + Bedrock keys)
- Teaching the agent to pass literal tasks, not meta routing prompts

## Try it

**From npm (fastest):**

```bash
npm install -g maestro-ai
maestro init --profile ollama-only
ollama pull llama3.2:latest && ollama pull qwen3:8b
maestro doctor
maestro route "summarize this paragraph" --debug
```

**From source (contributors):**

```bash
git clone https://github.com/David-J-Shibley/maestro-ai.git
cd maestro-ai && npm install
maestro init --profile ollama-only
maestro doctor
```

Merge `~/.maestro-ai/mcp-config.json` into Cursor MCP settings. In chat, the agent can call `maestro_ask` for cheap subtasks while keeping hard work in its own session.

### Transparent proxy (v1.1+)

For whole-session routing without MCP tool calls, run:

```bash
maestro proxy --port 4100 --prefer-local
```

Point Claude Code at `ANTHROPIC_BASE_URL=http://127.0.0.1:4100` (**without** `/v1` — Claude appends `/v1/messages`). Cursor / OpenAI clients use `http://127.0.0.1:4100/v1`. Cap `--max-tier` if you don’t want tool-heavy prompts escalating to Bedrock. From **v1.2**, Anthropic tools pass through natively and tokens stream live. **v1.2.1** keeps chitchat/recap turns on local models and coerces fake tool JSON into plain text. **v1.5** adds harness profiles, sticky sessions, `/status`, premium pool failover, and default learned routing hints.

## Lessons learned

1. **Visibility beats cleverness** — always-on routing debug saved more time than smarter rules
2. **Infra fails silently** — zombie LiteLLM taught us to probe before route, not after failure
3. **Keywords lie** — "design" and "architecture overview" need bounded context, not naive matching
4. **Empty ≠ empty** — invisible characters and alternate response fields break naive evaluators
5. **Ship distribution early** — `maestro init` mattered more than another routing feature
6. **Tools present ≠ tools needed** — harness catalogs on every turn must not force premium

## What's next

Online bandits / weight training on top of the v1.5 telemetry cells, and richer multi-harness adapters.

---

*Maestro AI is open source (MIT): [github.com/David-J-Shibley/maestro-ai](https://github.com/David-J-Shibley/maestro-ai) · npm: [`maestro-ai`](https://www.npmjs.com/package/maestro-ai)*
