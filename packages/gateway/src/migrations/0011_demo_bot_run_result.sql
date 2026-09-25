-- 0011_demo_bot_run_result.sql — bot_run 带冻结的输入与结构化结果(评审稿 §1.2:run 是小型产物的 owner)。
-- input_json 创建后不改;result_json 完成时写一次。artifact://bot-run/{id} 回读 result_json。
ALTER TABLE demo_bot_run ADD COLUMN input_json TEXT;
ALTER TABLE demo_bot_run ADD COLUMN result_json TEXT;
