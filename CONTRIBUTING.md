# Contributing to Maestro AI

Thanks for your interest in contributing! Maestro AI is a dynamic model-delegation layer for agentic coding harnesses. This guide covers getting set up and how to submit changes.

## Requirements

- **Node.js 20+**
- At least one LLM backend:
  - **Ollama only** (`maestro init --profile ollama-only`) — no LiteLLM required
  - **LiteLLM + Ollama** (default profile) — for the full tier ladder
  - **Cloud only** (`maestro init --profile cloud-only`) — LiteLLM + API keys, no Ollama

## Dev setup

```bash
git clone https://github.com/David-J-Shibley/maestro-ai.git maestro-ai
cd maestro-ai
npm install        # runs prepare → build
maestro init       # creates ~/.maestro-ai/ and machine-specific config
maestro doctor     # verify your backends are reachable
```

## Common commands

| Command | What it does |
|---------|--------------|
| `npm run build` | Compile TypeScript (`tsc`) → `dist/` |
| `npm run dev` | Watch mode compile |
| `npm test` | Run the vitest suite |
| `npm run typecheck` | `tsc --noEmit` (no emit) |
| `npm run mcp` | Run the MCP server directly |

## Project layout

```
src/
  adapters/      thin wrappers for harness integrations (Benchy, Vercel AI, Claude Code)
  analyzer/      task-analyzer.ts — classifies prompt → task type / difficulty / risk
  config/        config loading, package paths, tier config, policy
  doctor/        infrastructure diagnostics (maestro doctor)
  evaluator/     response evaluator (non_empty, no_refusal, retry/escalation signals)
  init/          `maestro init` setup
  mcp/           MCP server, tools, schemas
  provider/      OpenAI-compatible client, probing (TTL cache), streaming
  proxy/         transparent OpenAI + Anthropic HTTP proxy (`maestro proxy`)
  router/        model-router.ts — tier selection
  routing/       budget, guardrails, modes, learned routing, reporting
  telemetry/     logger.ts (jsonl), stats.ts, analysis.ts
  workflow/      planner, DAG executor, patterns, validation, reports
  cli.ts         CLI entry (`maestro`)
config/          bundled config profiles + LiteLLM starter
tests/           vitest suite (+ fixtures/routing-golden.json)
```

## Adding a new harness adapter

Adapters live in `src/adapters/` and are thin wrappers over `dryRunRoute` / `routedLLMCall` (see `src/adapters/index.ts` for existing examples — Benchy, Vercel AI, Claude Code). To add one:

1. Add your adapter function in `src/adapters/index.ts` (or a new file exported from it).
2. Add a test in `tests/` covering at least the happy path.
3. Document it in the README under **Harness adapters**.

## Workflow

1. Fork the repo and create a branch from `main`.
2. Make your change. Keep commits focused.
3. Ensure locally:
   ```bash
   npm run typecheck && npm test && npm run build
   ```
4. Open a pull request against `main`. Fill in the PR template.

### Commit messages

Use a short imperative summary. Reference an issue if applicable:

```
fix: route empty responses through fallback tier

Closes #123
```

### Pull requests

- One logical change per PR.
- Include tests for new behavior.
- Don't commit `dist/`, `node_modules/`, `.claude/`, or real secrets — see `.gitignore`.
- If your change affects routing behavior, note the before/after in the PR description.

## Reporting issues

Use the GitHub issue templates. For security-sensitive reports, see [`SECURITY.md`](./.github/SECURITY.md) — **do not** open a public issue.

## Code of conduct

By participating you agree to abide by the [Code of Conduct](./CODE_OF_CONDUCT.md).