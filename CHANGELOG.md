# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-07-27

### Added
- **Native Anthropic `/v1/messages` passthrough** via LiteLLM — Claude Code `tools` / `tool_use` / `tool_result` (and betas) stay Anthropic-shaped end-to-end so real harness tools execute.
- **OpenAI tool streaming fallback** — `tool_calls` deltas map to Anthropic `tool_use` SSE when native Messages isn’t available.
- **Live token streaming** — proxy streams upstream tokens as they arrive (no post-buffer dump) for Anthropic and OpenAI clients.
- **Idle keepalives** — Anthropic `ping` / SSE comments and JSON whitespace keepalives so Claude Code doesn’t idle-reset long routes.

### Changed
- **Large tool catalogs** (≥20 tools) count as long-context / agent-harness work and prefer premium tiers (e.g. Bedrock) instead of short-context hosted OSS.
- **Tool-use routing floor** — tool-bearing turns aren’t preferLocal-downgraded to weak tiers.
- README documents native tool passthrough for the proxy.

### Fixed
- Lift `role: "system"` messages into the top-level `system` parameter (Bedrock/Anthropic reject system roles inside `messages[]`).
- Truncated LiteLLM streams (bare `message_start` on context overflow) now complete with `message_stop` + a clear error instead of Claude Code’s “Stream ended without receiving any events”.
- Deduplicate LiteLLM’s double `message_start` frames.
- Avoid Anthropic `ping` before `message_start` (confused Claude Code’s stream parser).

[1.2.0]: https://github.com/David-J-Shibley/maestro-ai/releases/tag/v1.2.0

## [1.1.0] - 2026-07-26

### Added
- **Transparent OpenAI + Anthropic proxy** — `maestro proxy [--port 4100]` serves:
  - OpenAI: `POST /v1/chat/completions` (Cursor / OpenAI SDKs; base URL `http://127.0.0.1:4100/v1`)
  - Anthropic: `POST /v1/messages` (Claude Code; set `ANTHROPIC_BASE_URL=http://127.0.0.1:4100` **without** `/v1`)
- **Proxy `--max-tier` / `--prefer-local`** — cap escalation (e.g. `--max-tier hosted_oss`) so Claude Code’s large tool prompts don’t hit Bedrock when AWS SSO is down.
- **Client model echo** — completions return the id the client requested (`maestro`, `glm`, `claude-sonnet-4-6`, …); real routed model is in `maestro.routed_model`.
- **Anthropic + OpenAI streaming** — single-burst SSE in the shape each client expects.
- **`maestro_workflow` MCP tool** — run multi-step workflows from Cursor; `maestro_ask` also accepts `workflow` / `dry_run_workflow`.
- **Probe TTL cache** (`probeCacheTtlMs`, default 30s) — fewer endpoint hits on frequent subtasks; `force:true` on `maestro_probe` / doctor refreshes.
- **Routing golden set** (`tests/fixtures/routing-golden.json`) — CI regression for analyzer/router accuracy without live probes.
- **Secret-pattern privacy** — AWS keys, `sk-`, GitHub tokens, private key PEM, DB URLs, Bearer tokens cap to local tiers (`detect_secrets`).

### Changed
- **Dry-run route skips live probe by default** — returns *intended* tier; opt in with `probe:true`, `debug:true`, or `routing.probeOnDryRun`.
- **Compact MCP reports by default** — full debug/probe only when `debug:true`.
- **Quieter auto workflows** — simple `code_edit` uses single-shot unless tests/build are mentioned, task is hard/high-risk, quality=best, or validation hooks are provided.
- **Deep-merge session overrides** — nested `session` fields no longer clobber each other.
- Workflow reports note when tool validation was skipped (no `runTests`/`runBuild` hooks).

### Fixed
- MCP premium/architecture route tests no longer depend on live LiteLLM availability.
- Proxy no longer dies silently on client disconnect / unhandled write errors (request logging + process guards on Node 22+).

[1.1.0]: https://github.com/David-J-Shibley/maestro-ai/releases/tag/v1.1.0

## [1.0.1] - 2026-07-16

