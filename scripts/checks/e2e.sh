#!/usr/bin/env bash
# End-to-end check: Playwright Test in e2e/ against the local stack (spec/lot-2.md sections 3.1 and 13).
set -euo pipefail
cd "$(dirname "$0")/../.."

# Always stops the stack; on failure, keeps the stack logs and the Playwright report in ci-artifacts/.
finish() {
  local status=$?
  ./scripts/stack.sh down
  if ((status != 0)); then
    mkdir -p ci-artifacts
    [[ -d .stack/logs ]] && cp -r .stack/logs ci-artifacts/stack-logs
    [[ -d e2e/playwright-report ]] && cp -r e2e/playwright-report ci-artifacts/playwright-report
  fi
  exit "$status"
}
trap finish EXIT

(cd e2e && npm ci)

projects=()
if [[ -n "${CI:-}" ]]; then
  (cd e2e && npx playwright install --with-deps chromium)
elif ! (cd e2e && timeout 120 npx playwright install chromium); then
  echo "e2e: chromium unavailable, browser project skipped"
  projects=(--project api)
fi

LEASE_SECONDS=2 ./scripts/stack.sh up
(cd e2e && npx playwright test "${projects[@]}")
