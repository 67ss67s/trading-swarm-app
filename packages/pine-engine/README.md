# @trading-swarm/pine-engine — trading-swarm 自己的 Pine 引擎

研究引擎的「Pine 脚本目录」用它跑原生 PineScript v5/v6:任何 Pine 指标先进目录、过准入门
(因果 / 确定性 / 有数值输出 / 实测预热,合成 + 真实行情两套数据都要过),通过后才能被
`pine_series` 原语引用进策略 IR。运行时是 [PineTS](https://github.com/LuxAlgo/PineTS)。

## 启动方式:零额外步骤

仓库根目录 `npm install` 时它作为 workspace 包一起装好(pinets 被提升到根 `node_modules`)。
**不需要手动起**——网关(`packages/gateway` 的 `demo/main.ts`)启动时由托管器
`src/demo/research/pine/engine-host.ts` 自动拉起子进程:

- 端口:默认 `listen 0`,系统分配临时端口,子进程就绪后经 IPC(另有 stdout 一行
  `{"event":"ready","port":…}` 兜底)回报;`TG_PINE_PORT=…` 可显式指定。没有固定端口。
- 崩溃按指数退避自动重启,连续失败 5 次标记 `down`;IPC 心跳断超过「单次执行超时 + 15s」
  判定脚本卡死事件循环,SIGKILL 后重启。
- 网关退出(SIGTERM / SIGINT / exit)时一并收掉;网关被 SIGKILL 时子进程发现 IPC 断开自行退出。
- `TG_PINE_ENGINE=0` 关掉(status=disabled)。引擎起不来不影响网关其它功能,`pine_series`
  会明确报 `PROVIDER_ERROR:pine_engine_unavailable`,绝不悄悄返回「没有信号」。
- 状态:`GET /api/research/pine/health` →
  `{status: up|starting|down|disabled, pid, port, restarts, last_error, engine:'pinets', version, scripts, admitted}`。

调试时可以单独起一个(同样的沙箱参数,临时端口):

```bash
npm start -w @trading-swarm/pine-engine      # 打印 {"event":"ready","port":…}
npm run smoke -w @trading-swarm/pine-engine  # 自己起一个跑冒烟;PINE_ENGINE_URL=… 则打现成的
```

## 沙箱

两层,纵深防御:

1. **Node 权限模型**(内核调用前拦截):托管器用 `node --permission` 启动,只
   `--allow-fs-read` 本包目录与依赖树(pinets / acorn / acorn-walk / astring)的真实路径——
   不放行仓库根或整个 `node_modules`;不给 fs 写、`child_process`、`worker`、原生插件,
   `process.binding` 也被拒。子进程 env 只带 `PINE_*` 几个变量,拿不到网关的密钥。
2. **进程内加固**(`sandbox.js`):Node 24 的权限模型不管网络(`--allow-net` 是 Node 25 才有),
   而 PineTS 执行的脚本摸得到 `process` 全局——实测 `process.mainModule.require('fs')`
   能走到 fs 那一步(被第 1 层拦下)。所以加载完自己要用的模块后:用 `module.registerHooks`
   拦 require / `import()` 网络、进程、文件、调试类内置模块;封掉 `process.getBuiltinModule`、
   `process.mainModule`、再注册 hooks 的入口;删掉全局 `fetch` / `WebSocket` / `EventSource`;
   `process.kill` 只许打自己。

残余风险:第 2 层是进程内的,不是内核级的;真要防一个专门针对 V8 / Node 内部的攻击者,
需要 Node 25 的 `--allow-net` 或容器 / seccomp。脚本来源(用户贴 / agent 生成 / 社区)都要过准入,
社区脚本必须带 license。

另有限额:单次执行超时 `PINE_RUN_TIMEOUT_MS`(默认 60s,脚本在异步环节卡住时生效;同步死循环由
托管器心跳看门狗兜底,PineTS 自身对 `while` 也有迭代上限)、单次响应上限 `PINE_MAX_OUTPUT_BYTES`
(默认 16MB)、请求体上限 `PINE_MAX_INPUT_BYTES`(默认 30MB)、每次最多 24 条 plot、每类绘图对象 250 个。

## 接口

```
GET  /health → { ok, engine: "pinets", version, port, pid }
POST /run    { source, candles: [{ time, open, high, low, close, volume }], symbol?, interval? }
             → { ok, bars, series: { plot名: [num|null] }, styles, drawings, warnings }
```

`candles[].time` 是**秒**级 open time;返回的每条 series 与 candles 一一对齐,预热段是 `null`。
脚本抛错(包括被沙箱拒绝)时返回 200 + `{ ok:false, error, detail }`。

## 许可与 AGPL 边界

本包依赖 PineTS(LuxAlgo,**AGPL-3.0-only**,商业授权联系 LuxAlgo),本包自身同样以
AGPL-3.0 发布,许可全文见 `LICENSE`。

**AGPL 边界就是进程边界**:PineTS 只存在于这个独立子进程里;gateway 只 resolve 本包的**路径**
并以独立进程启动它,通过本地 HTTP 通信,**绝不 import PineTS 或本包代码**。改 gateway 时守住这条:
不要在 `packages/gateway` 里 `import 'pinets'` 或 `require('@trading-swarm/pine-engine')`。

目录里 `source='community'` 的脚本必须自带 `license` 字段,准入报告会连同许可一起留痕。
