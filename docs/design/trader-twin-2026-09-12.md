# 交易员对照(Trader Twin):让 agent 在同资产上做出接近舒琴 / 三马 / 赵哥的判断

日期 2026-09-12。目标不是"抄单",是让 agent 的判断在**同一资产、同一时刻**尽量与三位交易员一致,并且能量化"像不像、谁对了、为什么不像",再用这个差距反过来改 agent。前置:内部评审记录(astra 正在做的语料拆解与 alpha 复刻)。

## 0. 口径先说死

- **对照对象**是"判断",不是"成交"。一条判断 = (symbol, 时刻, stance 多/空/不动, 入场位或区间, 止损, 止盈梯, 仓位意图)。交易员一侧来自 bridge 的 `structured_signals`(action_type=open/add 才算新判断;reduce/close 是管理,另算);agent 一侧来自判断账本(`judgment-ledger.ts`,三腿:代码 / 模型 / 议会)。
- **同一时刻**按 4h 簇对齐(账本已有 `cluster_id = symbol:floor(t/4h)`),簇内取 agent 最近一次判断;没判断算"agent 没看"(单独统计,不能算不一致)。
- **一致**分三档,分开算,不合成一个分:方向一致(stance 相同)、点位一致(入场位差 ≤ 0.5 ATR(15m)且止损同侧)、时机一致(agent 判断早于或不晚于信号 30 分钟)。
- **谁对了**用账本已有的 `realized`(同一结算口径:各自 SL/TP 几何,固定 24h 兜底),不一致的对里分"交易员对 / agent 对 / 都错 / 都对"。
- **不许偷看**:agent 判断的时间戳必须早于该信号进入 trading-swarm 的时间;交易员信号只进账本作对照与事后训练材料,**永远不作为实时判断输入**,否则一致率是自我实现。

## 1. 数据流

```
bridge structured_signals ──(订阅拉取,幂等 by signal_id)──▶ judgment_ledger(source='trader', trader='舒琴'...)
                                                                    │
heartbeat / shadow-scheduler 采样 agent 判断 ──▶ judgment_ledger(source='online'|'replay')
                                                                    │
                                              pairing(cluster_id) ──▶ twin_pairs(视图,不建表)
                                                                    │
                                      agreement 报表 / 归因 / Lab twin score / 前端「对照」tab
```

- 拉取:`trader-feed.ts`,复用 console 侧对 bridge 的订阅协议(API key 已有),只读 open/add,写账本一行 `stance/entry/stop/tps/sizing_hint/raw_id`,`ingested_at` 单独存。
- 配对:纯函数 `pairJudgments(traderRows, agentRows)`,输出 pair + 三档一致标志 + 缺席标志;不落表,按需算(与归因报告同一思路 §1.5)。
- 回放版:历史 100 天的交易员信号,用三腿回放(`source='replay'`,点时冻结数据)在信号时刻**之前**的最近一根 K 线收盘重跑 agent 判断,得到批量配对——这是第一版数字的来源,不用等线上攒。

## 2. 拉近判断的三条杠杆(按可控性排序)

1. **代码腿:交易员派生 family**。astra 从语料提炼的规则(舒琴式 4h 摆动高低反向限价三档止盈、三马式日内极端位阶梯限价、赵哥式分批吸/异动减仓)注册为 `strategy-signals.ts` family,`origin: 'trader:舒琴'`。进议会候选池后,`code_consensus` 自然带上他们的 setup。晋升仍走 `PROMOTION_POLICY` 的净期望门,**一致率不是晋升条件**,只是诊断。
2. **模型腿:playbook 作为策略级提示上下文**。每个 trader family 附一份机器可读 playbook(setup、点位偏好、不做的条件、止损搬家规则)+ 一段"他怎么想"的原文摘录(带 id)。模型判断时对该 family 的问题变成"按这份 playbook,此刻会不会做、做在哪",输出走现有 `stance/entry/stop` 结构。证据规格(evidence spec)按 playbook 定制指标(前高前低、整数位、前日高低、VWAP、资金费),减少黑盒。
3. **校准腿:twin score 进 Lab**。每个 trader family 版本在 Lab 里除了净期望,再报"对同一交易员近 90 天信号的三档一致率 + 不一致时谁对"。一致率高但净期望负 = 复刻成功但那人本身没 alpha(也是有价值的结论);一致率低但净期望正 = 规则漂移,标记 `drift` 让人看。

## 3. 报表形状

`GET /api/judgment/twin?trader=舒琴&days=90` 返回:

- 总览:信号数、agent 到场率、方向 / 点位 / 时机一致率(各带 bootstrap CI)、不一致时四象限计数与 R 差。
- 分层:symbol × 多空 × regime(trend/range/high_vol,账本已有桶)× 时段。
- 明细:每对(信号 id、agent 判断 id、三档标志、各自 R、原文摘录 200 字)。
- 前端:判断账本页加「对照」tab,每人一张卡(一致率三条、四象限饼)+ 明细表可点开原文。

## 4. 分期与分工

- **A(进行中,astra high)**:语料拆解、零模型归因、2–4 条机械规则、离线回放与人肉基线。产物 `docs/research/trader-study-2026-09-12.md`。
- **B(opus)**:`trader-feed.ts` 拉取 + 账本 `source='trader'` + `pairJudgments` + 历史 100 天三腿回放配对 + `/api/judgment/twin`。零模型,可全量测试。第一份一致率报告在这一步出。
- **C(opus + sonnet)**:playbook 进 family 定义与模型提示;证据规格定制指标;Lab twin score;前端「对照」tab(契约写 `v3-ui-contract.md` §9.38)。
- **D(循环)**:每周看一次对照报告,差距最大的层(比如"舒琴的 SOL 空单 agent 全部 flat")反查是代码腿没这个 setup、还是模型腿被别的策略投票压掉、还是证据缺口弃权;修对应那一腿,再回放。

## 5. 不做什么

- 不把交易员信号喂给实时判断(见 §0);不自动跟单(那是 console 的事)。
- 不给一致率做晋升门;不因为"像"就放进 active。
- 不建新表:交易员信号进现有账本,配对是视图。
- 赵哥的代币化美股如果 fapi 没有连续 K 线,只做方向与时机对照,点位对照标"不可算"。

## 6. 验收

- B 完成时能回答:近 90 天三人每人多少条信号,agent 到场率,三档一致率及 CI,不一致时谁对。
- C 完成时:至少一个 trader family 进入议会候选池(backtest 态),Lab 报表里有 twin score,前端能看到对照卡。
- 任何一步的数字都能用 `npm run lab -- --study twin` 复跑。
