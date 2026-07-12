# Maestro AI — Vision

**Tagline:** *The AI orchestration engine.*

**Subtitle options:** Conducting intelligence · Your AI conductor · The right model for every task.

Maestro is not just a model router. It is an **orchestration engine** that decides *which intelligence* should execute each request — based on task intent, policy, cost, privacy, history, and quality feedback — then explains that decision in plain language.

## Stack position

```
Agent (Cursor, Claude Code, your app)
        ↓
   Maestro AI          ← decision layer (this project)
        ↓
 LiteLLM / Ollama     ← gateway layer (transport)
        ↓
   Model providers
```

**LiteLLM** is an excellent gateway — API normalization, keys, proxying.

**Maestro** focuses on **decision-making**: task analysis, policies, telemetry, evaluation, learning, and eventually multi-step workflows. That is a distinct layer and a compelling long-term direction.

## Roadmap

### v0.1 — Smart Routing ✅ (shipped)

- Choose the best model tier from heuristics
- Local vs cloud
- Cost-aware routing and telemetry
- Tier fallbacks and escalation
- Probe availability before route
- Response evaluation loop

### v0.5 — Policy Engine ✅ (shipped)

- User preferences (`max_tier`, `budget_usd`, `always_prefer_local`)
- Declarative policy file (`~/.maestro-ai/policy.json`)
- Privacy rules — sensitive signals never leave localhost
- Task-type → tier overrides
- **Explain Your Decision** — human-readable routing card on every response
- Historical success rates from telemetry in explanations

### v0.6 — Evaluator-Driven Escalation ✅ (shipped)

Maestro moves from *"I chose the right model"* to *"I verified the result and escalated when needed"*:

```
Evaluator → validation result → retry same tier → escalate next tier → explain escalation → log outcome
```

- Per-tier retry accounting (`maxRetriesPerTier`)
- Validation outcome in every `maestro_ask` report
- Killer decision card: Selected → Validation failed → Escalated to → Final result → Why
- Per-attempt `attemptLog` in telemetry

### v0.7 — Routing Modes ✅ (shipped)

Operator control plane before workflow orchestration. Modes reuse policy/router/evaluator and become constraints for v1.0.

| Mode | Intent |
|------|--------|
| `balanced` | Default heuristics (current behavior) |
| `local-only` | Never above `local_strong` |
| `cheapest` | Minimize cost, nudge to lowest viable tier |
| `fastest` | Favor `local_fast`, skip same-tier retries |
| `best-quality` | Allow premium, bias toward higher tiers |
| `private` | Localhost only + privacy policy enforced |

Telemetry tracks mode distribution and per-mode success rates — e.g. *"cheapest failed 12% more often than balanced."*

### v0.8 — Budget / Privacy / Latency Guardrails

### v0.9 — Learned Routing Prep / Telemetry Analysis

### v1.0 — Workflow Orchestration

Instead of `User → Claude`, enable:

```
User
  ↓
Planner
  ↓
Task Decomposer
  ↓
Maestro
     ├── Local Qwen
     ├── Claude
     ├── Gemini
     ├── DeepSeek
     └── GPT-5
  ↓
Evaluator
  ↓
Synthesizer
```

Maestro stops choosing *a* model and starts **conducting an orchestra** — fan-out, merge, retry, synthesize.

### v2.0 — Self-Learning

Telemetry becomes training data:

| Prompt features | Difficulty | Model | Latency | Cost | Eval score | User rating |
|-----------------|------------|-------|---------|------|------------|-------------|

After sufficient volume, routing becomes **evidence-based**:

- "Qwen succeeds on 94% of React refactors."
- "Claude is worth the premium for architecture."
- "Local Llama is fine for summarization."

Deterministic rules remain the floor; learned weights sit on top.

## Defining capability: Explain Your Decision

Every routed request includes a structured and human-readable explanation.

**Structured** (`explanation.why[]`) — for agents and tooling.

**Markdown** (`explanation.markdown`) — for humans and docs.

Example:

```
🎼 Maestro Decision

Task: Code generation · Medium · Low risk

Selected: qwen3-coder-next (hosted_oss)
  ✓ Code-specialized model for medium coding tasks
  ✓ Running via litellm
  ✓ Estimated ~95% lower cost than premium tier
  ✓ Historical success rate: 93% (42 similar tasks)

Fallback if evaluation fails: Claude Sonnet (premium)

Session budget: $0.38 remaining of $0.50
```

When routing misfires, you know **why** it chose that model — tuning becomes editing policy and rules, not grep-ing logs.

## Principles

1. **Visibility beats cleverness** — always explain decisions
2. **Cheap by default** — escalate only with evidence
3. **Harness-agnostic** — MCP, CLI, npm package, TypeScript API
4. **Rules first, learning later** — heuristics + policy until telemetry earns ML
5. **Gateway-agnostic** — Ollama, LiteLLM, any OpenAI-compatible endpoint

## Links

- [Setup guide](./SETUP.md)
- [Technical article](./ARTICLE.md)
- [GitHub](https://github.com/David-J-Shibley/maestro-ai)
- [npm](https://www.npmjs.com/package/maestro-ai)
