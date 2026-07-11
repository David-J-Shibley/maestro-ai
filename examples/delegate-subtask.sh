#!/usr/bin/env bash
# Delegate a cheap subtask to Maestro from Claude Code, Benchy, or any shell hook.
#
# Prerequisite: maestro init  (creates ~/.maestro-ai/config.json)
#
# Usage:
#   ./examples/delegate-subtask.sh "Summarize this error log in 3 bullets"
#   ./examples/delegate-subtask.sh "Rewrite this commit message" --session my-chat-1 --budget 0.25
#
# Requires: npm run build, Ollama + LiteLLM running.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAESTRO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ ! -f "$HOME/.maestro-ai/config.json" ]]; then
  echo "Run 'maestro init' first (from $MAESTRO_ROOT)" >&2
  exit 1
fi

PROMPT="${1:-}"
if [[ -z "$PROMPT" ]]; then
  echo "Usage: $0 \"<literal task prompt>\" [--session ID] [--budget USD]" >&2
  exit 1
fi
shift || true

ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --session) ARGS+=(--session-id "$2"); shift 2 ;;
    --budget)  ARGS+=(--budget-usd "$2"); shift 2 ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

cd "$MAESTRO_ROOT"
node dist/cli.js ask "$PROMPT" --json "${ARGS[@]}"
