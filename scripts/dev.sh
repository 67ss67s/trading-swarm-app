#!/usr/bin/env bash
# Start Trading Swarm for local development: gateway (API) + web UI (Vite dev server).
#   ./scripts/dev.sh            build the gateway, then start both
#   ./scripts/dev.sh --no-build start without rebuilding the gateway
# Ctrl-C stops both. Configuration comes from the environment and, if present, from ./.env
# (see .env.example). State lives in ~/.trading-swarm/ (TG_DEMO_DB), never in the repository.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
  # The gateway imports OPENROUTER_API_KEY from this file once, into the model-connection vault
  # (~/.trading-swarm/.../model-keys.json, mode 600), and binds the Jev judgment role to it.
  export TG_MODEL_IMPORT_ENV="${TG_MODEL_IMPORT_ENV:-$REPO/.env}"
fi

export TG_EXCHANGE="${TG_EXCHANGE:-okx}"
export TG_DEMO_BACKEND="${TG_DEMO_BACKEND:-paper}"
export TG_DEMO_RUN_ON_START="${TG_DEMO_RUN_ON_START:-0}"
export TG_DEMO_PORT="${TG_DEMO_PORT:-18800}"
export TG_UI_PORT="${TG_UI_PORT:-5180}"
export TG_API_PORT="$TG_DEMO_PORT"
export NO_PROXY="${NO_PROXY:-localhost,127.0.0.1,::1}"

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

pids=()
cleanup() { for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done; wait 2>/dev/null || true; }
trap cleanup EXIT INT TERM

node packages/gateway/dist/demo/main.js &
pids+=($!)

for _ in $(seq 1 30); do
  curl -fsS --noproxy '*' --max-time 2 "http://127.0.0.1:$TG_DEMO_PORT/api/bots" >/dev/null 2>&1 && break
  sleep 1
done

npm run dev --workspace packages/webui -- --host 127.0.0.1 --port "$TG_UI_PORT" --strictPort &
pids+=($!)

echo ">> UI  http://127.0.0.1:$TG_UI_PORT   API http://127.0.0.1:$TG_DEMO_PORT   exchange=$TG_EXCHANGE backend=$TG_DEMO_BACKEND"
wait
