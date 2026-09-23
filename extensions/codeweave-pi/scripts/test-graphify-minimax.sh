#!/usr/bin/env bash
set -euo pipefail

# Minimal graphify+minimax smoke test.
# Usage: PI_NAV_GRAPHIFY_PROVIDER=minimax MINIMAX_API_KEY=... scripts/test-graphify-minimax.sh [repo-dir]
#
# Creates a tiny repo if [repo-dir] is omitted, runs a deep build + rich-update
# through navigation-freshen.mjs, and asserts the core reliability invariant:
# the incremental LLM rich-update must NEVER collapse the graph, even when the
# reasoning model hollows (spends its output budget thinking and emits no JSON).
# A hollow extraction must preserve existing nodes and stay dirty for retry.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_ROOT="$(dirname "$SCRIPT_DIR")"
NAV="$EXT_ROOT/scripts/navigation-freshen.mjs"

: "${PI_NAV_GRAPHIFY_PROVIDER:?Set PI_NAV_GRAPHIFY_PROVIDER (e.g. minimax)}"
: "${MINIMAX_API_KEY:?Set MINIMAX_API_KEY}"

REPO="${1:-}"
if [[ -z "$REPO" ]]; then
  REPO="$(mktemp -d)"
  trap 'rm -rf "$REPO"' EXIT
fi

if [[ ! -f "$REPO/package.json" ]]; then
  mkdir -p "$REPO/src"
  printf '{ "name": "graphify-minimax-smoke" }\n' > "$REPO/package.json"
  printf 'export function charge(amount: number): string { return "chg:" + amount; }\n' > "$REPO/src/pay.ts"
  printf '# Payments\n\nThe checkout flow validates the card then creates a charge.\n' > "$REPO/src/pay.md"
  if command -v git >/dev/null 2>&1; then
    (cd "$REPO" && git init -q && git add -A && git -c user.email=test@test -c user.name=test commit -qm init)
  fi
fi

GRAPH="$REPO/.pi/navigation/graphify/graphify-out/graph.json"
count_nodes() { python3 -c "import json;print(len(json.load(open('$GRAPH')).get('nodes',[])))"; }

echo "==> deep build ($REPO)"
env PI_NAV_GRAPHIFY_MODEL="${PI_NAV_GRAPHIFY_MODEL:-MiniMax-M3}" GRAPHIFY_QUERY_LOG_DISABLE=1 \
  node "$NAV" graph --path "$REPO" --graphify-mode deep --graphify-provider "$PI_NAV_GRAPHIFY_PROVIDER" >/tmp/graphify-test-deep.log 2>&1 || {
    echo "DEEP BUILD FAILED"; tail -n 25 /tmp/graphify-test-deep.log; exit 1; }
grep -E "via openai|via minimax|wrote" /tmp/graphify-test-deep.log | head -4
DEEP_NODES="$(count_nodes)"
echo "deep nodes: $DEEP_NODES"
[[ "$DEEP_NODES" -gt 0 ]] || { echo "FAIL: deep build produced no nodes"; exit 1; }

printf '\n## Refunds\n\nA refund reverses the charge and emails a confirmation.\n' >> "$REPO/src/pay.md"

echo "==> rich-update"
env PI_NAV_GRAPHIFY_MODEL="${PI_NAV_GRAPHIFY_MODEL:-MiniMax-M3}" GRAPHIFY_QUERY_LOG_DISABLE=1 \
  node "$NAV" graph --path "$REPO" --graphify-mode rich-update --graphify-provider "$PI_NAV_GRAPHIFY_PROVIDER" >/tmp/graphify-test-rich.log 2>&1 || {
    echo "RICH-UPDATE FAILED"; tail -n 25 /tmp/graphify-test-rich.log; exit 1; }
RICH_NODES="$(count_nodes)"
echo "rich nodes: $RICH_NODES (was $DEEP_NODES)"

# Core invariant: the rich-update must not collapse the graph. Allow a little
# slack for legitimate re-extraction variance, but a drop to near-zero means a
# hollow extraction pruned existing nodes (the bug this test guards).
MIN_ACCEPTABLE=$(( DEEP_NODES / 2 ))
[[ "$MIN_ACCEPTABLE" -lt 2 ]] && MIN_ACCEPTABLE=2
if [[ "$RICH_NODES" -lt "$MIN_ACCEPTABLE" ]]; then
  echo "FAIL: rich-update collapsed the graph ($DEEP_NODES -> $RICH_NODES); hollow extraction pruned nodes"
  tail -n 25 /tmp/graphify-test-rich.log
  exit 1
fi

# Report whether the LLM extraction landed new content or the guard preserved.
if grep -q "hollow response\|produced no nodes\|invalid JSON" /tmp/graphify-test-rich.log; then
  echo "NOTE: LLM extraction hollowed this run; graceful-degradation guard preserved the graph ($RICH_NODES nodes)."
else
  echo "NOTE: LLM extraction succeeded; graph reflects the updated doc ($RICH_NODES nodes)."
fi

echo "PASS: graphify minimax deep + rich-update (no collapse): $DEEP_NODES -> $RICH_NODES nodes"
