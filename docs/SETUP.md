# Maestro AI — setup guide

Get Maestro running on a new machine in ~10 minutes.

## Requirements

- **Node.js 20+**
- At least one LLM backend (see profiles below)

## Install

### Option A — clone and build (development)

```bash
git clone https://github.com/David-J-Shibley/maestro-ai.git maestro-ai
cd maestro-ai
npm install    # runs prepare → build
```

### Option B — npm (when published)

```bash
npm install -g maestro-ai
```

### Option C — run without global install

```bash
npx maestro-ai init --profile ollama-only
```

## First-time setup

```bash
maestro init
```

This will:

1. Create `~/.maestro-ai/`
2. Copy a config profile to `~/.maestro-ai/config.json`
3. Copy `litellm.yaml` and `.env.example` into `~/.maestro-ai/`
4. Check which Ollama models you still need to pull
5. Write `~/.maestro-ai/mcp-config.json` for Cursor / Claude Code
6. Run `maestro doctor`

### Config profiles

| Profile | Command | What you need |
|---------|---------|---------------|
| **default** | `maestro init` | Ollama + LiteLLM + API keys |
| **ollama-only** | `maestro init --profile ollama-only` | Ollama only (easiest) |
| **cloud-only** | `maestro init --profile cloud-only` | LiteLLM + API keys, no Ollama |

Re-run with `--force` to overwrite an existing config.

## Ollama setup (default + ollama-only)

```bash
# Install: https://ollama.com
ollama pull llama3.2:latest
ollama pull qwen3:8b
maestro doctor
```

`maestro init` prints any missing models for your chosen profile.

## LiteLLM setup (default + cloud-only)

```bash
pip install 'litellm[proxy]'

# Copy env vars from ~/.maestro-ai/.env.example into your shell or .env
export FEATHERLESS_API_KEY=your_key
export LITELLM_MASTER_KEY=sk-litellm-local

litellm --config ~/.maestro-ai/litellm.yaml --port 4000
```

Premium tier (Claude via Bedrock) also needs AWS credentials — optional if you cap with `max_tier: hosted_oss`.

## Cursor MCP

After `maestro init`:

1. Open `~/.maestro-ai/mcp-config.json`
2. Merge the `mcpServers` block into Cursor → Settings → MCP
3. Reload MCP / restart Cursor

Or for a git clone, use `cursor-mcp-config.json` as a reference — run `maestro init` for machine-specific paths.

## Claude Code MCP

```bash
# After maestro init — use the path from mcp-config.json
claude mcp add maestro-ai -- node /path/to/maestro-ai/dist/mcp-server.js
```

Set `MAESTRO_CONFIG=~/.maestro-ai/config.json` in the MCP env.

## Verify

```bash
maestro doctor
maestro route "summarize this paragraph" --debug
maestro ask "rewrite: fix typo in hello world"
```

## Environment variables

See `.env.example` in the repo or `~/.maestro-ai/.env.example` after init:

| Variable | Required for | Purpose |
|----------|--------------|---------|
| `MAESTRO_CONFIG` | Optional | Defaults to `~/.maestro-ai/config.json` after init |
| `LITELLM_MASTER_KEY` | LiteLLM profiles | Proxy auth (default: `sk-litellm-local`) |
| `FEATHERLESS_API_KEY` | Hosted OSS / GLM | Featherless API |
| `AWS_*` | Premium (Bedrock) | Claude Sonnet via Bedrock |

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Config file not found` | Run `maestro init` |
| LiteLLM connection refused | Start proxy on port 4000 |
| Model not found | `ollama pull <model>` — init lists missing ones |
| MCP tools missing | Rebuild (`npm run build`), reload MCP, check `mcp-config.json` paths |
| Zombie LiteLLM | `maestro doctor` → kill stale process, restart |

## Custom config

Edit `~/.maestro-ai/config.json` or set `MAESTRO_CONFIG` to your own file. See `config/default.config.json` in the repo for the full schema (primary/fallback per tier).
