# trade-gate WebUI 设计稿(A3 最小 UI)

- **Artifact(Claude Design 画布,15 个画板)**:https://claude.ai/code/artifact/64ca1855-93aa-4f80-a6e4-d658705bdf4b
- 日期:2026-09-02 · 依据:`docs/design/trade-gate-design-v1-2026-09-02.md` §1 / §3.5 / §4 / §5.1 / §6.2 / §10 / §14 / §15.1(A3 行)+ `docs/contracts/README.md` §4 + `packages/contracts/fixtures/**`
- 范围:只画 A3 最小 UI(向导、Exchange 健康、Portfolio、Trade、Funding、Intents 审批卡、Activity trace、Policy 紧急停、最小 K 线、Dashboard)。侧栏保留 §14 的三组全量导航,B 阶段页面灰显。**跟单不出现**。
- 画板源文件:`canvas/*.dc.html` + `canvas/canvas.json`,全部由 `canvas/build.mjs` 生成(改稿改生成器,不手改产物)。示例数据逐字取自 contracts fixtures(`awaiting_approval`、`plan_hash 4748…433c`、`usdm_perp`、金额十进制字符串、`tg-0f8fad5bd9cb-e0-1` 等);fixture 没覆盖到的状态(authorized / dispatching / expired / recorded 等)按同一字段形状补了示例行,不引入 schema 之外的字段。

## 画板清单与对应的控制面方法 / 事件

| # | 画板(文件) | 尺寸 | 控制面方法(§4 / §6.2) | 事件 |
|---|---|---|---|---|
| 1 | Dashboard 总览(`Main.dc.html`) | 1440×900 | `account.truth`(两账户合并)· `intents.list` · `strategies.list`(attention 桶,不可静音项 ORDER_STATE_UNKNOWN / PROTECTION_MISSING)· `exchange.status` · `policy.get` · `usage.summary` | `account.updated\|stale` · `intent.*` · `strategy.attention` · `exchange.auth.*` · `health` · `usage` |
| 2a | 向导 · 第 4 步 等待回调(`OnboardingOAuth.dc.html`) | 1440×900 | `wizard.start/next/status` · `exchange.oauth.start`(回环回调 :18801,PKCE,CIMD client_id)→ 浏览器 → `GET /oauth/callback`(只在向导期间监听) | `exchange.auth.pending` · `tick` |
| 2b | 向导 · 第 4 步 授权结果(`OnboardingOAuthDone.dc.html`) | 1440×900 | `exchange.oauth.complete` · `exchange.tools.snapshot`(tools/list 钉版 → tools_hash)· `account.truth`(子账户余额为 0 → 提示去 Binance UI 划转或 4b 后从 Funding 注资) | `exchange.auth.granted` · `exchange.tools.snapshot` |
| 2c | 向导 · 4b 主账户 API key(`OnboardingMainKey.dc.html`) | 1440×900 | `wizard.next{apiKey,secret}`(只到 execd,落盘 `secrets/apikey-main.json` 0600)· execd 权限探测(读 / 合约 / 子账户划转 / 提币=红色警示 / IP 白名单)· `sub-account/list` · `sub-account/assets` · `universalTransfer` dry-run(§3.5 三件事) | `exchange.credentials.probed` |
| 3 | Exchange 两通道健康(`Exchange.dc.html`) | 1440×900 | `exchange.status`(main:key 指纹 / 权限位 / 用户数据流 connected·stale / 时钟偏移 / RestGate / 单写者 lease;sub:OAuth fresh·expiring·expired·revoked / MCP 会话 / tools_hash vs 钉版 drift 红 / 子账户标识)· `exchange.oauth.start/complete/revoke` · `exchange.tools.snapshot` | `exchange.auth.*` · `exchange.tools.drift` · `health` |
| 4 | Portfolio 主+子合并(`Portfolio.dc.html`) | 1440×900 | `account.truth`(每组件 observed_at / fetched_from-to / completeness / source;consistency consistent·inconsistent·unavailable;account_version)· `orders.list` · `positions.list` | `account.updated\|stale` · `order.*` · `position.*` |
| 5 | Trade 主账户手动下单(`Trade.dc.html`) | 1440×900 | `tools.invoke intent.propose{kind open\|close, account main}`(principal=user, surface=rpc, origin `ui:trade-page`)→ plan 物化预览 → `intents.approve{plan_hash, confirm_echo}`;右栏状态流 dispatching → executing → completed / execution_unknown(按 clientOrderId 对账,禁新增敞口) | `intent.awaiting_approval → intent.approved → attempt.before_submit/acked\|unknown → order.observed → effect.evaluated` |
| 5b | 结构化确认弹层(`TradeConfirm.dc.html`) | 520×760 | `tables/confirm_fields.json` kind=order:symbol · side · qty · order_type · price · trigger_price(缺省不出现)· leverage · reduce_only + 永远回填 plan_hash;`exec.intent.authorize` 逐字比对,差异 → `conflict`(1006);TTL market 30 s / limit 120 s | — |
| 6 | Funding 划转 / 提币深链(`Funding.dc.html`) | 1440×900 | `tools.invoke intent.propose{kind transfer, asset, amount, from_account/from_wallet, to_account/to_wallet}`(principal=user)→ `intents.approve{confirm_echo: asset · amount · from_account · to_account · plan_hash}` · `account.history`;提币 = 打开 Binance 深链(Q7 默认) | `intent.*` · `attempt.*`(leg transfer,`tg-…-f0-1`) |
| 7 | Intents 审批卡(`Intents.dc.html`) | 1440×940 | `intents.list{status}` · `intents.get`(Intent + ExecutableOrderPlan + gate 结果)· `intents.approve`(超上限需 admin)· `intents.reject` · `intents.expire`;列表覆盖 11 种状态 | `intent.created/gated/awaiting_approval/approved/rejected/expired/submitted/reconciled` |
| 7b | 移动端审批卡(`IntentCardMobile.dc.html`) | 390×844 | 与 Telegram 卡片同口径:thesis / evidence_refs / 经济字段 / gate 摘要 / TTL / 回填 8 字段;按钮 48px | 同上 |
| 8 | Activity trace 回放(`Activity.dc.html`) | 1440×900 | `runs.list` · `runs.inspect`(trace_events + tool_calls + llm_usage,与 execd events 按 exec_seq 对齐)· `logs.tail`;时间线 context.built → model.called → tool.called → gate.evaluated → intent.* → attempt.* → order.observed → effect.evaluated | 全部 |
| 9 | Policy & 紧急停(`Policy.dc.html`) | 1440×900 | `policy.get` · `policy.set`(admin + confirm 字段逐字回填)· `policy.emergencyStop`;mode 四档 / authority 四档(live_capped 灰掉标「待 Q6」)/ caps 上限表 | `policy.changed` · `policy.halted` |
| 9b | 紧急停二次确认(`EmergencyStop.dc.html`) | 520×520 | `policy.emergencyStop`(输入 HALT)→ mode halt_all + emergency_stop=true + active 授权 revoked(emergency_stop);EmergencyReduce 与已确认保护腿保留 | `policy.halted` |
| 10 | Chart 最小 K 线(`Chart.dc.html`) | 1440×900 | `market.klines` · `market.subscribe` · `market.features` / `market.structure`(证据)· `intents.get` · `drawing.create/update/remove(role, state)` | `market.kline` · `market.tick` · `intent.*` |

