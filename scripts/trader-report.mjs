import { readFileSync, writeFileSync } from "node:fs";
const dir = "docs/research/data/traders-0912",
  r = JSON.parse(readFileSync(`${dir}/results.json`)),
  features = JSON.parse(readFileSync(`${dir}/features.json`));
const f = (x, n = 4) =>
    x === null || x === undefined || !Number.isFinite(x) ? "—" : x.toFixed(n),
  pct = (x) => (x == null ? "—" : f(x * 100, 1) + "%"),
  ci = (x) =>
    x?.lower == null ? "insufficient" : `[${f(x.lower)}, ${f(x.upper)}]`,
  est = (x) => `${f(x?.mean)} / ${ci(x?.ci)} (n=${x?.effective_n ?? 0})`;
const table = (head, rows) =>
  "| " +
  head.join(" | ") +
  " |\n| " +
  head.map(() => "---").join(" | ") +
  " |\n" +
  rows.map((row) => "| " + row.join(" | ") + " |").join("\n") +
  "\n\n";
const eligible = features.filter((x) => x.eligible),
  sources = Object.entries(r.corpus),
  q = readFileSync(`${dir}/qualitative.md`, "utf8");
let text = `# 交易员信号拆解与 alpha 复刻 I（2026-09-12）\n\n离线零模型研究；没有写 active、策略版本、晋升门或运行数据库，没有重启进程。结论针对这份频道语料和明确的执行代理，不是交易员账户收益认证。\n\n## 数据、预注册与可复现性\n\n`;
text += table(
  ["交易员", "原文/逐字不同", "结构化", "open", "add", "reduce", "close"],
  sources.map(([t, x]) => [
    t,
    `${x.raw}/${x.unique_text}`,
    x.structured,
    x.actions.open ?? 0,
    x.actions.add ?? 0,
    x.actions.reduce ?? 0,
    x.actions.close ?? 0,
  ]),
);
text += `\n结构化共 1105 条，open/add ${r.counts.open_add} 条；全部回连 source_message_id。最终可归因 ${r.counts.eligible} 条。原始文本、解析输出、人工修正表都保留；没有调用新模型解析或看图。关键词统计覆盖全部 3098 条，包含转发重复，因此不是独立事件频数。\n\n`;
text += table(
  [
    "交易员",
    "支撑",
    "阻力",
    "前低",
    "前高",
    "整数",
    "均线",
    "资金费",
    "保本",
    "异动",
    "市价",
  ],
  sources.map(([t, x]) => [
    t,
    ...[
      "支撑",
      "阻力",
      "前低",
      "前高",
      "整数",
      "均线",
      "资金费",
      "保本",
      "异动",
      "市价",
    ].map((k) => x.keywords[k]),
  ]),
);
text += table(["排除原因", "条数"], Object.entries(r.counts.exclusions));
text += table(
  ["R 可计算性（全部 open/add，含后续排除记录）", "条数"],
  Object.entries(r.counts.r_status),
);
text += `\n交易员发布时间采用原文明确标注的 Beijing 时间（转 UTC），否则用 payload create_time，最后才用 received_at（显式 UTC）。received_at 单独保留；晚到超过 5 分钟的转发不进推断，也不占及时信号的去重键。没有原发时间的普通接收消息仍可能含未知发布延迟，随机对照不能修复这种误差。\n\n预注册在首次数值回放前提交（f900133）。之后修正的是可复现的解析/成交/时间错误，不更换参数网格；完整代码和执行口径进入 trial key，旧试验保留。因此累计 trial 可以大于每族 3 个参数候选。规则由 6–9 月语料启发，180d 历史折 **属于回顾性 walk-forward，不是独立前瞻 OOS**；DSR 也不能消除这种研究者选择偏差。\n\n`;
text +=
  "```sh\nnpm run lab -- --study traders --fill   # 首次/补齐：环境代理、限速、重试\nnpm run lab -- --study traders          # 缓存重跑，不联网、不读 state.sqlite\nnode scripts/trader-report.mjs          # 单独从冻结 JSON 重建本文\n```\n\n";
