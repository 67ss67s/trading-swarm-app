# 研究工作台后端

研究域不接交易写入口。`engine.ts` / `ledger.ts` 保留单资产现货下一 open、8 位定点记账与 recorded replay。`portfolio.ts` 在同一时钟下共享现金，按跳空保护、主动退出、按已冻结排名入场、intrabar 保护分相执行；持仓期间缺根终止为不完整实验，不填价。

`market-dataset.ts` 共用现有现货公开行情导入；`universe.ts` 构建不可变成员快照与收盘时间交集；`screen.ts` 截断到 as_of 后做因子与趋势筛选；`factor.ts` 提供单因子 OLS、滚动回归和统一风险指标。`calendar.ts` 仅提供年化／session gap 抽象，美股数据源和非连续交易日历执行未实现。

`strategy.ts` 实现 IR 编译、六项检查、旧 policy 无损映射及两类执行适配。`primitives/` 按类别登记 20 个原语；参数 schema 全来自 contracts；所有 compute 截断到当前 i。共享 `trend-state.ts` 给 screen、IR 执行和 B 上下文使用。多周期原语（`primitives/htf.ts` / `htf-ma.ts`，2026-09-23 夜）：`htf_ma_state`（最近一根已收盘高周期 K 线在其 SMA/EMA 之上/之下，regime 与 short_regime 共用）与 `macd_divergence{htf,direction}` / `macd_divergence_exit{htf}` 从 `ctx.series`（整段已收盘 K 线）按 htf 分桶只用完整桶计算，决策视图预热记 0，窗口前历史走 `history_bars` → `irHistoryBars` 由全窗口回测多借数据（上限 6 万根）。新模板使用 chandelier_trail / trend_break；固定目标与时间只作为 optional。compile 只接受目录内参数，不执行生成代码。

`diagnostics.ts` 从同一净权益和退出批次生成诊断；`attribution.ts` 按父子 IR 七段分别替换后跑 A 臂，零模型，结果按 manifest 哈希落库。`agent.ts` 的单次模型超时默认 120 秒、最多 300 秒、受剩余总时限约束；单次异常记录 model_error，连续五次失败才停止，取消与总预算不重试。

数据库由 gateway migrations 管理，第二轮表为 `0026_research_universes.sql`、`0027_research_attribution.sql`。本任务不修改正在运行的数据库，不重启 dev 进程；按正常启动/部署流程应用迁移。

```sh
npm run generate:check -w @trade-gate/contracts
npm run build -w @trade-gate/gateway
npm exec -w @trade-gate/gateway -- vitest run test/demo/research --maxWorkers 4
npm exec -w @trade-gate/gateway -- vitest run --maxWorkers 4
```

沙箱禁止 listen 时的旧 socket 文件清单与实际计数见 `docs/research/round2-report.md`。research HTTP 集成测试不监听端口、不调用真实行情或模型；测试行情来自 synthetic fixture。NumPy 对拍输入与生成脚本在 `test/demo/research/data/`，生产运行不依赖 Python/NumPy。旧固定持有期候选标签不套用到无固定持有期的 IR/多资产结果；此类结果使用净权益比较、diagnostics 与 A 臂消融。

## 第三轮

新 run 默认 unit_notional 并冻结 order_gate；旧 manifest 缺字段继续按旧口径重放。B/C 的规则书只取冻结策略与其原语证据，不复用实盘上下文。原语目录增加确认 pivot、BOS/CHoCH、order block、高周期结构与结构目标；compile 必须提供初始止损和独立目标来源。precheck 是零模型检查，不是策略效果保证。

chat 将 run 与行情导出到 ~/.trade-gate-okx/research-sandbox/<chat_id>/，使用受限 Node ESM 执行脚本并注册 chart/table/markdown；任务 SSE 可通过 GET chats 补齐。Node 24 使用正式 --permission 参数，旧 --experimental-permission 在此版本不可用。正常部署前需复核 OS 级内存隔离：heap/分配配额与 RSS watchdog 不是容器级硬限，受限环境无法运行 ps 时 stderr 明示。

CCXT 仅接公开现货行情，无交易/账户方法；完整市场池使用 filter，shortlist 在段起点冻结给 B/C，A 全量。CCXT 需要联网安装 gateway 依赖；Python 对账只在 /tmp venv，详见 scripts/research-crosscheck/README.md 与 docs/research/engine-crosscheck.md。

```sh
npm run generate:check -w @trade-gate/contracts
npm run build -w @trade-gate/gateway
npm exec -w @trade-gate/gateway -- vitest run test/demo/research --maxWorkers 4
```
