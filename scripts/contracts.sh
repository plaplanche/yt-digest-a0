#!/usr/bin/env bash
# Generates the contract code from contracts/*.schema.json: ./scripts/contracts.sh [--check]
# Pydantic v2 models go to node/src/yt_digest_node/contracts/, TypeScript to worker/src/contracts/.
# With --check, regenerates into a temporary directory and exits 1, naming the files, when a
# committed generated file differs, is missing or is not generated.
set -euo pipefail
cd "$(dirname "$0")/.."

py_dir=node/src/yt_digest_node/contracts
ts_dir=worker/src/contracts
check=false
case "${1:-}" in
  "") ;;
  --check) check=true ;;
  *) echo "usage: $0 [--check]" >&2; exit 2 ;;
esac

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
uv run --quiet --project node --locked python scripts/contracts_gen.py "$tmp"
uv run --quiet --project node --locked ruff format --quiet --config node/pyproject.toml "$tmp/py"

list() {
  if [[ -d "$1" ]]; then
    (cd "$1" && find . -type f -not -path '*/__pycache__/*' | sed 's|^\./||')
  fi
}

if ! $check; then
  rm -rf "$py_dir" "$ts_dir"
  mkdir -p "$(dirname "$py_dir")" "$(dirname "$ts_dir")"
  cp -R "$tmp/py" "$py_dir"
  cp -R "$tmp/ts" "$ts_dir"
  echo "contracts: generated $py_dir and $ts_dir"
  exit 0
fi

stale=()
for pair in "py:$py_dir" "ts:$ts_dir"; do
  fresh="$tmp/${pair%%:*}"
  committed="${pair#*:}"
  while IFS= read -r file; do
    if ! cmp -s "$fresh/$file" "$committed/$file" 2>/dev/null; then
      stale+=("$committed/$file")
    fi
  done < <({ list "$fresh"; list "$committed"; } | sort -u)
done

if ((${#stale[@]})); then
  echo "contracts: generated files are stale, run ./scripts/contracts.sh:" >&2
  printf '  %s\n' "${stale[@]}" >&2
  exit 1
fi
echo "contracts: generated files are up to date"