text += `可用 --cache-root 指定独立行情研究目录。默认 K 线在 ~/.trading-swarm/demo/klines，资金费、tick、月档与 append-only trial ledger 在 research-traders 子目录。金额/价格序列以十进制字符串输出，时间为 UTC unix 毫秒。输出：[逐条特征](data/traders-0912/features.json)、[完整统计/折/净值/哈希](data/traders-0912/results.json)、[预注册](data/traders-0912/preregistration.json)、[原文修正](data/traders-0912/corrections.json)。\n\nregistration hash: \`${r.registration_hash}\`；execution hash: \`${r.execution_hash}\`。同一代码、语料和行情快照重跑不增加 trial。刷新行情或修改代码后需保留旧 results.json 才能逐字复现旧结论；脚本内数据 SHA256 可用于校验，不自动从远端恢复旧数据。\n\n${q}\n`;
text += "## 2. 零模型特征与归因\n\n";
text += `发布特征严格使用 close_time≤T：价格优先最近完整 1m，缺失时用最近完整 15m 并记录 price_at；ATR 为 1h 最近 14 个 TR 的共享 atr 口径。4h 摆动点用左右各两根已收盘确认、最近 260 根范围内与入场最近的高/低；前日高低按 UTC；VWAP 为当日已完成 15m 典型价×量/量的代理；均线为 1h SMA20/50/200，暖身不足为 null。整数网格为 10^(floor(log10(发布价))-2)，例如 BTC 使用千位以下的百位网格，网格大小逐行输出，并非交易员真实手工标线。趋势采用各自周期 SMA20 相对 SMA50；RSI 为最近 14 次涨跌的简单 RSI（非 Wilder 递推）。regime 使用共享 dailyRegime。资金费特征只取 T 以前最后一条，并给时间和 age，不能把陈旧费率当实时读数。\n\n每个 open/add 均保留，阶梯的每个位另有 per_level；触及、MFE/MAE、SL/TP 结算和 4h/24h 前瞻覆盖分开标注。MFE/MAE 从成交根到发布后固定 24h 观察窗末，包含 OHLC 成交根未知顺序，也可能含 SL/TP 退出后的价格，不等于真实账户持仓轨迹。缺 SL 则 R=null，仍可测 ATR 或 bps。\n\n随机对照为同 symbol、同 UTC 日期、同 4h 时段的完整 15m 起点，固定 seed 由 signal_id 派生，抽 20 次（有放回，最多 16 个不同起点）。方向保持原单方向；随机点也必须拥有完整 24h 后验。对照用于近时段安慰剂，不是因果识别，且可共享行情路径。\n\n三块是不同估计量，**不能相加成一个总 alpha**：direction=保持原单方向、在匹配的随机时点持有24h的收益（随机正负方向的毛收益期望为零）；level=限价相对发布价的 ATR 改善，以及与 next-open 基线配对的 Δnet R（共同 next-open 初始风险分母，未成交/拒单为 0）；timing=发布后收益减同方向随机时点收益。direction + timing 恰好等于发布后24h收益，level使用另一套SL/TP及R分母，不能再直接加上。净收益扣共享成本；发布后原始毛/净bps也逐条输出。没有 SL 的点位优势不能被包装成已实现的净 R。\n\n推断先按同 UTC 4h 合并跨币机会均值，再用 replay-stats 的循环移动块 bootstrap：块长 ceil(sqrt(n))、2000 次、seed=0x51a7、95% CI，簇 n<30 一律 insufficient。下表 n 是有效簇，非原始订单数。方向的净收益在零方向优势下仍负担费用，所以正净均值比正毛均值要求更高。\n\n`;
text += table(
  [
    "交易员",
    "机会/24h完整/R有效",
    "方向随机时点净24h bps / CI",
    "发布净24h bps / CI",
    "时机净4h bps / CI",
    "时机净24h bps / CI",
  ],
  Object.entries(r.attribution.by_trader).map(([t, x]) => [
    t,
    `${x.n}/${x.full_24h}/${x.r_valid}`,
    est(x.net_direction_component_bps),
    est(x.net_forward_24h_bps),
    est(x.net_timing_4h_bps),
    est(x.net_timing_24h_bps),
  ]),
);
text += "\n";
text += table(
  [
    "交易员",
    "限价改善 ATR / CI",
    "点位 Δnet R / CI",
    "触及/市场进入比例 / CI",
    "初始SL/TP净R / CI",
  ],
  Object.entries(r.attribution.by_trader).map(([t, x]) => [
    t,
    est(x.level_improvement_atr),
    est(x.level_delta_net_r),
    est(x.fill_probability),
    est(x.expectancy_r),
  ]),
);
text +=
  "\n触及比例为计划首腿的统一机会统计，市场跟随腿只要完整后验即为进入，不能解释为 maker 成交概率。纯限价腿的穿价概率、拒单与实际成交在 features 的 per_level/outcome 中保留。限价改善不计市价首腿；阶梯第二腿需看 per_level，不能把第一腿均值当整个梯子的均价。\n\n";
