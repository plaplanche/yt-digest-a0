#!/usr/bin/env bash
# Contracts check: the committed generated files match the schemas in contracts/.
set -euo pipefail
cd "$(dirname "$0")/../.."

if [[ ! -x scripts/contracts.sh ]]; then
  echo "scripts/contracts.sh does not exist yet: nothing to check"
  exit 0
fi
./scripts/contracts.sh --check