画布上每个画板上方各有一张便签,写着同样的方法 / 事件对应,便于边看边对。

## 待 Jacky 拍板的视觉决策(≤5)

1. **气质与令牌**:借 8794 shadcn 变体「Graphite & Ice」——三层暗色地面(侧栏 `#05080b` → 背景 `#090d11` → 面板 `#10151a`,由其 oklch 令牌换算)、冰青 `#6fcadf` 只给界面 chrome、绿红只表达多空、数字全部等宽。是继续沿用这套(将来直接复用 8794 的 `index.css` 令牌),还是给 trade-gate 换一个强调色(例如冷紫)以区分两个产品?
2. **两账户的视觉约定**:main · REST = 石板灰 chip,sub · MCP = 冰青 chip(agent 的账户用产品强调色),全站一致。可选方案是用图标(用户 / 机器人)而不是颜色。
3. **暗色单主题**:设计稿只画了暗色;8794 有亮色变体。v1 是否需要亮色?若需要,令牌层已能直接翻译,但 K 线 role 调色要用 palette.ts 的 light 组。
4. **Trade 页的提交后状态流放在右栏**(与下单表单同屏),而不是弹窗 / 跳转 Intents 页。execution_unknown 的红色说明与「禁新增敞口 → 只允许 reduce_only」联动到表单顶部横幅。是否接受这种同屏布局?
5. **紧急停的形态**:顶栏常驻小按钮 + Policy 页的巨型红按钮 + 输入 HALT 的二次确认(沿用 8794 输入 LIVE 的红线做法)。是否还要在所有页面加全站横幅(触发后)与 ⌘K 里的快捷入口?

## 其他取舍(已按默认做,可改)

- 示例时刻定为 2026-09-02 19:53(fixture 时间戳 1788350000000 的北京时间)。Dashboard / Intents / Chart 在「BTCUSDT 提案待批」这一刻;Activity 回放延续到 19:55 的成交与对账;Exchange 页刻意选了 tools_hash 漂移 + OAuth expiring 的降级态,以展示告警样式。
- Funding 页把 `policy.main_account.transfers_enabled` 画成 true(fixture 里是 false)以展示可用流程;`withdraw_enabled=false` 与 Q7 一致,提币按钮是 Binance 深链。
- 手动下单表单用 reduce_only 的减仓单做例子,顺带展示 execution_unknown 期间「只允许风险降低」这条规则。

## 复现 / 改稿

```bash
cd docs/design/webui/canvas && node build.mjs      # 产出 *.dc.html + canvas.json
# 然后用 Claude Code 的 design 技能重新拼装并更新同一 Artifact(URL 见顶部)
```

生成器不依赖任何 npm 包;画板是静态 Design Components(无 tweak、无脚本),可在画布里直接选中改字改样式。
