#!/usr/bin/env bash
# Starts or stops the local stack (spec/lot-2.md section 5): ./scripts/stack.sh <up|down>
# up: the mocks server and `wrangler dev` on a fresh local D1 and R2 under .stack/state/; down: stops both.
set -euo pipefail
cd "$(dirname "$0")/.."
root="$PWD"

stack_dir="$root/.stack"
state_dir="$stack_dir/state"
logs_dir="$stack_dir/logs"
pids_dir="$stack_dir/pids"

# Configuration of section 5.2.
WORKER_PORT="${WORKER_PORT:-8787}"
MOCKS_PORT="${MOCKS_PORT:-8789}"
STACK_READY_TIMEOUT="${STACK_READY_TIMEOUT:-180}"
WORKER_URL="http://127.0.0.1:$WORKER_PORT"
MOCKS_URL="http://127.0.0.1:$MOCKS_PORT"
OPS_TOKEN="${OPS_TOKEN-ops-local}"
LEASE_SECONDS="${LEASE_SECONDS:-600}"
ACCESS_TOKEN_TTL_SECONDS="${ACCESS_TOKEN_TTL_SECONDS:-3600}"
REFRESH_TOKEN_TTL_SECONDS="${REFRESH_TOKEN_TTL_SECONDS:-2592000}"
AUTH_CODE_TTL_SECONDS="${AUTH_CODE_TTL_SECONDS:-60}"
AUTH_REQUEST_TTL_SECONDS="${AUTH_REQUEST_TTL_SECONDS:-600}"
GOOGLE_ISSUER="${GOOGLE_ISSUER:-$MOCKS_URL/google}"
GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-yt-digest-local}"
GOOGLE_CLIENT_SECRET="${GOOGLE_CLIENT_SECRET:-local-google-secret}"
ADMIN_EMAIL="${ADMIN_EMAIL:-alice@test}"
TOKEN_ENC_KEY="${TOKEN_ENC_KEY:-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=}"
ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-}"
export WRANGLER_SEND_METRICS=false

# Succeeds when something accepts connections on 127.0.0.1:<port>.
port_taken() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

# Stops every process group recorded under .stack/pids/: SIGTERM, then SIGKILL after 10 seconds.
down() {
  local pid_file pgid i
  [[ -d "$pids_dir" ]] || return 0
  for pid_file in "$pids_dir"/*.pid; do
    [[ -f "$pid_file" ]] || continue
    pgid="$(<"$pid_file")"
    if kill -TERM -- "-$pgid" 2>/dev/null; then
      for ((i = 0; i < 100; i++)); do
        kill -0 -- "-$pgid" 2>/dev/null || break
        sleep 0.1
      done
      kill -KILL -- "-$pgid" 2>/dev/null || true
    fi
    rm -f "$pid_file"
  done
}

fail() {
  echo "stack: $1" >&2
  down
  exit 1
}

# Starts a command in the background in its own process group, logging to .stack/logs/<name>.log.
start() {
  local name="$1" dir="$2"
  shift 2
  (cd "$dir" && exec setsid "$@" >"$logs_dir/$name.log" 2>&1 </dev/null) &
  echo "$!" >"$pids_dir/$name.pid"
}

healthy() {
  curl -fsS -o /dev/null --max-time 2 "$1/health" 2>/dev/null
}

up() {
  down
  local port
  for port in "$WORKER_PORT" "$MOCKS_PORT"; do
    port_taken "$port" && fail "port $port is already taken"
  done

  local package
  for package in worker e2e; do
    [[ -d "$root/$package/node_modules" ]] || (cd "$root/$package" && npm ci)
  done

  rm -rf "$state_dir"
  mkdir -p "$state_dir" "$logs_dir" "$pids_dir"
  : >"$logs_dir/worker.log"
  : >"$logs_dir/mocks.log"
  (cd "$root/worker" && npx wrangler d1 migrations apply DB --local --persist-to "$state_dir") ||
    fail "the D1 migrations failed"

  MOCKS_PORT="$MOCKS_PORT" GOOGLE_CLIENT_ID="$GOOGLE_CLIENT_ID" GOOGLE_CLIENT_SECRET="$GOOGLE_CLIENT_SECRET" \
    start mocks "$root/e2e" npx tsx mocks/server.ts
  start worker "$root/worker" npx wrangler dev --local --ip 127.0.0.1 --port "$WORKER_PORT" \
    --persist-to "$state_dir" --show-interactive-dev-session=false \
    --var "PUBLIC_URL:$WORKER_URL" \
    --var "OPS_TOKEN:$OPS_TOKEN" \
    --var "LEASE_SECONDS:$LEASE_SECONDS" \
    --var "ACCESS_TOKEN_TTL_SECONDS:$ACCESS_TOKEN_TTL_SECONDS" \
    --var "REFRESH_TOKEN_TTL_SECONDS:$REFRESH_TOKEN_TTL_SECONDS" \
    --var "AUTH_CODE_TTL_SECONDS:$AUTH_CODE_TTL_SECONDS" \
    --var "AUTH_REQUEST_TTL_SECONDS:$AUTH_REQUEST_TTL_SECONDS" \
    --var "GOOGLE_ISSUER:$GOOGLE_ISSUER" \
    --var "GOOGLE_CLIENT_ID:$GOOGLE_CLIENT_ID" \
    --var "GOOGLE_CLIENT_SECRET:$GOOGLE_CLIENT_SECRET" \
    --var "ADMIN_EMAIL:$ADMIN_EMAIL" \
    --var "TOKEN_ENC_KEY:$TOKEN_ENC_KEY" \
    --var "ALLOWED_ORIGINS:$ALLOWED_ORIGINS"

  local deadline=$((SECONDS + STACK_READY_TIMEOUT)) name
  until healthy "$WORKER_URL" && healthy "$MOCKS_URL"; do
    for name in worker mocks; do
      kill -0 "$(<"$pids_dir/$name.pid")" 2>/dev/null || fail "the $name process exited, see .stack/logs/$name.log"
    done
    ((SECONDS < deadline)) || fail "not ready within $STACK_READY_TIMEOUT seconds"
    sleep 1
  done
  echo "stack: ready $WORKER_URL"
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  *) echo "usage: $0 <up|down>" >&2; exit 2 ;;
esac