text += table(
  [
    "交易员",
    "前高",
    "前低",
    "整数",
    "前日高",
    "前日低",
    "VWAP",
    "SMA20",
    "SMA50",
    "SMA200",
  ],
  Object.entries(r.attribution.by_trader).map(([t, x]) => [
    t,
    ...Object.values(x.mean_distance_atr).map((v) => f(v, 2)),
  ]),
);
text +=
  "\n上表为入场到各参照的绝对 ATR 距离均值，未按结果剔除远价单；它不证明点位由相应指标生成。全量“人×币×多空×UTC四小时时段”分层表见文末，全部分层 CI 和点位距离在 results.json，不能只挑正收益的子组。\n\n";
text += "逐条特征汇总（首腿，已触及后固定观察窗；数量为有效观察条数）：\n\n";
const avg = (xs) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
text += table(
  [
    "交易员",
    "MFE ATR / MAE ATR",
    "MFE R / MAE R",
    "纯限价腿/穿价腿",
    "限价穿价率",
    "均值RSI 4h/1d",
    "资金费特征覆盖",
  ],
  Object.keys(r.corpus).map((trader) => {
    const xs = eligible.filter((x) => x.trader === trader),
      nums = (k) => xs.flatMap((x) => (x[k] === null ? [] : [x[k]])),
      limits = xs
        .flatMap((x) => x.per_level)
        .filter((x) => x.entry === "limit" && x.touched !== null);
    return [
      trader,
      `${f(avg(nums("mfe_atr")))} / ${f(avg(nums("mae_atr")))}`,
      `${f(avg(nums("mfe_r")))} / ${f(avg(nums("mae_r")))}`,
      `${limits.length}/${limits.filter((x) => x.touched).length}`,
      pct(
        limits.length
          ? limits.filter((x) => x.touched).length / limits.length
          : null,
      ),
      `${f(avg(xs.flatMap((x) => (x.snapshot?.rsi_4h == null ? [] : [x.snapshot.rsi_4h]))), 1)} / ${f(avg(xs.flatMap((x) => (x.snapshot?.rsi_1d == null ? [] : [x.snapshot.rsi_1d]))), 1)}`,
      `${xs.filter((x) => x.snapshot?.funding_rate != null).length}/${xs.length}`,
    ];
  }),
);
text +=
  "这张穿价率表只统计纯limit腿，首根市场化的拒单保留在分母且不算穿价成交，仍不证明队列真实成交。MFE/MAE先作描述，不用最大有利路径替代净SL/TP回放。\n\n";
text +=
  "初始计划的成本分解（原始机会等权，R；与上面的簇等权推断均值可不同）：\n\n";
