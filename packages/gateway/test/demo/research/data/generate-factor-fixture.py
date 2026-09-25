"""Independent NumPy 2.0.2 OLS/population-risk fixture; no market or model calls.
Run: python3 generate-factor-fixture.py > factor-numpy.json
"""
import json
import numpy as np
n=180
x=np.array([((i*17)%31-15)*.0007 for i in range(n)])
y=np.array([.00013+1.27*x[i]+((i*7)%13-6)*.00011 for i in range(n)])
coef=np.linalg.lstsq(np.column_stack([np.ones(n),x]),y,rcond=None)[0]
r=y-coef[1]*x
ppy=8760
def metrics(v,m):
    cum=np.cumsum(v); dd=1-np.exp(cum-np.maximum.accumulate(np.r_[0,cum])[1:])
    down=np.sqrt(np.mean(np.minimum(v,0)**2)); tracking=np.std(v-m)
    return dict(total_return=float(np.expm1(v.sum())),max_drawdown=float(dd.max()),drawdown_area=float(dd.mean()),ulcer_index=float(np.sqrt(np.mean(dd**2))),sharpe=float(v.mean()/v.std()*np.sqrt(ppy)),sortino=float(v.mean()/down*np.sqrt(ppy)) if down>0 else None,information_ratio=float((v-m).mean()/tracking*np.sqrt(ppy)) if tracking>1e-12 else None,volatility=float(v.std()*np.sqrt(ppy)))
rolling=[]
for end in [60,101,180]:
    xx=x[end-60:end]; yy=y[end-60:end]
    c=np.linalg.lstsq(np.column_stack([np.ones(60),xx]),yy,rcond=None)[0]
    rolling.append(dict(at_index=end-1,beta=float(c[1]),alpha_annualized=float(c[0]*ppy),r2=float(1-np.sum((yy-c[0]-c[1]*xx)**2)/np.sum((yy-yy.mean())**2))))
print(json.dumps(dict(rolling=rolling,provenance='synthetic fixture; NumPy '+np.__version__+' linalg.lstsq, ddof=0',returns=y.tolist(),market_returns=x.tolist(),window_bars=60,periods_per_year=ppy,expected=dict(beta=float(coef[1]),alpha_per_bar=float(coef[0]),alpha_annualized=float(coef[0]*ppy),r2=float(1-np.sum((y-coef[0]-coef[1]*x)**2)/np.sum((y-y.mean())**2)),raw=metrics(y,x),residual=metrics(r,np.zeros(n)))),indent=2))
