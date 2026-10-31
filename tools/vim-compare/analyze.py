import json, re, sys, collections
D = json.load(open('cases.json')); V = json.load(open('vim.json'))
C = json.load(open(sys.argv[1] if len(sys.argv) > 1 else 'cm.json'))
pe=C.get('pageErrors') or []; print('page errors:', len(pe), collections.Counter(m for _,m in pe).most_common(6)); print('  e.g.', [c for c,_ in pe][:40])
C = C['res']
starts = ['2G5l','3G8l','3G14l','4G3l','6G10l','7G25l','8G6l','12G','5G','gg']
bad = []
tot = 0
for (k, c), v in zip(D['cases'], V):
    if v is None or c not in C: continue
    if ('u' in c and ('xxuu' in c or 'dwdwu' in c or 'dwdw' in c)): continue   # vim merges undo steps from a script
    tot += 1
    r = C[c]
    t = v['text'][:-1] if v['text'].endswith('\n') else v['text']
    if __import__('re').search(r'(^|[0-9lGg])(H|M|L|<C-[bdfuey]>)', c): continue   # depends on the window
    if r.get('error'): bad.append((k, c, 'ERR', r['error'], '')); continue
    rt = r.get('text', '')
    if rt != t: bad.append((k, c, 'text', v, r))
    elif r.get('pos') != v['pos']: bad.append((k, c, 'pos', v, r))
print('compared', tot, 'differences', len(bad), 'text', sum(b[2]=='text' for b in bad), 'pos', sum(b[2]=='pos' for b in bad), 'left page', sum(1 for x in C.values() if x.get('left')))
def strip(c):
    for s in starts:
        if c.startswith(s): return c[len(s):]
    return c
g = collections.defaultdict(list)
for k, c, what, v, r in bad:
    g[(k, strip(c))].append((c, what, v, r))
json.dump([[k[0], k[1], len(x), x[0][0], x[0][1], x[0][2], x[0][3]] for k, x in g.items()], open('groups.json', 'w'))
by = collections.Counter(k[0] for k in g)
print('distinct commands differing, by kind:', dict(by))
for kind in by:
    items = [(k[1], len(v)) for k, v in g.items() if k[0] == kind]
    print('--', kind, len(items)); print('  ' + '  '.join('%s(%d)' % i for i in sorted(items, key=lambda x: -x[1])[:260]))