text += table(
  ["交易员", "可评分机会", "gross", "fee", "slip", "funding", "net"],
  Object.keys(r.corpus).map((trader) => {
    const xs = eligible
      .filter((x) => x.trader === trader && x.outcome)
      .map((x) => x.outcome);
    return [
      trader,
      xs.length,
      ...["gross_r", "fee_r", "slip_r", "funding_r", "net_r"].map((k) =>
        f(avg(xs.map((x) => x[k]))),
      ),
    ];
  }),
);
text += "## 3. 可机械化假设与冻结参数域\n\n";
text += table(
  ["family", "确定性规则", "参数域/其他固定口径", "依据与边界"],
  [
    [
      "trader_sr_reversal",
      "4h 最近20根（不含当前根）高低边缘；当前收盘仍在区内且距最近边缘≤0.5ATR；边缘向区内挂限价",
      "offset_atr=0.1/0.2/0.3；SL为区外0.5ATR；TP=1/2/3R各1/3；24h期限；每币24h冷却",
      "支撑阻力反转；没有复刻“同点只做两次”或事件判断",
    ],
    [
      "trader_intraday_sweep",
      "1h 对前24根极值扫穿，收盘回区间；双侧同时扫穿拒绝",
      "sweep_atr=0.1/0.3/0.5；next-open一腿+被动0.3ATR一腿，各1/2初始风险；首腿SL=1.5ATR；TP=1/2/3R；首档后下一根保本；24h期限/冷却",
      "极端位反转与阶梯执行代理；不能证明三马真实使用此算法",
    ],
  ],
);
text += `\n两族共 6 组，币池固定 BTCUSDT/ETHUSDT；没有结果驱动扩参或扩大币池。SR 反转动机来自 [Osler (2000)](https://www.newyorkfed.org/medialibrary/media/research/epr/00v06n2/0007osle.pdf) 对外汇支撑阻力的经验检验；订单聚集、止损与止盈对价格的不同反馈来自 [Osler (2001/2003)](https://www.newyorkfed.org/research/staff_reports/sr125.html)。把这些机制用于 crypto sweep 是本研究的待证推断，并非文献已证明这两套参数有收益。多重试验使用 [Bailey–López de Prado (2014) DSR](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf) 的共享实现。\n\n赵哥的库存规则暂不伪装成第三套完整仓位策略：缺初始库存、常规仓名义、分批数量以及历史盘口。可以在下一次独立预注册检验“开盘回踩后反弹减半”，前提是先取得这些字段和交易时段映射。\n\n`;
text += "## 4. 同成本回放与人肉基线\n\n";
text += `机械窗 2026-03-16→2026-09-12 UTC 右开，180d。共享 anchoredWalkForward 为锚定60d训练/20d测试、完整24h purge；完整持有期必须落在折内，5个完整测试折共100d OOS，5d purge，尾部15d不足一个20d折不计OOS。训练有效簇≥30才能按训练净均值选参数，同分按固定序号。保留全部候选、失败和未被选中的结果，试验不按盈利与否删除。机械统计是逐折训练选择的组合，不是全窗挑最佳候选。参数源与预注册不一致时脚本直接失败。DSR 未另估跨候选 Sharpe 方差，沿用共享零假设标准误下限；累计 trial 见表。\n\n所有主结果使用相同15m路径、相同保守穿价/止损/成本函数。limit 须穿价至少1 tick；若首根已市场化则拒单并保留0R，不冒充maker；限价成交根不兑现TP，同根双触碰先SL，跳空穿SL用open。多档以初始风险权重结算，保本仅下一根生效、不重设R分母。每腿退出费与资金费按自己的离场时点计算；整体退出时间取最晚，组合DD按闭合根净清算权益并发叠加。没有资金/保证金并发上限，DD与累计R不是账户百分比。\n\nmaker 2bp、taker 5bp；滑点max(当前tick,0.01ATR)，market双侧、limit退出侧；资金费使用历史实际点。缺费率的结算沿用共享函数区间均值估计，并保留known/expected。部分股票与油合约有1h/4h资金周期；expected仍是原harness的8h模型，因此这里的expected覆盖不能当历史周期完整性认证。tick也为当前快照，不是历史tick。\n\n人肉 family 是原文初始计划的离线执行代理，不是完整动态账本：缺SL不给R，区间取中点，阶梯按等初始风险；明确原文首档70%覆盖bridge等份，其他未明确份额按剩余等分；替代目标歧义排除。后续close/reduce/SL更新没有可靠仓位链接，未事后回填。长期油/现货计划的24h结果仅是统一观察窗。赵哥已成交通知用next-open跟随，原买价不回填为我们的成交。人肉语料始于6月，180d前段没有人类观察，也没有可比的完整首60d训练；不能填0冒称有180d人肉样本。\n\n`;
text +=
  "人肉统计集包含全窗可评分记录，机械统计集只拼接逐折所选OOS记录；它们的统计集机会数不是相同时间暴露，比较以OOS列为准，所有候选全窗数量另列。\n\n";
