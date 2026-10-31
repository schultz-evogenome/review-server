import json, os, re, subprocess, tempfile, concurrent.futures as cf
D = json.load(open('cases.json')); F = D['text']
SPECIAL = {'Esc': b'\x1b', 'CR': b'\r', 'BS': b'\x08', 'Tab': b'\t', 'Space': b' ', 'lt': b'<',
           'Left': b'\x1bOD', 'Right': b'\x1bOC', 'Up': b'\x1bOA', 'Down': b'\x1bOB'}
def keys(s):
    out = b''; i = 0
    while i < len(s):
        m = re.match(r'<(C-(.)|[A-Za-z]+)>', s[i:])
        if m and (m.group(2) or m.group(1) in SPECIAL):
            out += bytes([ord(m.group(2).upper()) & 31]) if m.group(2) else SPECIAL[m.group(1)]
            i += m.end()
        else:
            out += s[i].encode(); i += 1
    return out
SET = b":set nocp cpo&vim bs=indent,eol,start sw=2 ts=4 et ai nojs nomore cmdheight=20 shm=aAIOT nohls noic nowrap viminfo= nostartofline noswf belloff=all ttimeoutlen=0 timeoutlen=50 lines=50 columns=200\r:set startofline\r"
def run(c):
    with tempfile.TemporaryDirectory() as d:
        f = os.path.join(d, 't.txt'); open(f, 'w').write(F)
        pos = os.path.join(d, 'pos'); out = os.path.join(d, 'out')
        tail = b"\x1b\x1b:call writefile([line('.').','.col('.')],'" + pos.encode() + b"')\r:w! " + out.encode() + b"\r:qa!\r"
        s = os.path.join(d, 's'); open(s, 'wb').write(SET + keys(c) + tail)
        try:
            subprocess.run(['vim', '-u', 'NONE', '-N', '-i', 'NONE', '-n', '--not-a-term', '-T', 'xterm', '-s', s, f], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8)
        except subprocess.TimeoutExpired:
            return None
        if not (os.path.exists(pos) and os.path.exists(out)): return None
        return {'text': open(out).read(), 'pos': open(pos).read().strip()}
with cf.ThreadPoolExecutor(8) as ex:
    res = list(ex.map(run, [c for _, c in D['cases']]))
json.dump(res, open('vim.json', 'w'))
print('vim results:', sum(r is not None for r in res), 'of', len(res))
