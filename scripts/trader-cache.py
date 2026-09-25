"""公开行情补齐：环境代理、每请求至少 1s、重试、原子续写；不打开运行数据库。"""
import csv, io, zipfile, hashlib
import argparse, datetime as dt, json, os, pathlib, subprocess, time, urllib.parse
DAY=86400000
TFS={'1m':60000,'5m':300000,'15m':900000,'1h':3600000,'4h':14400000,'1d':DAY}
p=argparse.ArgumentParser();p.add_argument('--root',default=os.path.expanduser('~/.trading-swarm/demo'));p.add_argument('--to',type=int,default=1789257600000);p.add_argument('--symbols');p.add_argument('--fine',action='store_true');a=p.parse_args()
a.to=min(a.to,int(time.time()*1000)//60000*60000)
root=pathlib.Path(a.root); research=root/'research-traders';research.mkdir(parents=True,exist_ok=True);(root/'klines').mkdir(exist_ok=True)
def atomic(path,data):
 tmp=path.with_suffix(path.suffix+'.traders.tmp');tmp.write_text(json.dumps(data,separators=(',',':')));tmp.replace(path)
def read(path,default):
 try:return json.loads(path.read_text())
 except FileNotFoundError:return default
last=0
def request(route):
 global last
 for attempt in range(6):
  time.sleep(max(0,1-(time.monotonic()-last)));last=time.monotonic()
  r=subprocess.run(['curl','--silent','--show-error','--max-time','45','--write-out','\n%{http_code}','https://fapi.binance.com'+route],capture_output=True,text=True)
  body,_,status=r.stdout.rpartition('\n')
  if r.returncode==0 and status=='200':return json.loads(body)
  if status=='400':return {'unavailable':True,'body':body}
  if attempt==5:raise RuntimeError(f'{route}: HTTP {status}: {r.stderr[:200]}')
  print(f'retry {attempt+1} HTTP {status}',flush=True);time.sleep(min(60,2**attempt*(30 if status=='429' else 2)))
info=request('/fapi/v1/exchangeInfo');atomic(research/'exchange-info.json',info)
symbols=sorted(set(a.symbols.split(',')) if a.symbols else {x['symbol'] for x in json.load(open('docs/research/data/traders-0912/structured_signals.json'))})
listed={s['symbol']:s for s in info['symbols']};atomic(research/'ticks.json',{s:next(f['tickSize'] for f in v['filters'] if f['filterType']=='PRICE_FILTER') for s,v in listed.items()})
coverage=[]; errors=[]
for symbol in symbols:
 if symbol not in listed:coverage.append({'symbol':symbol,'status':'not_in_current_exchange_info'});continue
 for tf in (['1m','5m'] if a.fine else ['15m','1h','4h','1d']):
  step=TFS[tf]; start=(a.to//DAY)*DAY-(441 if tf=='1d' else 211 if tf not in ['1m','5m'] else 116)*DAY;path=root/'klines'/f'{symbol}-{tf}.json';old=read(path,{'bars':[],'ranges':[]});bars={b['open_time']:b for b in old['bars']};ranges=[{'from':r['from'],'to':min(r['to'],a.to-1)} for r in old.get('ranges',[]) if r['from']<a.to]
  if tf=='1m':
   # 月档来自 Binance 公共 USD-M K 线归档；失败不标覆盖，后续 REST 补齐。
   for month in ['2026-05','2026-06','2026-07','2026-08']:
    mfrom=int(dt.datetime.strptime(month,'%Y-%m').replace(tzinfo=dt.timezone.utc).timestamp()*1000)
    mend=int((dt.datetime.strptime(month,'%Y-%m').replace(day=28)+dt.timedelta(days=4)).replace(day=1,tzinfo=dt.timezone.utc).timestamp()*1000)
    if any(r['from']<=max(start,mfrom) and r['to']>=mend-1 for r in ranges):continue
    archive=research/f'{symbol}-1m-{month}.zip'
    if not archive.exists():
     for attempt in range(3):
      time.sleep(1)
      proc=subprocess.run(['curl','--fail','--silent','--show-error','--max-time','45',f'https://data.binance.vision/data/futures/um/monthly/klines/{symbol}/1m/{symbol}-1m-{month}.zip','-o',str(archive)+'.tmp'],capture_output=True)
      if proc.returncode==0:pathlib.Path(str(archive)+'.tmp').replace(archive);break
      if b'404' in proc.stderr:break
      time.sleep(2**attempt)
    if archive.exists():
     try:
      with zipfile.ZipFile(archive) as z:
       rows=csv.reader(io.TextIOWrapper(z.open(z.namelist()[0])))
       got=[]
       for b in rows:
        if not b[0].isdigit():continue
        ot=int(b[0]);ct=int(b[6])
        if ot>=start and ct<a.to:
         bars[ot]=dict(open_time=ot,close_time=ct,open=b[1],high=b[2],low=b[3],close=b[4],volume=b[5]);got.append(ot)
       got.sort()
       # 只有实际连续数据能声明覆盖，不能把归档缺口涂掉。
       if got:
        lo=prev=got[0]
        for t in got[1:]:
         if t!=prev+step:ranges.append({'from':lo,'to':prev+step-1});lo=t
         prev=t
        ranges.append({'from':lo,'to':prev+step-1})
      print(symbol,month,'archive',len(got),flush=True)
     except (zipfile.BadZipFile,ValueError,IndexError) as e:print('archive rejected',symbol,month,str(e),flush=True)
  if tf=='5m':
   fine=read(root/'klines'/f'{symbol}-1m.json',{'bars':[]})['bars']; groups={}
   for b in fine:
    if b['open_time']>=start and b['close_time']<a.to:groups.setdefault(b['open_time']//step*step,[]).append(b)
   for at,bs in groups.items():
    bs.sort(key=lambda b:b['open_time'])
    if len(bs)!=5 or any(b['open_time']!=at+i*60000 for i,b in enumerate(bs)):continue
    from decimal import Decimal
    bars[at]=dict(open_time=at,close_time=at+step-1,open=bs[0]['open'],close=bs[-1]['close'],high=str(max(Decimal(b['high']) for b in bs)),low=str(min(Decimal(b['low']) for b in bs)),volume=str(sum(Decimal(b['volume']) for b in bs)))
    ranges.append({'from':at,'to':at+step-1})
  ranges=[]
  actual=sorted(t for t,b in bars.items() if b['close_time']<a.to and b['close_time']==t+step-1)
  if actual:
   lo=prev=actual[0]
   for t in actual[1:]:
    if t!=prev+step:ranges.append({'from':lo,'to':prev+step-1});lo=t
    prev=t
   ranges.append({'from':lo,'to':prev+step-1})
  onboard=int(listed[symbol].get('onboardDate',0));onboard=onboard//step*step
  if onboard>start:ranges.append({'from':start,'to':min(a.to,onboard)-1})
  # 已查询空区間（上市前）与逐页结果同样持久化。根内 range 不掩盖缺失整根。
  gaps=[];cursor=start
  for r in sorted(ranges,key=lambda x:x['from']):
   if r['to']<cursor:continue
   if r['from']>cursor:gaps.append((cursor,min(a.to-1,r['from']-1)))
   cursor=max(cursor,((r['to']+1)//step)*step)
  if cursor<a.to:gaps.append((cursor,a.to-1))
  try:
   for lo,hi in gaps:
    pos=lo
    while pos<=hi:
     rows=request('/fapi/v1/klines?'+urllib.parse.urlencode(dict(symbol=symbol,interval=tf,startTime=pos,endTime=hi,limit=1500)))
     if isinstance(rows,dict):raise RuntimeError(str(rows))
     if not rows:raise RuntimeError(f'empty_response_unconfirmed: {pos}..{hi}; no data coverage recorded')
     nxt=rows[-1][6]+1
     if nxt<=pos:raise RuntimeError('pagination stalled')
     for b in rows:
      if b[6]<a.to:bars[b[0]]=dict(open_time=b[0],open=str(b[1]),high=str(b[2]),low=str(b[3]),close=str(b[4]),volume=str(b[5]),close_time=b[6])
     for b in rows:
      if b[6]<a.to:ranges.append({'from':b[0],'to':b[6]})
     merged=[]
     for r in sorted(ranges,key=lambda x:x['from']):
      if merged and r['from']<=merged[-1]['to']+1:merged[-1]['to']=max(merged[-1]['to'],r['to'])
      else:merged.append(dict(r))
     ranges=merged;atomic(path,dict(symbol=symbol,tf=tf,bars=sorted(bars.values(),key=lambda b:b['open_time']),ranges=ranges));pos=nxt
    print(symbol,tf,'gap completed',lo,hi,flush=True)
  except Exception as e:errors.append({'symbol':symbol,'tf':tf,'error':str(e)});print(errors[-1],flush=True)
  atomic(path,dict(symbol=symbol,tf=tf,bars=sorted(bars.values(),key=lambda b:b['open_time']),ranges=ranges))
  n=sum(start<=b['open_time'] and b['close_time']<a.to for b in bars.values());coverage.append(dict(symbol=symbol,tf=tf,bars=n,expected=(a.to-start)//step));atomic(research/('fine-coverage.json' if a.fine else 'coverage.json'),dict(to=a.to,coverage=coverage,errors=errors))
 if not a.fine:
  path=research/f'{symbol}-funding.json';old=read(path,{'points':[],'to':a.to-211*DAY});points={x['at']:x for x in old['points']};pos=old['to']
  try:
   while pos<a.to:
    rows=request('/fapi/v1/fundingRate?'+urllib.parse.urlencode(dict(symbol=symbol,startTime=pos,endTime=a.to-1,limit=1000)))
    if not isinstance(rows,list):raise RuntimeError(str(rows))
    if not rows:pos=a.to;break
    for x in rows:points[x['fundingTime']]={'at':x['fundingTime'],'rate':str(x['fundingRate'])}
    pos=rows[-1]['fundingTime']+1
   atomic(path,{'points':sorted(points.values(),key=lambda x:x['at']),'to':a.to})
  except Exception as e:errors.append({'symbol':symbol,'tf':'funding','error':str(e)})
atomic(research/('fine-coverage.json' if a.fine else 'coverage.json'),dict(to=a.to,coverage=coverage,errors=errors))
if errors:raise SystemExit(1)
