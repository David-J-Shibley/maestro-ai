# Security policy

## Reporting a vulnerability

If you discover a security vulnerability in Maestro AI, **please do not open a public GitHub issue.**

Report it privately by opening a [private security advisory](https://github.com/David-J-Shibley/maestro-ai/security/advisories/new) on the repository, or email the maintainer directly if an advisory is unavailable.

Please include:

- A description of the issue and its potential impact
- Steps to reproduce (proof of concept if possible)
- The Maestro version, Node version, OS, and config profile
- Any relevant `maestro doctor` output (with keys redacted)

We will acknowledge receipt within a reasonable timeframe and work with you on a fix and disclosure timeline.

## Scope

Maestro AI routes prompts to local and remote LLM providers. The following are in scope for security reports:

- Credential handling — API keys (Featherless, AWS), the LiteLLM master key
- Telemetry logging — what gets written to `~/.maestro-ai/telemetry.jsonl`
- The LiteLLM proxy configuration shipped in `config/`
- The MCP server surface and CLI

## Credential handling

- **No credentials are committed to this repository.** `.env` files are gitignored; `.env.example` contains only empty placeholders.
- At runtime, credentials are read from environment variables (`FEATHERLESS_API_KEY`, `AWS_*`, `LITELLM_MASTER_KEY`) and the user config at `~/.maestro-ai/config.json`.
- The LiteLLM master key default is `sk-litellm-local`, intended **only** for the LiteLLM proxy bound to `localhost:4000`. If you ever expose LiteLLM beyond localhost, override it with a strong random key (see `docs/SETUP.md`).

## Telemetry

Telemetry records metadata only — tier, model, latency, token counts, estimated cost, success, and a hash of the prompt. **Prompt text, response text, and API keys are never written** to the telemetry log. See `src/telemetry/logger.ts` for the exact fields.