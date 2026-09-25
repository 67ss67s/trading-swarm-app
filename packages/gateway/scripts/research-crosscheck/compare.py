"""Run in /tmp venv with smartmoneyconcepts, backtesting and empyrical.
Produces real library measurements; missing libraries fail explicitly (no synthetic pass).
"""
import json, sys, math, importlib.metadata
from pathlib import Path
import numpy as np
import pandas as pd
from backtesting import Backtest, Strategy
import empyrical
from smartmoneyconcepts import smc
root = Path(sys.argv[1] if len(sys.argv)>1 else '/tmp/research-r3-crosscheck')
f=json.loads((root/'fixture.json').read_text()); bars=f['dataset']['bars']; r=f['request']; p=r['policy']; ex=r['execution']; gateway=json.loads((root/'gateway.json').read_text())['arms'][0]
df=pd.DataFrame(bars); df.index=pd.to_datetime(df.open_time,unit='ms',utc=True)
ohlc=df[['open','high','low','close','volume']].astype(float)
class Donchian(Strategy):
    def init(self): pass
    def next(self):
        i=len(self.data.Close)-1
        if i<30 or i==len(bars)-1 or self.position: return
        n=p['lookback']; close=float(self.data.Close[-1]); prior_high=np.asarray(self.data.High[-n-1:-1]); prior_vol=np.asarray(self.data.Volume[-n-1:-1])
        if close<=prior_high.max() or float(self.data.Volume[-1])<prior_vol.mean()*p['volume_multiple']: return
        h=np.asarray(self.data.High[-p['atr_period']:]); l=np.asarray(self.data.Low[-p['atr_period']:]); prev=np.asarray(self.data.Close[-p['atr_period']-1:-1])
        distance=np.maximum.reduce([h-l,abs(h-prev),abs(l-prev)]).mean()*p['stop_atr']; stop=close-distance; target=close+distance*p['take_profit_r']
        # Fixture next-open equals this close, so next-open sizing uses no extra information.
        size=math.floor(min(self.equity*float(ex['risk_fraction'])/distance,self.equity*float(ex['max_allocation'])/close,self.equity/(close*(1+float(ex['fee_rate'])))))
        if size>0 and stop>0:self.buy(size=size,sl=stop,tp=target)
reference=Backtest(ohlc.rename(columns=str.title),Donchian,cash=float(ex['initial_cash']),commission=float(ex['fee_rate']),trade_on_close=False,exclusive_orders=True,finalize_trades=False).run()
ref=[]
for _,t in reference['_trades'].iterrows():
    i=int(t['ExitBar']); row=bars[i]
    # Gateway protective intrabar timestamps are close_time, gap timestamps open_time.
    ref.append(dict(entry_at=int(t['EntryTime'].timestamp()*1000),entry_price=float(t['EntryPrice']),exit_bar=i,exit_price=float(t['ExitPrice']),qty=float(t['Size']),net_pnl=float(t['PnL'])))
differences=[]
for i in range(max(len(ref),len(gateway['trades']))):
    if i>=len(ref) or i>=len(gateway['trades']):differences.append({'trade':i,'reason':'trade_count_mismatch'});continue
    a=gateway['trades'][i];b=ref[i];fields={}
    for k in ['entry_at','entry_price','exit_price','qty','net_pnl']:
        if not math.isclose(float(a[k]),float(b[k]),rel_tol=1e-8,abs_tol=1e-6):fields[k]={'gateway':a[k],'reference':b[k]}
    gateway_exit_bar=(a['exit_at']-bars[0]['open_time'])//f['dataset']['timeframe_ms']
    if gateway_exit_bar!=b['exit_bar']:fields['exit_bar']={'gateway':gateway_exit_bar,'reference':b['exit_bar']}
    if fields:differences.append({'trade':i,'fields':fields})
eq=pd.Series([float(e['equity']) for e in gateway['equity']],index=pd.to_datetime([e['at'] for e in gateway['equity']],unit='ms',utc=True));days=eq.resample('1D').last().dropna();returns=days.iloc[1:-1].pct_change().dropna()
metrics={'gateway':gateway['metrics'],'empyrical_daily_sharpe':float(empyrical.sharpe_ratio(returns,annualization=365)),'empyrical_max_drawdown_same_bar_clock':float(-empyrical.max_drawdown(eq.pct_change().dropna())),'annualization':365,'daily_window':'complete interior UTC days; sample std ddof=1; zero risk-free'}
swings=smc.swing_highs_lows(ohlc,swing_length=3);bos=smc.bos_choch(ohlc,swings,close_break=True);ob=smc.ob(ohlc,swings,close_mitigation=False)
structure_ref={'swings':json.loads(swings.to_json(orient='records')),'bos':json.loads(bos.to_json(orient='records')),'order_blocks':json.loads(ob.to_json(orient='records'))}
(root/'structure-python.json').write_text(json.dumps(structure_ref,indent=2))
ts=json.loads((root/'structure-ts.json').read_text());swing_diffs=[]
py_swings={(i,'high' if x['HighLow']==1 else 'low'):x['Level'] for i,x in enumerate(structure_ref['swings']) if x['HighLow'] is not None}
ts_swings={(x['index'],x['kind']):float(x['price']) for x in ts['pivots']}
for key in sorted(set(py_swings)|set(ts_swings)):
    if py_swings.get(key)!=ts_swings.get(key):swing_diffs.append({'index':key[0],'kind':key[1],'python':py_swings.get(key),'ts':ts_swings.get(key)})
result={'versions':{name:importlib.metadata.version(name) for name in ['smartmoneyconcepts','backtesting','empyrical','numpy','pandas']},'trades':{'gateway':len(gateway['trades']),'reference':len(ref),'differences':differences},'metrics':metrics,'structure':{'pivot_differences':swing_diffs,'ts_bos':ts['breaks'],'ts_blocks':ts['blocks'],'reference_file':'structure-python.json','note':'Python full-history pivot cleanup and BOS four-pivot sequence differ from causal last-confirmed-level breaks. OB Python extremal candle differs from requested last opposite candle. No claim of equality.'}}
(root/'comparison.json').write_text(json.dumps(result,indent=2,allow_nan=False));print(json.dumps({'trade_differences':len(differences),'pivot_differences':len(swing_diffs)}))
