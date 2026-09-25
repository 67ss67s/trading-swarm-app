-- 市场是独立维度，旧数据按永续解释。
ALTER TABLE demo_threads ADD COLUMN market TEXT NOT NULL DEFAULT 'perp';
ALTER TABLE demo_threads ADD COLUMN pair_id TEXT NULL;
ALTER TABLE demo_intents ADD COLUMN market TEXT NOT NULL DEFAULT 'perp';
ALTER TABLE events ADD COLUMN market TEXT NULL;
ALTER TABLE demo_activity ADD COLUMN market TEXT NULL;
-- 旧实现将凭据存在 demo_kv；显式关系表保留复合唯一性，KV 接口兼容现有调用方。
CREATE TABLE protection_credentials (
 channel TEXT NOT NULL, symbol TEXT NOT NULL DEFAULT '', market TEXT NOT NULL DEFAULT 'perp', json TEXT NOT NULL,
 PRIMARY KEY(channel, symbol, market)
);
INSERT OR IGNORE INTO protection_credentials(channel,symbol,market,json)
 SELECT json_extract(j.value,'$.channel'), coalesce(json_extract(j.value,'$.symbol'),''),
 coalesce(json_extract(j.value,'$.market'),'perp'), json_set(j.value,'$.market',coalesce(json_extract(j.value,'$.market'),'perp'))
 FROM demo_kv kv, json_each(CASE WHEN json_valid(kv.value) THEN kv.value ELSE '[]' END) j WHERE kv.key='protection_credentials' AND json_valid(kv.value);

ALTER TABLE demo_trader_signal ADD COLUMN kind TEXT NULL;
ALTER TABLE demo_trader_signal ADD COLUMN reason TEXT NULL;
ALTER TABLE demo_trader_signal ADD COLUMN arbitrage_json TEXT NULL;
