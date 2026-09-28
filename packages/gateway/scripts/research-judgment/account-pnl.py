# 用法:python3 packages/gateway/scripts/research-judgment/account-pnl.py <manifest_id> [trail|plan]
# 把 judgment replay 的逐事件 R 换成真实账户 PnL:$10k 起,每笔风险 1% 权益(仓位=风险/止损距离),单笔名义不超过权益,
# 现货总名义不超过权益(满仓后新信号跳过),复利;按时间顺序开平仓(同一时刻按事件 id)。每段行情分开算(两段不连续)。
# TS 版在 src/demo/research/judgment-replay/account.ts,判断回放 report 里直接出这张表;两边数字应一致。
import sqlite3, json, sys, os
db = sqlite3.connect(os.path.expanduser('~/.trade-gate-okx/research/judgment-replay/jr.sqlite'))
M = sys.argv[1]; MGMT = sys.argv[2] if len(sys.argv) > 2 else 'trail'; RISK = 0.01
man = json.loads(db.execute("select json from manifests where id=?", (M,)).fetchone()[0])
evs = {r[0]: json.loads(r[1]) for r in db.execute("select id, event_json from events where manifest_id=?", (M,))}
dec = {}
for eid, arm, dj in db.execute("select event_id, arm, decision_json from decisions where manifest_id=?", (M,)):
    dec.setdefault(arm, {})[eid] = json.loads(dj).get('follow') is True
H = 3600_000
def run(ids, arm_label, perp):
    out = {}
    for p in man['periods']:
        eq = 10000.0; open_ = []; n = 0; peak = eq; mdd = 0
        evl = sorted([evs[i] for i in ids if evs[i]['period'] == p['id']], key=lambda e: (e['as_of'], e['id']))  # 同一时刻按事件 id 定序:set 迭代顺序随 PYTHONHASHSEED 变,现货满仓时会让结果差几个百分点
        timeline = []
        for e in evl:
            s = e[MGMT]
            if s.get('status') in (None, 'no_fill', 'skipped'): continue
            timeline.append((e['as_of'], e, s))
        # 事件驱动:先平掉到期的,再开新的
        closes = []
        for at, e, s in timeline:
            for c in sorted([c for c in open_ if c['exit'] <= at], key=lambda c: c['exit']):
                eq += c['pnl']; open_.remove(c); peak = max(peak, eq); mdd = max(mdd, 1 - eq / peak)
            stop_pct = abs(e['ref_close'] - e['stop']) / e['ref_close']
            risk_usd = eq * RISK; notional = risk_usd / stop_pct
            cap = eq if not perp else eq * 3
            used = sum(c['notional'] for c in open_)
            notional = min(notional, eq)                      # 单笔名义不超过权益(现货不加杠杆)
            if used + notional > cap: continue                # 满仓跳过
            pnl = s['net_r'] * risk_usd * (notional / (risk_usd / stop_pct))
            open_.append({'exit': at + s['bars_held'] * H, 'pnl': pnl, 'notional': notional}); n += 1
        for c in sorted(open_, key=lambda c: c['exit']): eq += c['pnl']; peak = max(peak, eq); mdd = max(mdd, 1 - eq / peak)
        out[p['id']] = (eq / 10000 - 1, n, mdd)
    return out
def hold(pid):
    p = [x for x in man['periods'] if x['id'] == pid][0]; rets = []
    for sym, bj in db.execute("select symbol, bars_json from datasets where venue=?", (man.get('venue', 'spot'),)):
        bars = [b for b in json.loads(bj) if p['from'] <= b['close_time'] <= p['to']]
        if bars: rets.append(float(bars[-1]['close']) / float(bars[0]['open']) - 1)
    return sum(rets) / len(rets)
perp = man.get('venue') == 'perp'
subset = set(dec.get('B2', {}).keys()) or set(evs)
arms = {'A 全做': [i for i in subset], 'A_f 均线同向': [i for i in subset if evs[i]['trend_ok']]}
for a in ('B', 'B2'):
    if a in dec: arms[f'{a} 模型跟单'] = [i for i in subset if dec[a].get(i)]
print(f'{M} 管仓={MGMT} 事件子集={len(subset)}(模型跑过的那批),每笔风险 1% 权益,$10k 起')
for name, ids in arms.items():
    r = run(ids, name, perp)
    print(f'  {name:12s}', '  '.join(f"{pid}: {v[0]*100:+.1f}% ({v[1]} 笔, 最大回撤 {v[2]*100:.1f}%)" for pid, v in r.items()))
print('  等权持有 6 币', '  '.join(f"{p['id']}: {hold(p['id'])*100:+.1f}%" for p in man['periods']))
