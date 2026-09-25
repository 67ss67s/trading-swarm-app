#!/usr/bin/env bash
# 早期启动脚本:gateway(18800)+ webui dev(5180),Ctrl-C 一起收摊。日常开发用 scripts/dev.sh;
# 下面的 Binance 通道需要 TG_EXCHANGE=binance(默认 okx)。
# 后端:有 ~/.trading-swarm/secrets/apikey-demo.json 就走 Binance Demo Trading(Rust 执行器),否则纸面模拟;
#       TG_DEMO_BACKEND=cli 走 Agent OS 通道(官方 binance-cli,profile tswarm-demo,BINANCE_API_ENV=demo)。
# 大脑:TG_DEMO_BRAIN=pi(默认,GLM 经 pi)| claude | codex | stub
set -euo pipefail
cd "$(dirname "$0")"
export TG_DEMO_TF="${TG_DEMO_TF:-15m}"
export TG_DEMO_RUN_ON_START="${TG_DEMO_RUN_ON_START:-1}"
# 币安 Agentic MCP 的 OAuth 客户端身份(CIMD)默认不设:币安目前按 client_id 白名单放行 agent(错误 3346001),
# 网关自己的 client_id 不在名单内;执行走 agent_mcp(由本机 agent CLI 持有 OAuth 会话)。
# 获准后设置 TG_BINANCE_OAUTH_CLIENT_ID(并配合 TG_BINANCE_OAUTH_FORCE=1)即可改走网关自己的授权页。
if [ -f "$HOME/.trading-swarm/secrets/apikey-demo.json" ] && [ ! -x target/exec-core/release/tswarm-demo-exec ]; then
  echo ">> building tswarm-demo-exec (release)"; CARGO_TARGET_DIR=target/exec-core cargo build -p exec-core --bin tswarm-demo-exec --release
fi
npm run build --workspace packages/gateway >/dev/null
node packages/gateway/dist/demo/main.js &
GW=$!
npm run dev --workspace packages/webui -- --host 127.0.0.1 --port 5180 &
UI=$!
trap 'kill $GW $UI 2>/dev/null; wait 2>/dev/null; exit 0' INT TERM
echo ">> 界面 http://127.0.0.1:5180   API http://127.0.0.1:18800/api/overview"
wait
