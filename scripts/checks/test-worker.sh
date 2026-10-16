#!/usr/bin/env bash
# Worker tests: Vitest on worker/.
set -euo pipefail
cd "$(dirname "$0")/../../worker"

npm ci
npx vitest run
