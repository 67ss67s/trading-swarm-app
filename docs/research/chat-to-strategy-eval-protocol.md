# Matrix study / IR judge 离线评测协议（2026-09-25 外部评审）

范围：G1 安慰剂、G4 一致性/盲性、G5 记账故障；G3 只提供预注册采集协议与已录账户数据分析。本轮不调用 Jev/DeepSeek、不取真实交易所行情、不跑完整 G1、不读运行中 demo 数据目录。D 的 matrix 服务由另一实现者维护，评测通过依赖注入使用它。CI 通过表示实现流程符合断言，不能称为发现盈利优势或达到名义假阳率。

## 共用约束

- 运行前冻结 manifest、资产池、精确周期、两臂、问题和标签顺序、模型/连接版本、解析器、阈值/边距、持有期、成本、排序、生成器、预算与停止规则。hash 覆盖这些可影响选择的配置。金额十进制字符串，时间戳 unix 毫秒。
- 试验必须登记 attempt_count（所有实际评估，包括失败/重试）和 trial_count（所有可影响选择的独特变体）；effective_trials 只作敏感性。模型请求另记实际调用、最大费用预留、实际费用/unknown，不用决策条数充当付费次数。
- 搜索只持有训练/选择开发视图。最终候选和协议一次封存，留出按研究谱系与数据区间原子 claim，一次释放所有 finalist 并校正，不靠换 job 或重启重新选择。研究过的日期只能称历史回放；合成独立留出可标 unseen_holdout。
- train/selection 的累计收益按边界净值盯市；逐交易统计只含段内入场且已在段内退出的成熟交易。跨段完整回报不能倒灌前段。purge 覆盖执行器实际最大持仓 + 挂单等待 + 下根执行；显式 order.max_holding_bars 覆盖 time_stop。无界持仓拒绝，不能套固定24根。现有旧 batch 交易级费用/期望值对跨段交易作删失，不是逐成交分摊；MTM 净值保留这部分收益与成本。
- 所有模型异常按 skip 保留在分母；unknown 响应保留预算且不重发。采集错误不能通过删除候选改善成绩。资金和账户约束相同，模型运营成本计入账户日净收益。
- 首版只开放15m/4h/1d；3m/5m仍运行 blocker。无 judge IR v1 JSON/哈希不补字段；v2必须 order+judge。

## G1：全流程安慰剂

入口：

```sh
# 小样本 CI：默认2个N1、2个N2、1个正对照；严禁解读成FWER通过
node scripts/research-study-eval/run.mjs --gate g1 --profile ci --network deny
# 正式离线命令：本轮不运行
node scripts/research-study-eval/run.mjs --gate g1 --profile release --null-replicates 1000 --positive-replicates 100 --provider stub --network deny --output /tmp/g1-release.json
```

`matrix-adapter.ts` 每次新建内存库，调用生产 MatrixStudyService 的 create→搜索/迭代→封存→自动 finalize，而非给旧冠军换一组收益。loader 只返回合成历史片段，judge 是显式注入的零费用桩；不使用默认在线 loader/client。若服务失败、没有实际评估或存在未释放 finalist，则命令抛错，不能当成零误放。返回 attempt/trial/finalist/judge_calls；调度报告 study_runs。

release 冻结范围：3资产（BTC/ETH/SOL标签，仅合成数据）、15m/4h/1d、首版有限持仓且执行口径完整的 pullback/mean_reversion 两族、spot long、code/code_judge 两臂、全部默认参数；top_k=3、3代、每代4个变体、patience=2，纯 diagnosis/neighborhood/swap，不启用模型生成器。每个 study 最多300变体、20000次桩调用、美元0、墙钟4小时；purge218根，经 assertPurge 校验初始manifest，runPool 在每个迭代变体执行前再次检查开发视图的实际空档。生成3650天细网格，前301天留预热，三段比例沿 matrix 默认60/20/20，日线段扣除purge仍需满足样本门槛。此固定池不测试推荐器 G2，也不覆盖永续/carry 或未纳入族；新增搜索能力需重跑新协议。