### Fixed
- **Send `max_tokens` on every request** (default 8192). Previously output length was governed by the provider default, which silently truncated generations at ~4096 tokens. Applies to both the non-streaming and streaming call paths.
- **Retry truncation on the same tier with a larger `max_tokens`** instead of escalating. `finish_reason=length` is now detected even when partial content is present, and retried on the same tier with a doubled `max_tokens` (capped at 32768, max 2 retries) rather than escalating to a tier that truncates the same way. Truncation retries run even when escalation is disabled; normal same-tier retries stay gated on `enableEscalation`.
- **Scope refusal detection to the opening of the response.** Refusal patterns now match against the first 150 chars and are gated on a 500-char length guard, so legitimate long output containing phrases like "I can't" is no longer flagged as a refusal.

[1.0.1]: https://github.com/David-J-Shibley/maestro-ai/releases/tag/v1.0.1

## [1.0.0] - 2026-07-12

### Added
- **Workflow orchestration engine** (`src/workflow/`) — plan, execute, validate, and synthesize multi-step objectives.
- Built-in workflow patterns: single-shot, plan-execute-validate, parallel-synthesis, critique-revise, implement-test-fix, extract-normalize-validate.
- **`runWorkflow()` / `dryRunWorkflow()`** public API with step-level routing via existing `routedLLMCall`.
- **Execution reports** — human-readable Maestro Execution Report per workflow.
- **Workflow telemetry** — `recordType: "workflow"` JSONL records for pattern/step analysis.
- CLI: `--workflow <pattern>`, `--dry-run-workflow` on `maestro ask` / `maestro call`.
- Tests: `tests/workflow-*.test.ts`.

### Changed
- Single-shot routing remains default when workflow orchestration is not needed.
- Telemetry stats skip workflow records when aggregating single-call metrics.

[1.0.0]: https://github.com/David-J-Shibley/maestro-ai/releases/tag/v1.0.0

## [0.9.0] - 2026-07-12

### Added
- **Telemetry routing analysis** (`src/telemetry/analysis.ts`) — per-task × per-tier cells, recommendations, findings, mode comparisons, learned-routing readiness.
- **`maestro analyze`** CLI (alias `insights`) — human-readable routing insights from telemetry.
- **`maestro_analyze`** MCP tool — same analysis for agent harnesses.
- **`maestro_stats` `insights: true`** — optional routing insights in stats responses.
- **Learned routing hints** (opt-in) — `learnedRoutingHints` + `learnedMinSamples` in config; router nudges tier from telemetry when confidence is sufficient.
- **`telemetry_recommendation`** in routing reports and decision explanations.
- Shared **`servedTier()` / `servedModel()`** helpers in `src/telemetry/records.ts`.
- Tests: `tests/analysis.test.ts`, `tests/learned.test.ts`.

[0.9.0]: https://github.com/David-J-Shibley/maestro-ai/releases/tag/v0.9.0

## [0.8.0] - 2026-07-12

### Added
- **Guardrails engine** (`src/routing/guardrails.ts`) — budget, privacy, and latency guardrails applied after routing/modes.
- `guardrails` section in `policy.json` with per-guardrail enable/target settings.
- **Guardrails** section in decision explanations and routing reports.
- **Compact probe summary** in CLI `--debug` (full probe data still in `--json`).
- Tests: `tests/guardrails.test.ts`, `tests/probe-summary.test.ts`.
- Shared `tierMeetsTask()` in `src/routing/tier-fit.ts`.

[0.8.0]: https://github.com/David-J-Shibley/maestro-ai/releases/tag/v0.8.0

## [0.7.1] - 2026-07-12

### Added
- CLI `--version` / `-v` flag and `maestro version` command (checked before other commands).

### Fixed
- Duplicate mode lines in routing debug trace and decision explanations.
- Contradictory summarization rule text when `cheapest` mode nudges to `local_fast`.

[0.7.1]: https://github.com/David-J-Shibley/maestro-ai/releases/tag/v0.7.1

## [0.7.0] - 2026-07-12

### Added
- **Routing modes** — operator control plane: `balanced`, `local-only`, `cheapest`, `fastest`, `best-quality`, `private`.
- `src/routing/modes.ts` — mode constraints applied to router, escalation, and retries.
- `mode` field on MCP tools (`maestro_route`, `maestro_ask`), CLI (`--mode`), and telemetry.
- Per-mode success rates in `maestro stats` (`modeDistribution`, `modeSuccessRates`).
- Mode shown in decision explanations (`explanation.mode`, markdown **Mode:** line).
- `defaultMode` in config (`balanced` by default).
- Tests: `tests/modes.test.ts`.

