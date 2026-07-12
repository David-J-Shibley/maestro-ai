# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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