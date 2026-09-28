# Judgment Replay:不带固定策略、由 agent 决定「做不做」的跨资产回测(2026-09-23)

> 起因:Jacky「不带策略去跑,我也想要有一个较好的运行回测,并且跨资产都行得通,可能要 agent 判断的回测」。
> 代码:`packages/gateway/src/demo/research/judgment-replay/`,命令行 `packages/gateway/scripts/research-judgment/judgment-replay.ts`,
> 测试 `packages/gateway/test/demo/research/judgment-replay/`(17 条)。

## 0. 当前状态

整套东西已经在真实冻结数据上用桩模型跑通:现货只做多 986 个事件、永续多空 2035 个事件,冻结、跑臂、零模型重放(1866 条,零差异)、报告全部走通。**真模型还没有调用过。** 主线程转达了授权,但真跑命令被工具层的权限闸拦下了(付费调用),所以停在「待授权调模型」,需要 Jacky 本人放行或亲自执行 §8 的命令。

还没调模型就已经能说的一条(零模型,真实数据):**这些生产触发器事件全做(A 臂)是负的**。现货只做多每笔 −0.061R(95% CI [−0.18, +0.07]),永续多空 −0.017R([−0.10, +0.07])。按 1h 与 4h 均线同向过滤(A_f)后,两版都转成小正,但区间都跨 0(§7)。所以模型要证明的不是「能赚钱」,而是「挑得比 A_f 和随机都好」。

## 1. 问题怎么问

同一批事件、同一套管仓与成本,臂之间只差「做不做」。模型每个事件最多调用一次,只决定入场(follow / skip)。持仓与离场全部由代码管,模型给的价位只记录、不使用。这样问出来的就是纯粹的「判断力」:挑单挑得好不好。价位放得好不好是几何实验室回答的问题,这里把它剥离出去。

## 2. 事件来源与保真

**事件 = 生产扫描循环的触发器。** 生产 judge 在每根 K 线收盘跑 `triggers.ts detectTriggers`,有命中才叫醒模型,`backtest.ts` 的盲回放也是这样做的。这些触发器是纯函数,只吃已收盘 K 线,所以可以在冻结数据上逐根重放。这里没有用任何固定策略的信号,也没有借用几何实验室的 Donchian 候选,因为生产的候选源本身就能重放。

直接 import 的生产部件(只读,一行没改):
- `context.ts buildContext`:模型看到的 system / user 就是它的原文(scan 模式、`strategies=[]`、`DEFAULT_WORKFLOW.playbook_text`,PROMPT_VERSION `demo-playbook-v11-formula`);
- `schema.ts validateJudgment / extractJson / findMemoryNumberLeaks` 加上允许动作集检查,与 `backtest.ts judgeOnce` 的单轮解析逐条一致;
- `gates.ts evaluateGates`:PROPOSE 必须全部过闸才算 follow;
- `backtest.ts visibleWindow / ticker24hFromBars / assertBlind`,`market.ts tfFeatures / dailyRegime`,`triggers.ts detectTriggers / sessionInfo`,`strategy-signals closedWeeks`;
- 几何实验室 `viewAt / assertVisible / pivots`,以及 `outcome.ts` 的 `simulateOutcome / openTrade / stepTrade / tradeCosts`。

镜像的部分(未导出或有副作用,逐字照抄,由测试钉住):
- `backtest.ts barFeatures / triggerHitsAt / accountAt`:窗口 60 / 120 / 80 根,日线 260 根,收盘价当 mark,fast_move 记 null。
- `lightFeatures`:`tfFeatures` 去掉指标快照。原版每次约 3.6ms,逐根重放 8 万根要十分钟,触发器也只用基础字段。事件根上会用生产 `tfFeatures` 重算一遍喂给上下文,两者在 16 个触发器字段上逐位相等,运行时断言、测试也钉住了。
- 吊灯结算:做多时与几何实验室 `settleTrail` 逐字段一致(测试),另外补了做空镜像和资金费。