### Changed
- Escalation respects mode `maxTier` (e.g. `local-only` cannot escalate to cloud).
- `fastest` mode sets `maxRetriesPerTier: 0`.

[0.7.0]: https://github.com/David-J-Shibley/maestro-ai/releases/tag/v0.7.0

## [0.6.0] - 2026-07-12

### Added
- **Evaluator-driven escalation** — per-tier retry accounting, then escalate when validation still fails.
- **Validation outcome** in `maestro_ask` reports: selected tier, failed checks, retries, escalation, final result, and why.
- **`attemptLog`** in telemetry — per-attempt tier, action, pass/fail, and failed checks.
- **`initialRouting`** on `RoutedLLMCallResult` — preserves pre-escalation route decision.
- Tests: `tests/outcome-escalation.test.ts`; updated fallback integration tests.

### Changed
- Escalation loop: retry same tier first (up to `maxRetriesPerTier`), then escalate — no fast-escalate bypass for empty/corrupt output.
- `evaluateResponseAsync` recomputes `retryRecommended` / `escalationRecommended` after async checks.
- `recentFailures` in stats uses the tier that actually served the call when escalated.

[0.6.0]: https://github.com/David-J-Shibley/maestro-ai/releases/tag/v0.6.0

## [0.5.0] - 2026-07-12

### Added
- **docs/VISION.md** — product vision and design principles for Maestro AI.
- **Routing policy engine** with bundled `config/default.policy.json` for declarative routing rules; policy types and loading integrated into config and init.
- **Explain Your Decision** — structured explanations in routing reports describing why a tier and model were chosen.
- **Historical stats for explanations** — telemetry and `maestro stats` aggregate explanation-related routing metadata over time.
- **Tests** — `tests/explanation-policy.test.ts` plus updates to MCP and router tests (82 tests passing).
- **README** and **docs/SETUP.md** updated for the policy engine, decision explanations, and configuration.

[0.5.0]: https://github.com/David-J-Shibley/maestro-ai/releases/tag/v0.5.0

## [0.4.1] - 2026-07-12

### Fixed
- Telemetry stats no longer conflate a *configured* fallback tier with an *actual* escalation. Previously, any call with a fallback tier configured (e.g. `local_strong` with `hosted_oss` fallback) was mis-counted as an escalation and attributed to the fallback tier/model — inflating `escalationRate` and skewing `tierDistribution`/`modelDistribution`. Stats now use an explicit `escalated` flag recorded per call, so each call is attributed to the tier/model that actually served it.

### Changed
- `TelemetryRecord` gained an `escalated` boolean field (additive; legacy records treated as non-escalated).
- `*.tgz` is now gitignored.

[0.4.1]: https://github.com/David-J-Shibley/maestro-ai/releases/tag/v0.4.1

## [0.4.0] - 2026-07-11

### Added
- Dynamic model routing across four tiers: `local_fast`, `local_strong`, `hosted_oss`, `premium`.
- Task analyzer classifying prompts by type, difficulty, risk, tool/code/long-context requirements.
- Tier fallback (primary → fallback per tier) and auto-escalation on evaluator failure.
- MCP server exposing `maestro_route`, `maestro_ask`, `maestro_probe`, `maestro_doctor`, `maestro_stats`, `maestro_feedback`.
- CLI: `maestro init` (profiles: `default`, `ollama-only`, `cloud-only`), `maestro doctor`, `maestro probe`, `maestro route`, `maestro ask`, `maestro stats`.
- Harness adapters for Benchy, Vercel AI (`resolveModel` replacement), and Claude Code.
- Telemetry logging to `~/.maestro-ai/telemetry.jsonl` (metadata only: tier, model, latency, token counts, cost — no prompt/response bodies).
- Per-session budget caps (`budget_usd`), `max_tier` ceiling, and `always_prefer_local` policy.
- Response evaluator with `non_empty` / `no_refusal` checks and retry/escalation signals.
- Bundled config profiles and LiteLLM starter (`config/`).
- Vitest test suite.

[0.4.0]: https://github.com/David-J-Shibley/maestro-ai/releases/tag/v0.4.0