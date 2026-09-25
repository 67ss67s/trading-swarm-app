# 交易页(#trade)重排 — 2026-09-06(Codex astra 稿 内部评审记录 + 处置)

背景:Jacky 反馈策略线程栏大多数时候是空的却占 320px;要么空时自动收,要么把过去的线程显示出来;整页看有没有重排方案,功能全保留;顺带找还能优化的点。

## 1. 已落地(23ad40c + 本提交)

- 线程栏:**成功加载且进行中为 0** 才自动收成 32px 竖条(显示「策略线程 · 0 / 已结束 N」),失败或加载中不收;手动收放记本机 `tg.trade.threads.open`。展开时空态填最近 8 条已结束线程(只读、可选中在「策略」tab 看论点、带「复盘 →」),有进行中时已结束折在下面。
- Codex 优化 1:图表左侧币种列表给名单里「只观察」的币打「观」标(和 Agent 页名单表、筛选页同口径)。
- Codex 优化 4(一半):线程列表区分「读取失败」与「空」。

## 2. Codex 两个重排方案与处置

- **方案 A**(线程轨 | 详情 | 下单右侧;账户底部):线程按需展开 = 我已做的折叠;但把下单挪到右侧没有收益(8794 和本仓库都是左下单,肌肉记忆),**不照做**。
- **方案 B(Codex 推荐)**:线程并入底部工作区,和持仓/挂单做成三 tab,上半区只剩 详情/币种 + 下单,两种宽度都稳定释放 320px。代价是线程和持仓不能同屏,tab 上要常显进行中条数与 attention 计数。**待 Jacky 拍板**:折叠版已经把空态时的 320px 拿回来了,B 只在「有进行中线程时也想要更宽的图」这一场景多赢;要做的话线程行需要横向化(一行一线程),ThreadRow 改造量中等。

## 3. 其余优化建议(未做,按价值排序)

2. 行情缺失 vs 过期分开显示,超 3 分钟标陈旧(SymbolRow/OrderPanel)——对齐楼层的数据时间口径。
5. 限价单按输入价估算数量/名义而不是按现价;提交按钮旁常显执行通道(OrderPanel)。
3. 「问 agent」页内预填并保留草稿;切币清旧价(ChatPanel/TradePage)。
4 另一半. 异常线程置顶 + 文字徽章;账户表也区分失败/空;键盘选行。

## 4. 楼层素材图(Jacky 问能不能用 gpt-image 出图)

本机没有图片生成通道(无 OpenAI key / 无 gpt-image CLI,Codex 只读图不出图),我做不了;给一段可直接贴到 ChatGPT gpt-image 的提示词,出图后放 `packages/webui/public/floor/deck-art.png`,floor.css 里 `.of-deck` 加一层 `url(/floor/deck-art.png)` 低透明度(≤ 25%)背景即可,层序在走道之下、桌子之上不改。
提示词(英文,便于模型出 blender 味):
"Top-down isometric-free, straight overhead view of a dark sci-fi trading operations floor, rendered like a Blender Eevee scene: matte black floor panels with subtle hex micro-texture, two vertical and one horizontal recessed walkways with thin neon-green (#9be15d) edge lighting, faint volumetric glow, empty (no desks, no people, no text), 16:9, muted, low contrast, suitable as a background layer under UI elements." 四套配色各出一张时把 #9be15d 换成 amber #f5b544 / ice #7cd4fd / paper 用浅底 #f4f1ea + 深绿描边。注意 Codex 的硬约束仍成立:图只能是静态、低反差、不带任何可读文字或箭头。
