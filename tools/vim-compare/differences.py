# Prints each case that differs from Vim in a terminal, line by line. Vim reports characters, and the editor UTF-16 units.
import json
D = json.load(open('cases.json'))
V = json.load(open('vim.json'))
R = json.load(open('cm.json'))
res = R['res']
def col(text, pos):
    l, c = map(int, pos.split(','))
    return l, c
same = 0
bad = []
for (k, c), v in zip(D['cases'], V):
    r = res.get(c)
    if r is None or v is None:
        bad.append((c, 'no result', v, r))
        continue
    vl, vc = col(v['text'], v['pos'])
    line = v['text'].split('\n')[vl - 1] if vl - 1 < len(v['text'].split('\n')) else ''
    vchars = len(line[:vc - 1].encode('utf-16-le')) // 2 + 1
    ok_text = v['text'].rstrip('\n') == r.get('text', '').rstrip('\n')
    ok_pos = r.get('pos') == '%d,%d' % (vl, vchars)
    if ok_text and ok_pos and not r.get('left'):
        same += 1
    else:
        bad.append((c, 'text' if not ok_text else 'pos', v, r))
print(same, 'same of', len(D['cases']), 'pageErrors', R.get('pageErrors'))
for c, why, v, r in bad:
    print('---', c, why)
    if not v or not r or 'text' not in r:
        print('  vim', v and v['pos'], ' cm', r)
        continue
    print('  pos vim', v['pos'], ' cm', r['pos'], ' dialog' if r.get('dialog') else '', ' left' if r.get('left') else '')
    a, b = v['text'].rstrip('\n').split('\n'), r['text'].rstrip('\n').split('\n')
    shown = 0
    for i in range(max(len(a), len(b))):
        x = a[i] if i < len(a) else None
        y = b[i] if i < len(b) else None
        if x != y and shown < 4:
            print('  L%d vim %r' % (i + 1, x and x[:90]))
            print('  L%d cm  %r' % (i + 1, y and y[:90]))
            shown += 1
