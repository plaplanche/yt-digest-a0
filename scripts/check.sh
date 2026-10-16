#!/usr/bin/env bash
# Runs one check, or all of them in order: ./scripts/check.sh <lint|contracts|test-node|test-worker|all>
# Each check is implemented by scripts/checks/<name>.sh; a check not implemented yet is skipped.
set -euo pipefail
cd "$(dirname "$0")/.."
checks=(lint contracts test-node test-worker)
run() {
  local script="scripts/checks/$1.sh"
  if [[ -x "$script" ]]; then
    echo "== $1"
    "$script"
  else
    echo "== $1: not implemented yet, skipped"
  fi
}
case "${1:-}" in
  all) for c in "${checks[@]}"; do run "$c"; done ;;
  lint | contracts | test-node | test-worker) run "$1" ;;
  *) echo "usage: $0 <lint|contracts|test-node|test-worker|all>" >&2; exit 2 ;;
esac
