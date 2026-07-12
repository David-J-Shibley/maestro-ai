# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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