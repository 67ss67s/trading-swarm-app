# @trade-gate/eval-b

这是 trade-gate 判断链的实现 B 评测 harness。它对每个历史 case 调用线上同一份 `demo.buildContext`、`validateJudgment`、`evaluateGates` 与 review reducer；`run` 只读本地 case，行情网络访问只发生在 `gen`。

## 使用

在仓库根目录执行：

```sh
npm run build --workspace packages/eval-b
npm run eval --workspace packages/eval-b -- gen --symbols BTCUSDT,ETHUSDT --tf 15m --from 2026-08-01 --to 2026-09-01 --n 12 --seed 7 --out cases/v1
npm run eval --workspace packages/eval-b -- run --cases cases/v1 --brain stub --out runs/stub-v1
npm run eval --workspace packages/eval-b -- report runs/stub-v1
npm run eval --workspace packages/eval-b -- run --cases cases/v1 --brain pi --tags scan,base --limit 2 --out runs/pi-v1
npm run eval --workspace packages/eval-b -- report runs/pi-v1
npm run eval --workspace packages/eval-b -- compare runs/stub-v1 runs/pi-v1
npm test --workspace packages/eval-b
```

`--tags` 是 AND 过滤，支持 `!tag` 排除；并发只能设为一或二。`--resume` 只复用 case hash 与 brain 名都一致的 episode。模型缓存键为 `sha256(context_hash + model + prompt_version)`；修复调用先从原 context 与修复提示生成独立 context hash。`data/` 保存 Binance 原始响应，`cache/` 保存模型原始响应，二者都不会被 `run` 当作行情源。

## 指标口径

`report.json` 与 `report.md` 覆盖 schema 首次/修复后有效率、证据引用、幻觉数字、未来泄漏、过期证据交易、越权动作、闸拒率、动作分布、镜像方向对称、线程连续性、结果 R、错过行情、置信度校准、成本与延迟、触发/模式/变体覆盖。未来泄漏同时检查 visible 的 `close_time` 边界，以及隐藏未来价格或时间是否出现在实际模型上下文。结果模拟采用保守 OHLC 规则：下一根开盘成交；限价首次触及时成交；同根同时碰止损和止盈时止损优先。

晋升必须通过全部硬不变量、两个 schema 门和镜像门。虽然表内闸拒率报告阈值是三成，晋升硬门要求没有任何 PROPOSE 被代码闸拒。

成本是可比较估算，不是账单：`pi` 按输入每百万 token 1 美元、输出 3 美元，`claude` 按 3/15 美元，stub 为零。缓存命中保留首次响应记录的 token 与 latency，因此相同 cases 与缓存生成的 episode/report 可逐字节复现。

## 已知局限

- K 线只有 OHLC，无法判断同一根内的真实路径；模拟有意采用“止损优先”的保守口径。
- 24 小时 ticker、OI、资金费率和账户是确定性合成数据，不代表历史交易所快照；K 线来自公共 fapi。
- 线上 ContextBuilder 当前把 structure evidence 显式标成 fresh；`stale_all` 对抗变体在调用线上 builder 后只对已登记的 market/structure 项统一加 STALE，不复制 builder 逻辑。
- thesis continuity 以新增 evidence ref 编号判断“新证据”，不会做自然语言因果判定。

## NOT_IMPLEMENTED

规格中的指标、CLI、缓存、修复、镜像、review chain 与结果模拟均已实现。唯一未实现的是查询供应商真实账单/动态价格；报告使用上面的固定比较费率，不把它冒充实际费用。

## 持仓周期真实模型 A/B（有界研究）

`node packages/eval-b/scripts/holding-ab.mjs prepare` 固定 2026-08-08 至 2026-09-07 的历史窗口并冻结输入；`run baseline` / `run candidate` 分别调用 `pi:zai/glm-5.3`，每臂最多 56 次，不启用工具。原始系统/用户提示、模型文字、独立重复和缓存键全部保留。账户为研究合成，行情来自只读公开缓存；程序没有交易后端调用。

基线编译树默认 `/private/tmp/trade-gate-real-ab-baseline`，候选冻结树默认 `/private/tmp/trade-gate-real-ab-candidate`。可用 `TG_HOLDING_AB_BASELINE` / `TG_HOLDING_AB_CANDIDATE` / `TG_HOLDING_AB_OUT` / `TG_HOLDING_KLINE_CACHE` 覆盖。启动前必须准备独立编译树及其只读依赖，禁止把两臂指向同一会被修改的编译目录。已生成 manifest 后不要再次 prepare 改写选样。

`revalidate` 只用保存的模型原文对当前候选编译树重算 context/动作闸，不发模型请求；`report` 输出成本后收益与晋升门。`scan-rr` 是之后新增的、独立最多 8 次真实扫描检查，存入 `scan-rr-refresh/`，不覆盖原 78 次 A/B；`revalidate-rr` 把新版提示的差异另存为 `*-after-rr.json`。RR 追加提示只修改 scan，原 review 缓存仍需逐字节核验。

费用假设：每次成交手续费 5 bps、不利滑点 2 bps；资金费按每 8 小时 1 bp 的成本在两个方向都计提，不凭空生成空头资金费收益。EXIT / REDUCE 在判断后的下一根开盘执行，REDUCE 减半且余仓继续回放；同根止损和止盈同时触及时止损优先，跳空可差于 -1R。这是预设历史持仓的退出诊断，不是完整入场系统回测：预设入场价使用开仓前收盘代理，ticker/账户为合成上下文，模型两次重复不是独立市场样本。

盈利门在调用前固定：至少 20 个独立 holdout 持仓场景、两次重复、净期望大于零、相对旧版净改善、尾部损失无明显恶化，加 schema/未来泄漏/硬止损不变量。当前有界数据只有 6 个独立 holdout，因此即使收益为正也不能晋升；应报告 HOLD，不为过门修改样本或阈值。真实模型若没输出 PROPOSE / REDUCE，也不能把对应分支说成已经实测覆盖。
