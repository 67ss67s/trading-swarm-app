#!/usr/bin/env python3
"""切换 OKX 账户模式(acctLv):1 简单 / 2 单币种保证金 / 3 跨币种保证金 / 4 组合保证金。

用法:python3 scripts/okx-set-account-level.py [acctLv] [--profile <name>]
读 ~/.okx/config.toml 的 profile(默认 default_profile),本地签名直接打 OKX v5
POST /api/v5/account/set-account-level(okx CLI 1.4.7 没封装这个端点)。
demo profile 自动带 x-simulated-trading 头。先打印切换前后的 account config。
"""
import base64, datetime, hashlib, hmac, json, re, sys, urllib.request


def load_toml(path):
    """够用的极简 TOML 解析(okx config 只有 [profiles.x] 段 + key = "value"),老 python 没有 tomllib。"""
    try:
        import tomllib  # py>=3.11
        return tomllib.load(open(path, 'rb'))
    except ImportError:
        pass
    root, cur = {}, None
    for line in open(path, encoding='utf-8'):
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        m = re.match(r'^\[(.+)\]$', line)
        if m:
            cur = root
            for part in m.group(1).split('.'):
                cur = cur.setdefault(part, {})
            continue
        m = re.match(r'^([A-Za-z0-9_-]+)\s*=\s*(.+)$', line)
        if not m:
            continue
        k, v = m.group(1), m.group(2).strip()
        if v[:1] in ('"', "'"):
            end = v.find(v[0], 1)
            v = v[1:end] if end > 0 else v[1:]
        else:
            v = v.split('#', 1)[0].strip()
            if v in ('true', 'false'):
                v = v == 'true'
        (cur if cur is not None else root)[k] = v
    return root

args = [a for a in sys.argv[1:] if not a.startswith('--')]
lv = args[0] if args else '2'
prof = None
if '--profile' in sys.argv:
    prof = sys.argv[sys.argv.index('--profile') + 1]
cfg = load_toml('~/.okx/config.toml')
prof = prof or cfg['default_profile']
p = cfg['profiles'][prof]
demo = str(p.get('demo', 'false')).lower() == 'true'
BASE = 'https://www.okx.com'


def call(method, path, body=None):
    ts = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    raw = json.dumps(body) if body is not None else ''
    sig = base64.b64encode(hmac.new(p['secret_key'].encode(), (ts + method + path + raw).encode(), hashlib.sha256).digest()).decode()
    h = {'OK-ACCESS-KEY': p['api_key'], 'OK-ACCESS-SIGN': sig, 'OK-ACCESS-TIMESTAMP': ts,
         'OK-ACCESS-PASSPHRASE': p['passphrase'], 'Content-Type': 'application/json',
         'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (okx-set-account-level)'}
    if demo:
        h['x-simulated-trading'] = '1'
    req = urllib.request.Request(BASE + path, data=raw.encode() if body is not None else None, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        raw = e.read().decode('utf-8', 'replace')
        try:
            return json.loads(raw)
        except ValueError:
            return {'code': str(e.code), 'msg': f'HTTP {e.code} non-JSON: {raw[:300]!r}', 'data': []}


print(f'profile={prof} demo={demo}')
before = call('GET', '/api/v5/account/config')
print('before acctLv =', before.get('data', [{}])[0].get('acctLv'), before.get('msg', ''))
res = call('POST', '/api/v5/account/set-account-level', {'acctLv': str(lv)})
print('set-account-level →', json.dumps(res, ensure_ascii=False))
after = call('GET', '/api/v5/account/config')
print('after acctLv =', after.get('data', [{}])[0].get('acctLv'), after.get('msg', ''))