CI 冻结为1资产、15m、相同两族/两臂、1代×1个候选、45天细数据（前4天预热）。不放宽成本、统计或样本门槛，允许 no_candidate；另由统计单测验证临界值、由G4验证执行/候选、由D的服务测试覆盖一次留出释放。CI并非缩小样本后冒充正式研究功效。

两组独立路径：

1. **N1**：15m多资产相关高斯冲击，相关系数0.65；条件波动只依赖过去，log-return 含 −σ²/2 修正，使零成本价格为鞅。同一细路径聚合15m/4h/1d，合法OHLC，不保留旧high/low。资金费为0。
2. **N2**：只接 DevelopmentPanel，拒绝包含 development_to_ms 之后数据；所有资产同步96根时间块重抽，逐细时点再乘独立等概率的共同正负号，幅度限±0.25以保证正价格，保留厚尾/波动聚集/横截面共振。默认来源是固定种子的合成厚尾开发 fixture，**不声称已经用真实市场校准**；替换真实开发数据后必须冻结来源哈希并重跑。

四类桩：确定性趋势一致、按状态哈希的随机、全部skip、阈值附近漂移。每个零假设 replicate 对四类桩各跑一次完整 study，任一 study 至少释放一个 finalist 才记一次误放。这是四桩的保守联合事件：1000×2 个独立路径事件，对应8000次 study 执行，不能把8000当独立二项样本；正对照100个路径各跑3桩（去掉全skip），另300次执行。报告必须同时显示事件数和实际study_runs。桩结果不证明真实 Jev/DeepSeek 的统计性质。

每组分别计算精确 Clopper–Pearson 单侧97.5%上界，两组都≤0.05；n=1000时每组误放≤36，37即失败。产品内层释放水平沿 matrix alpha=0.025。正对照采用有明显周期可预测收益的路径，100次至少80次检出，防止全拒系统蒙混通过；若当前策略族检测不了正对照，应报告 failed 并在新的开发协议中改设计，禁止正式运行后改种子/门槛补考。CI一律 `insufficient_evidence`。完整评测的运行时间未测定，应先做独立性能pilot；不承诺15分钟，也不运行付费版本。

## G4：确定性层和盲性层

```sh
node scripts/research-study-eval/run.mjs --gate g4 --profile release --network deny
```

每个方向10400个bar、至少1000候选；同步orders意图与在线 generateRunCandidate（同真实viewBars窗口）产生的ID/方向/价位，逐候选复用已录首次响应，state hash、归一答案、动作完全相同。重复运行不增加provider调用。测试含无judge同步/异步旧行为、null限价、缺bar/晚到/预热、purge冲突、跨段成熟标签、auto/agent/confirm/signal_only 的skip阻开单/发布；现有orders与strategy-run回归覆盖挂单过期、持仓冲突、退出、资金费等执行规则。

盲性测试修改 as_of 后OHLC，候选和state/request哈希不得改变；未知未来字段、合法字段中的任意未来文本都拒绝。允许差异数0。这里不宣称真实成交价/延迟与bar撮合一致。

真实概率漂移另列待授权验证：在开发集估计并冻结联合margin，独立重复样本报告原始阈值翻转与保守行动翻转，行动翻转率单侧95%上界≤1%。latest别名不是不可变服务版本。本轮只用边界漂移桩，不调用真实模型，不给δ=0.02之类未经校准的产品承诺。

## G5：预算、取消和恢复

```sh
node scripts/research-study-eval/run.mjs --gate g5 --network deny
```

100条参数化故障轨迹（每类20条）：429、超时、畸形回答、缺收费信息、响应落库前崩溃；另测两SQLite连接并发20次请求只预留5次、十进制边界、取消/恢复、响应已存但决策未存崩溃、实际超预留、模型不匹配和供应商request ID对账。assert：无重复付费、成功首次响应不可改、调用数和预留不归零、unknown不退钱、不绕过额度。

