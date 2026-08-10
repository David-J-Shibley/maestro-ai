# Maestro vs LiteLLM (and static agent routing)

People often ask: *“Why not just define `orchestrator`, `research`, `coder` aliases in LiteLLM and hardcode them in my agent?”*

Fair question. Here’s the split.

## Stack position

```
Agent (Claude Code, Cursor, your app)
        ↓
   Maestro AI          ← **which tier for this turn?** (decision)
        ↓
 LiteLLM / Ollama     ← **how to call that model?** (gateway)
        ↓
   Providers
```

**LiteLLM** is excellent at: model aliases, fallbacks, load balancing, keys, unified API.

**Maestro** is excellent at: analyzing *this* request, picking a tier, recovering when wrong, and explaining why — without your agent encoding a routing matrix.

## What LiteLLM gives you

| Capability | LiteLLM |
|------------|---------|
| Named models (`orchestrator` → `gpt-4o`) | ✅ |
| Fallback chains | ✅ |
| Load balancing / rate limits | ✅ |
| OpenAI-compatible proxy | ✅ |

You configure routing **once**. Every call to alias `orchestrator` hits the same backend until you change config.

## What Maestro adds on top

| Capability | Maestro |
|------------|---------|
| Per-turn task analysis (difficulty, risk, tools) | ✅ |
| Same harness, different tier per message (`hi` vs refactor vs architecture) | ✅ |
| Claude Code–aware proxy (omit tools on chitchat, mid-loop tool forwarding) | ✅ |
| Retry → escalate when evaluation fails | ✅ |
| Modes (`local-only`, `private`, `cheapest`, `best-quality`) | ✅ |
| Session budget + privacy guardrails | ✅ |
| Cache-aware sticky (don’t thrash cloud tiers mid-session) | ✅ |
| Workload roles *or* automatic heuristics | ✅ |
| “Why this model?” on every decision | ✅ |
| Telemetry → learned routing hints | ✅ |

Maestro **uses** LiteLLM as a gateway. It does not replace it.

## When static LiteLLM aliases are enough

- Each agent has **one fixed role** forever (`research-bot` always uses `research` alias).
- You don’t need per-message routing inside a single session.
- You’re okay maintaining routing logic in application code.
- You’re not pointing Claude Code at a local/cloud blend through one base URL.

## When Maestro pays off

- **One harness** (especially Claude Code) mixes trivial, medium, and hard turns in the same thread.
- You want **cheap-by-default, escalate-on-failure** without hand-writing that in the agent.
- You want **Claude API compatibility** but most turns on local/OSS — with smarts so it doesn’t break tool loops.
- You care about **cost, privacy, and explainability** as first-class outputs.

## The Claude Code case

Re-pointing `ANTHROPIC_BASE_URL` at Ollama or raw LiteLLM often fails because:

- Tool catalogs on every turn inflate context and trip the wrong model.
- Chitchat (`hi`, recap) shouldn’t pay premium prices or hit Bedrock.
- Mid-agent “ok continue” must keep tools forwarded.
- Fake tool JSON needs coercion on plain turns.

Maestro’s proxy is built for that harness behavior — not just “swap the upstream URL.”

## One-line pitch

> **LiteLLM routes requests to models you named. Maestro decides which name should run for this turn — and recovers when it guessed wrong.**

See [DEMO.md](./DEMO.md) for a reproducible walkthrough.
