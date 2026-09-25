"""只读核验精细缓存的已观测区间连续性；不联网、不打开数据库。"""
import json, os, pathlib
root = pathlib.Path(os.path.expanduser('~/.trading-swarm/demo'))
f = json.loads((root / 'research-traders/fine-coverage.json').read_text())
rows = []
for c in f['coverage']:
    if 'tf' not in c:
        continue
    data = json.loads((root / 'klines' / f"{c['symbol']}-{c['tf']}.json").read_text())['bars']
    step = 60000 if c['tf'] == '1m' else 300000
    bars = [b for b in data if 1779235200000 <= b['open_time'] and b['close_time'] < 1789171200000]
    rows.append({'symbol': c['symbol'], 'tf': c['tf'], 'bars': len(bars),
                 'interior_gaps': sum(b['open_time'] != a['open_time'] + step for a, b in zip(bars, bars[1:])),
                 'bad_close_time': sum(b['close_time'] != b['open_time'] + step - 1 for b in bars)})
output = {'from': 1779235200000, 'to': 1789171200000, 'request_errors': f['errors'],
          'not_in_current_info': [x['symbol'] for x in f['coverage'] if 'tf' not in x], 'rows': rows}
pathlib.Path('docs/research/data/traders-0912/cache-audit.json').write_text(json.dumps(output, indent=2) + '\n')
print('series', len(rows), 'gaps', sum(x['interior_gaps'] for x in rows),
      'bad close times', sum(x['bad_close_time'] for x in rows), 'errors', len(f['errors']))
