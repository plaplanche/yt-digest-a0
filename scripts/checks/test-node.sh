#!/usr/bin/env bash
# Node tests: pytest on node/tests/.
set -euo pipefail
cd "$(dirname "$0")/../../node"

uv sync --locked
uv run --locked pytest tests
