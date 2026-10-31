# Runs key sequences through real Vim in a pty, so keys count as typed and undo steps are real.
import json, os, pty, re, select, signal, struct, fcntl, termios, tempfile, time, sys, shutil, concurrent.futures as cf
SPECIAL = {'Esc': b'\x1b', 'CR': b'\r', 'BS': b'\x7f', 'Tab': b'\t', 'Space': b' ', 'lt': b'<',
           'Left': b'\x1bOD', 'Right': b'\x1bOC', 'Up': b'\x1bOA', 'Down': b'\x1bOB'}
def tokens(s):
    out = []; i = 0
    while i < len(s):
        m = re.match(r'<(C-(.)|[A-Za-z]+)>', s[i:])
        if m and m.group(2):
            ch = m.group(2)
            out.append(b'\x1b' if ch == '[' else bytes([ord(ch.upper()) & 31])); i += m.end()
        elif m and m.group(1) in SPECIAL:
            out.append(SPECIAL[m.group(1)]); i += m.end()
        else:
            out.append(s[i].encode()); i += 1
    return out
SET = (":set nocp cpo&vim bs=indent,eol,start sw=2 ts=4 et ai nojs nomore cmdheight=20 shm=aAIOT nohls noic nowrap viminfo= noswf belloff=all ttimeout ttimeoutlen=5 timeoutlen=50 lines=50 columns=200 startofline\r")
DUMP = r'''
let d={}
let d.pos=[line('.'),charcol('.')]
let d.mode=mode()
let d.regs={}
for r in split('a b c d e q 0 1 2 3 4 5 6 7 8 9 - " /',' ')
  let d.regs[r]=[getreg(r),getregtype(r)]
endfor
let d.cmdline=getreg(':')
call writefile([json_encode(d)],$OUTJ)
'''
def run(case, timeout=25):
    d = tempfile.mkdtemp(prefix='vr')
    try:
        ext = case.get('ext', 'txt')
        f = os.path.join(d, 't.' + ext); open(f, 'w', encoding='utf-8').write(case['text'] + '\n')
        out = os.path.join(d, 'out'); outj = os.path.join(d, 'outj'); dump = os.path.join(d, 'dump.vim')
        open(dump, 'w').write(DUMP)
        pid, fd = pty.fork()
        if pid == 0:
            os.environ['OUTJ'] = outj; os.environ['TERM'] = 'xterm'; os.environ['LANG'] = 'en_US.UTF-8'; os.environ['LC_ALL'] = 'en_US.UTF-8'
            os.execvp('vim', ['vim', '-u', 'NONE', '-N', '-i', 'NONE', '-n', '--cmd', 'set enc=utf-8 fencs=utf-8', f])
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 200, 0, 0))
        toks = tokens(SET) + tokens(case['keys']) + [b'\x1b', b'\x1b'] + tokens(':source ' + dump + '\r:w! ' + out + '\r:qa!\r')
        i = 0; end = time.time() + timeout; last = 0; alive = True
        t0 = time.time()
        while time.time() - t0 < 0.05:
            r, _, _ = select.select([fd], [], [], 0.01)
            if r:
                try: os.read(fd, 65536)
                except OSError: break
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.0005)
            if r:
                try:
                    if not os.read(fd, 65536): break
                except OSError: break
            if i < len(toks) and time.time() >= last:
                try: os.write(fd, toks[i])
                except OSError: break
                last = time.time() + (0.012 if toks[i] == b'\x1b' else 0.0006)
                i += 1
            elif i >= len(toks):
                p, _ = os.waitpid(pid, os.WNOHANG)
                if p: alive = False; break
        if alive:
            try:
                os.kill(pid, signal.SIGKILL); os.waitpid(pid, 0)
            except Exception: pass
        os.close(fd)
        if not (os.path.exists(out) and os.path.exists(outj)): return {'error': 'no output (timeout or stuck)'}
        r = json.loads(open(outj, encoding='utf-8').read())
        t = open(out, encoding='utf-8', errors='surrogateescape').read()
        r['text'] = t[:-1] if t.endswith('\n') else t
        return r
    finally:
        shutil.rmtree(d, ignore_errors=True)
def one(c):
    r = run({'text': TEXT, 'keys': c})
    return {'text': r['text'], 'pos': '%d,%d' % tuple(r['pos'])} if 'text' in r else None
if __name__ == '__main__':
    D = json.load(open('cases.json'))
    TEXT = D['text'].rstrip('\n')
    with cf.ThreadPoolExecutor(6) as ex:
        res = list(ex.map(one, [c for _, c in D['cases']]))
    json.dump(res, open('vim.json', 'w'))
    print('vim results:', sum(r is not None for r in res), 'of', len(res))
