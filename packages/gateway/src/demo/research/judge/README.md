# IR 判断要素

JSON Schema (`packages/contracts/schema/research.json`) 是契约源。`judgeCandidate` 固定首次响应、决策与费用；回测/运行器同用 `judgeWithBars`。凭证由外部 provider 构造，本目录不读凭证文件。

- `judge_answers_v1` 保留 1e-6；显式新 profile 可选 `judge_answers_v2_rounding_001`：完整合法分布 |sum−1|≤0.01（数值 epsilon 1e-12），按 sum 归一。不得改写已有 profile/结果。真实51条偏差尚待脱敏导出验证，默认不自动迁移。
- `diagnostics.ts` 输出命中分布/ref、偏差和 unknown 费用分类。`jev-diagnostics.mjs` 接受脱敏导出的 `{responses:[{request_hash,raw_json,error_code}]}`，不访问运行库。
- `microstructure.ts` 是纯函数：±0.5% midpoint 内所见档位名义额不平衡 `(bid−ask)/(bid+ask)`，最大单档墙 `{price,notional}`，价差 bps；5分钟清算按被清算持仓 long/short 分组。金额用12位定点算术与十进制字符串，数量是基础币，合约张数必须先乘冻结 `ctVal`。盘口最多120秒陈旧，事件时间/可用时间不得晚于 as_of。
- 清算缺覆盖证明不填0。200档以外不可见，结果是所录深度统计。旧 recorder 缺响应接收时间，读取器要求显式整个轮询循环延迟上界；缺清算成功轮询心跳，不能从稀疏事件推断覆盖。`recordings.ts` 用 `Z_SYNC_FLUSH` 读未结束 gzip，半行丢弃，损坏数据仍拒绝。旧清算无原生事件ID时用时间/方向/价量去重，有合并同值独立事件的损失。
- `templates.ts` 固定六个模板；默认 take+quality 与原规则一致。价位用候选 reference/stop/target 和最近已确认2+2摆动支撑阻力，缺价位不编造。价位事件固定未来15分钟；不是利润概率，阈值未经实证校准。
- matrix 的 `judge_templates:[{templates:[...],rule?,microstructure?}]` 在冻结 manifest 时展开。组合先独立训练评估，各计一次 trial，按训练Sharpe/稳定ID选胜者后才评选择段；每个代码参数变体单独选一次。迭代继承已选 judge，不从选择段重新调模板/阈值。

```sh
npx vitest run packages/gateway/test/demo/research/study packages/gateway/test/demo/research/matrix-study --maxWorkers=1 --testTimeout=30000
node packages/gateway/scripts/research-study-eval/jev-diagnostics.mjs --input /tmp/sanitized-responses.json --output /tmp/jev-diagnostics.json
```

运行接线与G3命令：`docs/research/jev-adapt-v2-2026-09-25.md`。