**与生产不同的地方(全部写进了 manifest / 报告):**
1. 生产遇到契约错误会追加一轮修复调用。这里为了「每事件最多一次调用」不做修复,契约错误直接记 `model_error`,按生产 fail-closed 语义算作不做,报告单列计数。
2. 持仓期间不跑 `holding-policy.ts` 的复查,离场全部交给代码。这是设计选择,不是缺件。
3. 事件彼此独立,都按单位风险的虚拟单结算。同币的持仓可以重叠,`opens_today` 恒为 0,所以「每日开仓上限」这道闸在这里永远通过。
4. 现货版用的是生产那份永续 scan 提示词(生产扫描循环本来就只有这一份),市场字段标成 spot,不给资金费行。
5. 数据只有 1h,4h / 1d / 1w 由 1h 聚合成完整桶(UTC 对齐,与交易所同口径)。没有 15m,没有 OI,没有信息员和新闻,也没有记忆。这和 backtest.ts 盲回放「拿不到就不给、不编」的原则一致。
6. 另有一种 `--prompt research` 模式:沿用同一份生产证据登记,但任务换成「代码给出的事件做不做」,输出 `{"decision","reason"}`。manifest、报告和 system 文本里都标注了 **「research prompt,非生产 harness」**。默认不用它,它只作为便宜的对照备选。

**本实验新增的三条代码规则**(`EVENT_RULES_VERSION = jr-events-v1`):
- 触发器转方向:breakout 按突破方向;ema_cross 按 EMA20 与 EMA50 交叉后的新位置;vol_spike 按这根 K 线的涨跌;retest 按 1h 趋势。funding 和 session 没有方向,只作为上下文里的附带命中。同一根 K 线有多条命中时,取分数最高的那条有方向的。
- 同币同方向冷却 24 根。
- 结构止损放在最近一个已确认的 1h 摆动低(高)点外 0.1 ATR,没有就用近 10 根的最低(最高)。离参考收盘不足 0.5 ATR14 的不做:所有臂都不做,也不叫模型。这与几何实验室和研究侧新口径一致。

## 3. 臂

