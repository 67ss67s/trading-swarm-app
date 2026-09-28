#!/usr/bin/env bash
# Start Trading Swarm for local development: gateway (API) + web UI (Vite dev server).
#   ./scripts/dev.sh            build the gateway, then start both
#   ./scripts/dev.sh --no-build start without rebuilding the gateway
# Ctrl-C stops both. Configuration comes from the environment and, if present, from ./.env
# (see .env.example). Nothing is required: without an OKX profile orders go to the built-in paper
# simulator, and without a model connection the UI, backtests and paper execution still work.
# State lives in ~/.trade-gate/demo/ (override with TG_DEMO_HOME or TG_DEMO_DB), never in the repository.
# On the first start (no state database yet) the demo data in scripts/demo-seed/ is loaded; TG_DEMO_SEED=0 skips it.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
  # The gateway imports OPENROUTER_API_KEY from this file once, into the model-connection vault
  # (<state dir>/secrets/model-keys.json, mode 600), and binds the Jev judgment role to it.
  export TG_MODEL_IMPORT_ENV="${TG_MODEL_IMPORT_ENV:-$REPO/.env}"
fi

export TG_EXCHANGE="${TG_EXCHANGE:-okx}"
export TG_DEMO_BACKEND="${TG_DEMO_BACKEND:-paper}"
export TG_DEMO_RUN_ON_START="${TG_DEMO_RUN_ON_START:-0}"
export TG_PUBLIC_LANG="${TG_PUBLIC_LANG:-en}"
export TG_DEMO_PORT="${TG_DEMO_PORT:-18800}"
export TG_UI_PORT="${TG_UI_PORT:-5180}"
export TG_API_PORT="$TG_DEMO_PORT"
TG_DEMO_HOME="${TG_DEMO_HOME:-$HOME/.trade-gate/demo}"
export TG_DEMO_DB="${TG_DEMO_DB:-$TG_DEMO_HOME/state.sqlite}"
export NO_PROXY="${NO_PROXY:-localhost,127.0.0.1,::1}"
export no_proxy="$NO_PROXY"
SEED_IMPORT="$REPO/scripts/demo-seed/import.mjs"
SEED_FILE="$REPO/scripts/demo-seed/seed.json"

command -v node >/dev/null || { echo "node not found (Node 24+ required)" >&2; exit 1; }
node_major=$(node -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 24 ] || { echo "Node 24+ required (found $(node -v))" >&2; exit 1; }
[ -d node_modules ] || { echo "run 'npm install' first" >&2; exit 1; }

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
for p in "$TG_DEMO_PORT" "$TG_UI_PORT"; do
  if port_busy "$p"; then echo "port $p is already in use; set TG_DEMO_PORT / TG_UI_PORT" >&2; exit 1; fi
done

if [ "${1:-}" != "--no-build" ]; then
  echo ">> building gateway"
  npm run build --workspace packages/gateway >/dev/null
fi
mkdir -p "$(dirname "$TG_DEMO_DB")"

pids=()
cleanup() { for pid in ${pids[@]+"${pids[@]}"}; do kill "$pid" 2>/dev/null || true; done; wait 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# Start the gateway in the background, remember its pid in GW_PID and wait until the API answers.
start_gateway() {
  node packages/gateway/dist/demo/main.js &
  GW_PID=$!
  pids+=("$GW_PID")
  for _ in $(seq 1 60); do
    curl -fsS --noproxy '*' --max-time 2 "http://127.0.0.1:$TG_DEMO_PORT/api/bots" >/dev/null 2>&1 && return 0
    kill -0 "$GW_PID" 2>/dev/null || { echo "gateway exited during start-up" >&2; exit 1; }
    sleep 1
  done
  echo "warning: gateway did not answer on :$TG_DEMO_PORT within 60s" >&2
}

stop_gateway() {
  kill -TERM "$GW_PID" 2>/dev/null || true
  wait "$GW_PID" 2>/dev/null || true
  pids=()
}

# First start: let the gateway create the database (migrations and lazily created tables), stop it,
# load the demo data, then start it again for real. The importer is idempotent.
if [ ! -f "$TG_DEMO_DB" ] && [ "${TG_DEMO_SEED:-1}" != "0" ]; then
  if [ -f "$SEED_IMPORT" ] && [ -f "$SEED_FILE" ]; then
    echo ">> first start: creating the state database and loading demo data"
    start_gateway
    stop_gateway
    node "$SEED_IMPORT" --db "$TG_DEMO_DB" --seed "$SEED_FILE" || echo "warning: demo data import failed, continuing with an empty database" >&2
  else
    echo ">> demo data not found (scripts/demo-seed/), starting with an empty database"
  fi
fi

start_gateway

npm run dev --workspace packages/webui -- --host 127.0.0.1 --port "$TG_UI_PORT" --strictPort &
pids+=($!)

echo ">> UI  http://127.0.0.1:$TG_UI_PORT   API http://127.0.0.1:$TG_DEMO_PORT   exchange=$TG_EXCHANGE backend=$TG_DEMO_BACKEND   state=$TG_DEMO_DB"
wait
