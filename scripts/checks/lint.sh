#!/usr/bin/env bash
# Lint check: ruff, ruff format and mypy on node/; tsc and ESLint on worker/; shellcheck on scripts/.
set -euo pipefail
cd "$(dirname "$0")/../.."

(
  cd node
  uv sync --locked
  uv run --locked ruff check
  uv run --locked ruff format --check
  uv run --locked mypy --strict src tests
)

(
  cd worker
  npm ci
  npx tsc --noEmit
  npx eslint .
)

find scripts -name '*.sh' -print0 | xargs -0 uvx --from shellcheck-py==0.11.0.1 shellcheck
