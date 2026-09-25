# 第三方打分 agent 的任务书(2026-09-03)

你是独立评审,对 trading-swarm 仓库里两套互不相识的 eval 实现打分:`packages/eval-a`(实现 A)与 `packages/eval-b`(实现 B)。规格在 `docs/eval/README.md`,打分表在 `docs/eval/grading-rubric.md`(10 项,每项 0-5,写依据)。你**不许**修改任何一方的代码;只能读、跑、注入。

必须实际动手的检查(不看文档、看行为):
1. 各跑一遍 `npm run build --workspace packages/eval-<x>` 和 `npm test --workspace packages/eval-<x>`(从仓库根目录),记录用时与通过数。
2. 各跑一遍 `run --brain stub` 两次到不同目录,`diff -r` 两次的 `report.json`(去掉时间戳字段)是否完全一致;`run` 期间用 `TG_DEMO_MARKET_BASE=http://127.0.0.1:9` 之类的假地址证明零网络。
3. 注入测试:复制一个 case,把 hidden.future_klines 里某根的收盘价写进 visible 的某条 K 线里(或直接改 as_of 使某根 close_time > as_of),看 `future_leakage` 是否变 FAIL;再复制一个 review case,让桩输出 PROPOSE(或把 visible 改成 halted 后看 stale/unauthorized),看是否被抓;伪造 `evidence_refs: ['E999']`。写出每次注入的命令和结果。
4. 镜像正确性:随机挑 2 个 mirror case,用脚本核对 p → 2p₀ − p、高低互换、量不变、as_of 相同。
5. outcome 手算:挑 1 个 PROPOSE 的 episode,按 hidden.future_klines 手算 R,与 report 的数值比对。
6. 读两边 README 的「已知局限 / NOT_IMPLEMENTED」,逐条对照代码是否属实。
7. 如果某一方有 `runs/pi-*` 的报告,比较两边 pi 报告的口径差异(同样的 case 集下动作分布、闸拒率、对称率为何不同)。

产出 `docs/eval/grading-2026-09-03.md`:两张 10 项打分表(依据引用 file:line 或命令输出)、总分、每方 3 个最强 / 3 个最弱、你的采用建议(用 A / 用 B / 合并:哪些模块取谁),以及对 harness(不是 eval)本身的 5 条改进建议——从两边报告里读出来的、关于判断链的真实问题。中文,≤ 250 行。