const statsRow = (name, s, trials) => [
  name,
  s.raw_n,
  s.oos_raw_n,
  s.oos_n,
  f(s.oos_net_expectancy),
  ci(s.oos_ci),
  f(s.dsr),
  f(s.max_dd_r, 2),
  trials,
];
text += table(
  [
    "family",
    "统计集机会",
    "OOS机会",
    "OOS簇",
    "净OOS R",
    "95%CI",
    "signed DSR",
    "并发DD R",
    "trial",
  ],
  [
    ...r.human.map((x) => statsRow(x.family, x.stats, x.stats.trial_count)),
    ...r.mechanical.map((x) =>
      statsRow(x.family, x.selected_stats, x.trial_count),
    ),
  ],
);
text += "\n严格同币比较（人肉也只取BTC/ETH，时段仍受各自发布覆盖限制）：\n\n";
text += table(
  [
    "family",
    "统计集机会",
    "OOS机会",
    "OOS簇",
    "净OOS R",
    "95%CI",
    "signed DSR",
    "并发DD R",
    "trial",
  ],
  r.human.map((x) =>
    statsRow(
      x.family + " BTC/ETH",
      x.common_crypto_stats,
      x.common_crypto_stats.trial_count,
    ),
  ),
);
text += "\n候选全窗诊断（OOS未参与参数选择，不能从下表事后改选）：\n\n";
text += table(
  ["family/候选", "参数", "机会", "OOS簇", "净OOS R", "CI", "DSR"],
  r.mechanical.flatMap((x) =>
    x.candidates.map((c) => [
      `${x.family}/${c.key}`,
      JSON.stringify(c.params),
      c.stats.raw_n,
      c.stats.oos_n,
      f(c.stats.oos_net_expectancy),
      ci(c.stats.oos_ci),
      f(c.stats.dsr),
    ]),
  ),
);
text += "\n逐折选择：\n\n";
text += table(
  ["family", "训练终点 UTC", "测试起点 UTC", "候选", "训练净R", "测试机会"],
  r.mechanical.flatMap((x) =>
    x.selected_folds.map((c) => [
      x.family,
      new Date(c.fold.train_to).toISOString().slice(0, 10),
      new Date(c.fold.test_from).toISOString().slice(0, 10),
      c.key,
      f(c.is_expectancy),
      c.n,
    ]),
  ),
);
const fine = eligible.filter((x) => x.outcome && x.one_minute_net_r !== null),
  delta = fine.map((x) => x.one_minute_net_r - x.outcome.net_r);
text += `\n1m成交敏感性：在同一初始计划且15m/1m都能完整计算的 ${fine.length} 条中，1m−15m 的每机会净R差均值为 ${f(delta.length ? delta.reduce((a, b) => a + b, 0) / delta.length : null)}。这是分辨率敏感性描述，不按该结果挑更好分辨率，也不据此替换主结果。\n\n`;
text += "## 5. 能证伪什么，哪些还不能回答\n\n";
for (const [trader, x] of Object.entries(r.attribution.by_trader)) {
  const d = x.net_direction_component_bps,
    t = x.net_timing_24h_bps;
  text += `- ${trader}：随机时点方向净24h ${f(d?.mean)}bps（${ci(d?.ci)}），发布时机增量 ${f(t?.mean)}bps（${ci(t?.ci)}）。${t?.ci?.lower > 0 ? "当前匹配时段中时机增量为正，值得在新语料检验；这没有证明总体净收益为正。" : "尚无稳定的正时机增量证据。"}\n`;
}
for (const x of r.mechanical) {
  const s = x.selected_stats;
  const claim =
    s.oos_ci.upper !== null && s.oos_ci.upper < 0
      ? "在当前观察窗和成本下，95%区间整体低于0，可反驳正净期望。"
      : s.oos_ci.lower === null
        ? "有效样本不足，不能完成正负期望检验。"
        : "区间跨越0，尚不能断言真期望为负，也没有证据证明正净优势。";
  text += `- ${x.family}：OOS ${s.oos_n} 簇、净 ${f(s.oos_net_expectancy)}R，${claim} signed DSR=${f(s.dsr)}、DD=${f(s.max_dd_r, 2)}R。\n`;
}
text +=
  "- 人肉初始SL/TP基线的结论只适用于可评分子样本。缺SL、无仓位关联、复盘选择与通知延迟限制外推；尤其赵哥不能据R缺失判断“零收益”或“无能力”。\n- 正的近时段 timing 差值不等于可部署alpha：控制点共享日期/时段，作者可能先成交后通知，且按币/方向/时段进行了大量描述性分层。分层CI未另做全家族错误率校正，仅用于后续预注册。\n- 当前没有候选获得上线/晋升授权，也没有调用晋升函数。现有门仍要求净CI下界>0、DSR>0、足够OOS成交有效簇、至少两类非负regime及DD≤3R；未成交0不能补成交数。此次回顾性研究即使某项统计越线，也不能据此直接获得前瞻资格。\n- 下一步先建立原消息版本、事件发布时间、position_ref、常规仓量、成交/撤单/分批目标关系；人工逐条确认歧义后冻结新语料外60d，保留当前参数和成本，才能区分方向、点位、通知时机与持仓管理的贡献。\n\n";
