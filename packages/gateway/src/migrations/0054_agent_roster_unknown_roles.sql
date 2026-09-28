-- 0052 已在 18811 应用(冻结不改)。补一条:role 不在九个 agent 里的遗留会话也归档(消息不动)。0053 是 jev 实盘判断账本。
UPDATE demo_chat_session SET archived = 1
WHERE role IS NOT NULL AND id <> 'default'
  AND role NOT IN ('gate_captain','radar','thread_manager','strategy_lab','portfolio_manager','risk_sentinel','reviewer','executor','asp_agent');