BEGIN IMMEDIATE原子预留和claim，响应/结算同事务。落库失败抛给调度，不能伪装模型失败；恢复只用原响应。确认旧worker已死后 interruptBudget 将遗留pending改unknown并保留预留；无租约证明不得调用。取消是停止新请求，不是抹去已发请求的账。预留前取消不钉最终决策；收到响应后取消仍保存原响应和实际费用，恢复使用原响应完成决策，避免永久卡在cancelled。claim成功后、decide前取消仍保守记unknown、保留预留且不重发，这与预留前取消不同。供应商实际费用超过预声明上界时记录真实超额并封锁新调用，这能保证内部预留不超预算，不能保证供应商违背价格上界后账户从未超支。

## G3：真实采集前的冻结协议（本轮禁止采集）

```sh
# 只打印协议与费用，不联网
node scripts/research-study-eval/run.mjs --gate g3 --network deny
# 对已录制且包含账户日收益的文件离线分析
node scripts/research-study-eval/run.mjs --gate g3 --network deny --manifest /tmp/g3-recorded.json
```

最多3个开发阶段已冻结finalist。共6000个候选机会、至少365天、Jev跟随至少100次、至少20个有效时间块。六臂为code、cheap_trend（1h+4h均线同向）、jev、deepseek、cash、matched_random（参与率按开发段分资产/时间/regime冻结，不能拿留出标签调参与率）。所有臂候选机会、资本、风控/仓位限制、成交/滑点/资金费一致，失败skip不删记录；代码基线也须受实际资金/冲突约束。

主要统计单位是同一UTC日账户净收益差，包含模型实际成本；块长≥最大持有天数，并在开发段检查更长依赖。每次同步时间块bootstrap10000次；primary为Jev-code和Jev-cheap_trend，跨finalist/两个声明使用同时Bonferroni CI（比原建议Holm保守）；下界须超过冻结min_effect，Jev自身净收益正，回撤≤冻结上限且上限不得超过35%。DeepSeek只作探索性对照，不据此改选冠军。全skip不会被解释成赚钱策略。

录制JSON顶层 `{finalists:[...]}`，每项符合 `G3RecordedFinalist`：id、candidate_count、follow_count、days（UTC日首unix毫秒，连续）、daily_returns（六臂等长日收益数组）、block_days/max_holding_days、min_effect、max_drawdown、costs_included:true、jev_cost_usd/deepseek_cost_usd（十进制字符串）。脚本严格校验网格、臂、风险/样本门槛并输出 passed/failed/insufficient_evidence；不能从日收益文件独立证明采集者确实使用了同一候选与资本，必须一并保留候选/订单/响应账本及manifest审计哈希。

真实采集必须先由Jacky批准连接和预算；需要owner提供 `--provider-adapter`（导出 `collect({manifest,connection_id,max_calls,max_usd,protocol})`）、冻结manifest与 `--approved-by Jacky --connection-id ... --max-calls ... --max-usd ... --network allow`。标志不是实际批准的替代。collector必须用本轮judgeCandidate+AtomicCallBudget、不可变provider与maxRetries:0；当前脚本只定义适配边界，不实现/调用凭证client，也不自动重试。§9.52最小接口缺supplier raw/request ID时必须在报告中声明。预算强制执行由该采集适配器内的共享judge账本承担，不相信CLI参数能限制任意外部模块。

规划费用（沿用任务评审单价，非本轮现价查询）：Jev6000次×$0.000027=$0.162；DeepSeek6000次、每次约1000输入+200输出，约$1.62；合计12000次、$1.782，10%预备额上限$1.9602。预备额不能用于对同一状态择优重抽；unknown收费仍占预留。若最多3个finalist的状态不能共享，各需要6000机会，则最多36000次、$5.346（含10%为$5.8806）。以最终冻结请求去重数量和provider费用上界为准，不承诺固定账单。

## 运行隔离

默认 `--network deny` 在加载adapter前封fetch/http/https/net/tls/udp及子进程网络旁路；G4/G5 worker另加载相同setup。这是合作代码的误用防护，不是对恶意插件的OS沙箱。所有库为内存/临时目录；输出禁止运行中demo路径。自定义adapter必须同样遵守不访问真实交易所/付费模型/用户状态目录的约束。离线命令不得用 `npm install`，不得启动端口18811/5191。