- **A**:事件全做。
- **A_f**:代码过滤,1h 与 4h 的 EMA20/EMA50 都与方向一致才做。这是默认 playbook「适用」条件的代码版。
- **B**:GLM(`pi:zai/glm-5.3`,生产适配器 `brain.ts piBrain`,用 pi 自带凭证)。
- **B2(即 B')**:DeepSeek(`pi:deepseek/deepseek-v4-flash`)。用专用 key,每次调用显式传 `--api-key`,因为 pi 的 auth.json 里另有一把 deepseek key,而且优先级高于环境变量。key 只在内存里,不进库、不进 manifest、不进日志,错误信息里出现也会抹掉。manifest 只记「dedicated key」。
- **R**:随机基线。在模型臂的同一子集里,不放回地随机挑出与该模型臂同样多的事件,种子 1..200 各抽一次。

模型臂的 follow 条件:PROPOSE、方向与事件一致、并且 gates 全过。模型提议反向算不做,报告单列「方向相反」和「被闸拦」的次数。

## 4. 管仓与成本(所有臂共用,每个事件只结算一次)

- **trail(主)**:下一根开盘市价成交;初始止损取结构止损;从成交起挂吊灯线,取 HH/LL ∓ 3×ATR22(已收盘 K 线的简单均值),只收紧不放宽,不设目标,最长 168 根。
- **plan(副)**:结构止盈取方向上 1–6 ATR 内最近的已确认 1h 摆动点,没有就不设;48 根到期按收盘价平。直接调 `simulateOutcome`,同一根同时碰到止损和止盈算止损,跳空穿止损按开盘价成交。
- 成本:`DEFAULT_COSTS`(taker 0.05%×2,0.01 ATR 滑点×2)。永续再按 OKX 真实资金费计入,多头付正费率;现货没有资金费。R 的分母是 |成交价 − 初始止损|,全程不变。

## 5. 统计

每个事件在每个臂上的结果 = 做 ? 该事件净 R : 0。
- **每笔期望**只看做了的单,回答「挑出来的单好不好」。
- **每事件均值**把不做记 0,回答「这个过滤器整体值不值」。**配对差**也在它上面逐事件算(臂 X − 臂 Y)。B − A 恰好等于「被 B 跳过的那些事件的净 R 之和」取负号再除以 n,测试钉住了这个等式。
- **95% CI**:按 UTC 日整簇 bootstrap,2000 次,固定种子。同一天 6 个币高度相关,逐笔独立重抽会把区间算窄。
- **随机基线**:报告 200 次抽样的每笔均值与 2.5–97.5% 分位带,以及「随机抽样不低于模型每笔期望的比例」(单侧)。这个比例越小,越说明模型确实挑得比随机好。
- **拆分**:按币、按行情段各出一张表。两个模型都跑过的事件上,再出 B − B2 的配对。

## 6. 冻结、防泄露、预算

- **冻结**:所有东西都在独立实验库里,不碰现网库,两个现网 state 库和研究行情缓存都会被拒写。库里存数据快照(每币 sha256、缺口数)、OKX 资金费、manifest(规则 / 管仓 / 提示词版本、playbook 与 system 哈希、事件集哈希、每臂冻结的模型标识)、每事件的提示词原文,以及模型原始输出和解析结果。manifest id 由全部输入的哈希决定,同样输入重冻结得到同一个 id;已有模型输出的 manifest 拒绝重建。已冻结的臂也不能换模型。
- **零模型重放**:`replay` 把库里的原始输出重新解析,逐条比对落库的决定。报告可以反复重算,结果逐字节相同。
- **防泄露**:每个事件跑生产的 `assertBlind`,再加三项检查:每条 K 线的 close_time ≤ as_of,特征的最后一根在 as_of 前收盘,资金费时间 ≤ as_of。测试会把 as_of 之后的 K 线全部换成垃圾值,断言 system / user 文本逐字节不变、止损不变;塞进一根未来 K 线则必须抛错。
- **预算**:每个模型在整个库里累计「调用数」与「估算人民币」两道上限。每次调用前按「输入字符/3 + 预计输出 400 token」预留,越线就不发。调用后换成实测;失败的调用按已计费处理。单次调用超时 90s,失败记 model_error,不重试。
- **进程**:全部在命令行独立进程里跑,不进 18811 网关。

## 7. 桩模型在真实冻结数据上的结果(格式样例)

零模型的 A / A_f 是真实结果;B / B2 这里是桩模型,数字没有意义,只用来展示真跑会产出的表。stub-rule 的规则是「触发器为 breakout 或 retest 就跟」,stub-random 以 40% 概率跟。

现货只做多,trail,全部 986 个事件(零模型,真实):

| 臂 | 笔数 | 每笔净 R [95% CI] | 胜率 | 每事件 R [95% CI] |
|---|---|---|---|---|
| A | 986 | −0.061 [−0.18, +0.07] | 31% | −0.061 [−0.18, +0.07] |
| A_f | 296 | +0.032 [−0.19, +0.28] | 33% | +0.010 [−0.05, +0.08] |

按行情段拆开(trail):下跌段 A 每笔 −0.075、A_f +0.129;几何实验室那段 A −0.034、A_f −0.080。永续多空 2035 个事件:A 每笔 −0.017、A_f +0.066;plan 管仓下 A_f − A 为 +0.065 [+0.02, +0.10],是目前唯一不跨 0 的区间。**结论方向在两段行情里并不一致,单边上涨段里过滤反而更差。** 这正是要求跨行情段的原因。

桩臂报告样例(现货,B = stub-rule 全 986 个,trail):B 做 507 笔,每笔 −0.016 [−0.15, +0.14];随机挑 507 笔的带是 [−0.15, +0.02],随机不低于 B 的比例 12%;B − A 为 +0.052 [−0.04, +0.13](决定不同 479 个,好 340 / 差 139);B − A_f 为 −0.018 [−0.08, +0.05]。完整报告每个模型臂都有:动作分布、方向相反数、被闸拦数、model_error、token、¥、延迟;A / A_f / 模型 / 随机四臂表;三组配对;按币 6 行、按行情段 2 行;两模型同子集的 B − B2。

## 8. 预算估算与真跑计划

token 按「字符数/3」估:平均每次输入约 2090 token(system 4408 字符 + user 约 1850 字符),输出按 400 token 计(backtest.ts 的估价口径)。中文按字符/3 会低估,上界取 ×3。价格用 `brain.ts BRAIN_PRICES_CNY`:GLM 入 ¥2/M、出 ¥8/M;DeepSeek flash 入 ¥1/M、出 ¥2/M。

| 模型 | 事件集 | 调用数 | 点估计 | 上界(×3) | 其中 下跌段 / 几何段 |
|---|---|---|---|---|---|
| GLM | 现货,分层抽 130 | 130 | ¥0.91 | ¥2.73 | 85 / 45 次 |
| DeepSeek | 现货,分层抽 400(包含 GLM 那 130) | 400 | ¥1.20 | ¥3.60 | 259 / 141 次 |
| DeepSeek | 永续,分层抽 240 | 240 | ¥0.72 | ¥2.16 | 160 / 80 次 |
| 合计 | | 770 | ¥2.83 | ¥8.49 | GLM ¥2.73 + DeepSeek ¥5.76 |

参考:现货全跑 986 个,GLM 点估计 ¥6.90 / 上界 ¥20.7,DeepSeek ¥2.96 / ¥8.87。永续全跑 2035 个,约为现货的 2.06 倍。分层抽样按「行情段 × 币」分层,层内按哈希排序,可复现;GLM 的 130 个完全落在 DeepSeek 的 400 个里,两者可以配对。

按授权上界(GLM ≤ ¥3、DeepSeek ≤ ¥6)定的运行时硬停:实时计量同样是字符/3 口径,所以把实时上限定成上界的 1/3。GLM 实时 ¥1.0、140 次;DeepSeek 实时累计 ¥2.0(现货那一轮先停在 ¥1.25)、700 次。并发 4 的情况下,预计 GLM 约 6 分钟,DeepSeek 约 25 分钟。

执行命令(实验库 `~/.trade-gate-okx/research/judgment-replay/jr.sqlite` 已冻结好两个 manifest,decisions 为空):

```bash
cd <repo>/packages/gateway
S=scripts/research-judgment/judgment-replay.ts; export JR_ALLOW_REAL_MODEL=1
npx jiti $S run --manifest jr-spot-prod-cd24-2e7a0cc2 --arm B  --brain glm      --allow-real --sample 130 --max-calls 140 --max-cny 1.0  --concurrency 4
npx jiti $S run --manifest jr-spot-prod-cd24-2e7a0cc2 --arm B2 --brain deepseek --allow-real --sample 400 --max-calls 420 --max-cny 1.25 --concurrency 4
npx jiti $S run --manifest jr-perp-prod-cd24-52d3791a --arm B2 --brain deepseek --allow-real --sample 240 --max-calls 700 --max-cny 2.0  --concurrency 4
npx jiti $S replay --manifest jr-spot-prod-cd24-2e7a0cc2 && npx jiti $S replay --manifest jr-perp-prod-cd24-52d3791a
npx jiti $S report --manifest jr-spot-prod-cd24-2e7a0cc2 --md spot.md; npx jiti $S report --manifest jr-perp-prod-cd24-52d3791a --md perp.md
```

`run` 可以续跑:已有决定的事件会跳过,上限按整个库累计。

## 9. 已知局限(读结果前先看)

1. **训练记忆风险。** 提示词里有绝对日期和绝对价格(生产上下文就是这样)。下跌段 2025-09→2026-03 很可能在 GLM / DeepSeek 的训练语料里,模型可能「记得」后来的走势;几何段 2026-06→09 相对安全一些。如果模型只在下跌段显著好于随机,要先怀疑这一条。去掉日期、把价格归一化能缓解,但那样就不再是生产 harness,所以这一版没做,可以作为 research 变体再加。
2. **生产上下文本身有两处缺陷,被原样继承。** 一是「1h 最近 4 根」对低价币按 `toFixed(0)` 打印,DOGE / XRP 显示成 `O0 H0 L0 C0`(`market.ts tfFeatures.last_bars`)。二是主周期就是 1h 时,1h 结构行出现两次(E3 / E4,窗口 60 与 120 根)。这两处属于 jacky-24 的范围,本实验没动,建议修。
3. 事件都按独立虚拟单结算,没有账户层的容量和每日开仓约束;结果回答的是「挑单」,不是「账户曲线」。
4. 样本量:GLM 只有 130 个事件。按几何实验室的经验,配对差的标准差在 0.7–1.8R 量级,所以 130 个只能看出约 0.3R 以上的差距;DeepSeek 400 个可以看到约 0.15–0.2R。
5. 现货数据是 OKX 现货,永续是 OKX 永续成交价加 OKX 资金费,不是币安。

## 10. 文件

- `research/judgment-replay/types.ts`:版本号、行情段、常量、事件类型。
- `data.ts`:只读读取现货数据集与永续 K 线、资金费(WAL 打不开时复制到临时目录再读)。
- `events.ts`:生产触发器重放、方向规则、结构止损与止盈、A_f、生产上下文与防泄露断言。
- `settle.ts`:trail / plan 双向结算加资金费。
- `judge.ts`:prod / research 两种解析、GLM / DeepSeek / 桩客户端、预算。
- `stats.ts`:整簇 bootstrap、配对、随机基线、分层抽样、分组。
- `store.ts`:实验库。
- `run.ts`:冻结、估价、跑臂、零模型重放、报告。
- 桩跑的实验库与报告在会话 scratchpad(`jr-stub.sqlite`、`stub-spot.md`、`stub-perp.md`),不入库。
