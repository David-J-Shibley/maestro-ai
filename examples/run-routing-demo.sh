#!/usr/bin/env bash
# Maestro routing demo — dry-run only (no LLM calls). Shows per-turn tier decisions,
# workload roles, and cache-aware sticky. Safe to run without Ollama/LiteLLM up.
#
# Usage:
#   ./examples/run-routing-demo.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ ! -f "$ROOT/dist/cli.js" ]]; then
  echo "Build first: cd $ROOT && npm run build" >&2
  exit 1
fi

MAESTRO=(node "$ROOT/dist/cli.js")
SESSION="maestro-demo-$(date +%s)"

section() {
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  $1"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
}

show_route() {
  local title="$1"
  shift
  section "$title"
  local out
  out=$("${MAESTRO[@]}" route "$@" 2>&1) || true
  echo "$out" | grep -E '^(Tier:|Reason:|Model:)' || true
  echo ""
  echo "$out" | awk '/🎼 Maestro Decision/,/^$/{if (NF) print}' | head -18
}

echo ""
echo "  Maestro AI — routing demo (dry-run, no API keys required)"
echo "  Sticky session id: $SESSION"
echo ""

show_route "1. Chitchat stays local (not Bedrock on 'hi')" \
  "hi are you working"

show_route "2. Simple HTML demo → local_fast" \
  "make me a simple html page that says hello"

show_route "3. Medium refactor → hosted_oss" \
  "Refactor this medium module and add proper TypeScript types."

show_route "4. Architecture / high stakes → premium" \
  "Design system architecture for event sourcing with trade-offs and failure modes."

show_route "5. Workload role: orchestrator floors to cloud" \
  "Rewrite this paragraph more clearly." \
  --workload orchestrator

show_route "6. Workload role: formatter caps local" \
  "Format this list as markdown bullet points." \
  --workload formatter

section "7. Cache-aware sticky — session stays on premium"
echo "  Without sticky vs after a premium turn in the same session:"
echo ""

node "$ROOT/examples/demo-sticky.mjs"

section "Done"
echo "  Claude Code + proxy walkthrough → docs/DEMO.md"
echo "  LiteLLM comparison → docs/COMPARISON.md"
echo ""
