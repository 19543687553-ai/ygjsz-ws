import json, base64, sys

PROTO = '/workspace/php-backend/sy_api/data/protocol.json'
CAP = '/workspace/.uploads/65F5B31A-8A9B-40EF-9EE8-8632B44577B9_ygcap-1792817756690.json'

m = json.load(open(PROTO))
m = m.get('messages', m)


def varint(b, i):
    r = 0; s = 0
    while True:
        x = b[i]; i += 1
        r |= (x & 0x7f) << s
        if not x & 0x80:
            return r, i
        s += 7


def one(name, f, v, depth):
    t = f['type']
    ref = f.get('ref')
    if t == 'object' and ref and isinstance(v, bytes):
        return dec_msg(ref, v, depth + 1) if depth < 8 else v.hex()
    if t == 'string' and isinstance(v, bytes):
        try:
            return v.decode('utf8')
        except Exception:
            return v.hex()
    if t == 'Map' and isinstance(v, bytes):
        k, j = varint(v, 0)
        ktag, kwt = k >> 3, k & 7
        if kwt == 0:
            kk, j = varint(v, j)
        else:
            kl, j = varint(v, j)
            kk = v[j:j + kl]
            j += kl
        vk, j = varint(v, j)
        vv, j = varint(v, j)
        return (kk, vv)
    return v if isinstance(v, int) else v.hex()


def dec_msg(name, b, depth=0):
    out = {}
    raw = {}
    i = 0
    fields = {f['tag']: f for f in m.get(name, [])}
    while i < len(b):
        key, i = varint(b, i)
        tag, wt = key >> 3, key & 7
        if wt == 0:
            v, i = varint(b, i)
        elif wt == 1:
            v = b[i:i + 8]; i += 8
        elif wt == 2:
            ln, i = varint(b, i)
            v = b[i:i + ln]; i += ln
        else:
            return {'__err': 'wt%d@%d' % (wt, i)}
        raw.setdefault(tag, []).append(v)
    for tag, vals in raw.items():
        f = fields.get(tag)
        nm = f['name'] if f else 'f%d' % tag
        if not f:
            out[nm] = vals[0] if len(vals) == 1 else [x if isinstance(x, int) else x.hex() for x in vals]
            continue
        if f.get('rule') == 'Repeated':
            out[nm] = [one(name, f, x, depth) for x in vals]
        else:
            v = one(name, f, vals[0], depth)
            if f.get('type') == 'Map':
                out.setdefault('map_' + nm, {})[str(v[0])] = v[1]
            else:
                out[nm] = v
    return out


cap = json.load(open(CAP))
found = None
for fr in cap['frames']:
    for r in fr.get('recs', []):
        if r.get('k') != 'ws_msg' or 'b' not in r:
            continue
        b = base64.b64decode(r['b'])
        if len(b) >= 9 and b[5] == 90 and ((b[6] << 8) | b[7]) == 12:
            found = b
            break
    if found:
        break
if not found:
    print('no 90/12')
    sys.exit(1)
print('raw len', len(found))
d = dec_msg('StartGameP_BuildRoom_S2C', found[9:])
pi = d.pop('playerInfos', [])
print('top:', {k: v for k, v in d.items()})
print('players:', len(pi))
for n, p in enumerate(pi):
    short = {}
    for k, v in p.items():
        if isinstance(v, list):
            short[k] = '[%d]' % len(v)
        elif isinstance(v, dict):
            short[k] = 'map%d' % len(v)
        else:
            short[k] = v
    print('--- p%d' % n, short)
    b0 = p.get('builds') or []
    print('   builds:', len(b0), json.dumps(b0[:2], ensure_ascii=False))
    o0 = p.get('organs') or []
    print('   organs:', len(o0), json.dumps(o0[:2], ensure_ascii=False))
    h0 = p.get('heros') or []
    if h0:
        print('   hero0:', json.dumps(h0[0], ensure_ascii=False)[:600])
json.dump(d, open('/tmp/sgp_top.json', 'w'), ensure_ascii=False)
json.dump(pi, open('/tmp/sgp_players.json', 'w'), ensure_ascii=False)