text +=
  "## 附录 A：公开行情实际覆盖\n\n名义特征数据要求为5/20至9/12含当日（下表分母到9/13 00:00 UTC）；下载冻结到9/12 00:00，现有粗周期缓存中当日已闭合数据可保留。最后一天尚无完整24h前瞻，属于右删失，不用未来数据补。1m/5m最多覆盖至9/12 00:00，5m优先由完整连续1m聚合；月档为Binance公开USD-M K线归档，REST只补实际缺口。机械180d及日线额外暖身在缓存中另有更早数据。下列比例是实有根数，不是请求成功率，也不是上市后的百分比。\n\n";
const symbols = [...new Set(r.coverage.map((x) => x.symbol))].sort();
text += table(
  ["symbol", "1m", "5m", "15m", "1h", "4h", "1d"],
  symbols.map((s) => [
    s,
    ...["1m", "5m", "15m", "1h", "4h", "1d"].map((tf) => {
      const x = r.coverage.find((x) => x.symbol === s && x.tf === tf);
      return x ? `${x.bars}/${x.expected} (${pct(x.bars / x.expected)})` : "—";
    }),
  ]),
);
text +=
  "\n精细缓存连续性核验见 [cache-audit.json](data/traders-0912/cache-audit.json)，可用 `python3 scripts/trader-cache-audit.py` 重跑（默认缓存目录）。核验的是已观测起止之间的内部缺口，不把上市前或右删失当已覆盖。\n\n当前清单缺 CIFRUSDT、CLBZUSDT、CONLUSDT、MSFLUSDT、PLUSDT、PREOPAIUSDT；不可得不伪造，行情类字段留空。SPXUSDT虽存在，但为meme币，不是原文的SPX指数，单独排除。当前清单不证明历史从未上市，也不是完整历史退市全集。其余股票、商品、Pre-IPO合约按实际历史覆盖处理，不能用普通股票现货数据偷换期货报价。\n\n";
text +=
  "## 附录 B：人×币×多空×UTC时段（完整分层）\n\n时段为UTC四小时桶起点；UTC+8读者自行加8。下表列净方向与净时机24h收益，完整所有估计量与CI保留在results.json。insufficient子组不可用于挑选策略。\n\n";
text += table(
  [
    "人 / 币 / 多空 / UTC",
    "机会",
    "24h完整",
    "净方向24h bps / CI",
    "净时机24h bps / CI",
  ],
  Object.entries(r.attribution.strata)
    .sort()
    .map(([key, x]) => [
      key.replaceAll("|", " / "),
      x.n,
      x.full_24h,
      est(x.net_forward_24h_bps),
      est(x.net_timing_24h_bps),
    ]),
);
writeFileSync("docs/research/trader-study-2026-09-12.md", text.trimEnd() + "\n");
console.log("report written");
