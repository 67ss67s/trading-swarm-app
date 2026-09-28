-- 全局用量/预算闸也在定时器上执行；保留实时精确统计，用覆盖表达式索引免读大 JSON。
CREATE INDEX idx_demo_episodes_usage_cover ON demo_episodes(
  at,
  COALESCE(json_extract(json, '$.model'), 'unknown'),
  COALESCE(json_extract(json, '$.usage.input_tokens'), 0),
  COALESCE(json_extract(json, '$.usage.output_tokens'), 0)
);
