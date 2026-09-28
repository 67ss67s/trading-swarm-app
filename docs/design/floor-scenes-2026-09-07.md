# 楼层 v3:三场景可切换(2026-09-07)

来源:`~/Downloads/trade_gate_pixel_ui_design.ipynb`(三张概念图 + implementation brief)。Jacky 拍板:三个方向都做、可切换;Codex(gpt-6-astra,effort high)落地,主线 merge。

## 落地形态
- **场景 = 视觉皮肤,不是三套页面**。`components/floor/scenes.ts` 注册 command(指挥中心)/ research(研究楼层)/ meme(霓虹实验室);`prefs.scene` 存 localStorage,切场景连带切推荐配色(terminal / wood / neon),配色仍可单独改。入口:楼层顶栏三段开关 + 设置页「楼层外观」。
- **共享层(任务 A,分支 floor-scene-command)**:`station.tsx` 工作台(显示器 + 键盘 + 台灯 + 状态 LED + 道具;屏幕只画真实 presence / 步骤)、`handoff-overlay.tsx`(真交接新建 / ack 时 1.1s 短连线 + 两端高亮,首次加载建基线不回放历史,爆发只播最新 3 条,reduce-motion 不画线)、`ambient.tsx`(常驻动画预算四处:HELM 核心、RADAR 光标、一个 LED、LAB 桌灯)。floor.css 顶部 13 个皮肤变量(`--of-floor-*` / `--of-desk-*` / `--of-lamp` / `--of-screen-*` / `--of-room-light` / `--of-core-glow`)是场景覆盖点。
- **场景层(任务 B/C)**:各自只有一个 `scene-<id>.css`,全部选择器挂 `.of-scene-<id>` 前缀。research:木地板 + 窗景夜城 + 两侧书架 + HELM 圆桌与唯一地毯 + 木牌分区;meme:瓷砖地 + 两侧霓虹灯管(16s opacity 呼吸)+ 弧形操作台 + 霓虹分区字。
- **被拿掉的**:待机随机踱步(motion.ts 的 stroll)。Codex 判它与「不随机动」矛盾且吃动效预算,走动只剩真交接 / ack。Jacky 若想要「角色会动」的感觉,应加有证据的走动而不是恢复随机。

## 不照做 / 边界
- notebook 要的「桌间 handoff 连线」只做**事件态**(≤1.5s),常驻连线仍禁止(09-06 Codex 口径:会被读成权限路线)。
- 不上 framer-motion / PixiJS,零新依赖;数据 UI 全在 DOM。
- 三个 Codex 任务都被额度掐过:A 的房间光影 / 桌面尺寸打磨、C 的自测与报告没做完;主线合并后自己截图验收并修了图例压桌牌、research 的 `.of-big::after` 与共享选中框冲突(灯光晕改挂 `.of-council-core`)。

## 未做
- 1280×800 下楼层 `minHeight: 420` 会裁底(B 报告)。
- 楼层文案接 i18n(其余页面由 Opus 代理做了 `lib/i18n.ts`)。
- 场景切换在窄屏(<1350)的走道 / 桌子挤压复核。
