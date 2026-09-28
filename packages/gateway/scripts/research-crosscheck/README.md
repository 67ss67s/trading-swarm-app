# 第三轮独立数值对账

先构建 gateway，运行 Node 导出同一 OHLCV、donchian 参数、逐笔成交和 TS 结构输出；Python 只在 `/tmp` venv，不进生产依赖。脚本不会联网或下单。

```sh
npm run build -w @trade-gate/gateway
node packages/gateway/scripts/research-crosscheck/export-fixture.mjs /tmp/research-r3-crosscheck
python3 -m venv /tmp/research-r3-python
/tmp/research-r3-python/bin/pip install smartmoneyconcepts backtesting empyrical
/tmp/research-r3-python/bin/python packages/gateway/scripts/research-crosscheck/compare.py /tmp/research-r3-crosscheck
```

`comparison.json` 记录库版本、逐笔差异、同频率指标与结构差异；`structure-python.json` 保存 swing、BOS BrokenIndex 和 OB 区间原始 fixture。不将外部库装不上视作对账成功。`rerun-acceptance.mjs` 是原 c0d3448b 的独立真实模型复跑入口，只读源库，新幂等键和结果写指定输出目录。
