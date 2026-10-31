#!/usr/bin/env python3
"""Review queue: PDFs waiting for markup on an iPad, or in any browser, and text files to edit.

Agents queue a PDF. You open the queue in a browser, highlight text by selecting it or by
drawing over it with an Apple Pencil, tag each highlight "change" or "discuss", add a note
if you like (the iPad keyboard's microphone dictates it), and tap Done. Agents then read the
numbered highlights and match them with what you tell them. A .txt, .md, or .tex file opens in
an editor instead (regular or vim keys); agents then read your edits as a diff.

Everything is plain files, so any agent can take part and git can carry them:

    <folder>/review_queue/<YYYY-MM-DD>_<name>/
        <name>.pdf        an exact copy of the file under review
        request.json      title, note to the reviewer, who queued it and when, sha256
        highlights.json   written by the server as you mark the file
        <name>.md         for a text file, an exact copy as queued, instead of the PDF
        edited/<name>.md  written by the server as you edit a text file; deleted if you undo every edit
        images/           the images a text file refers to, listed under "images" in request.json
        done.json         written when you tap Done, or when a newer version replaces the item
                          (then with superseded_by); deleted if you reopen the item

Commands (Python 3.8 or later, standard library only):

  On the machine that holds the files:
    review.py queue FILE --title TITLE [--note NOTE] [--by NAME] [--into FOLDER] [--doc DOC] [--version N]
    review.py list  [--root DIR ...] [--all]
    review.py show  ITEM [--root DIR ...] [--json]
    review.py serve [--root DIR ...] [--inbox DIR] [--lan] [--host 127.0.0.1] [--port 8765]
                    [--no-auto-close] [--state FILE]

  From any other machine that can reach the server:
    review.py push FILE --server URL --title TITLE [--note NOTE] [--by NAME] [--group NAME] [--doc DOC] [--version N]
    review.py pull [ITEM] --server URL [--json]

Versions: the last _v<digits> in the PDF's name (followed by _, the extension, or the end) is its version,
and everything before it names the document, so Plan_v8_review.pdf and Plan_v9.pdf are versions 8 and 9
of Plan. --doc and --version set them instead. When a higher version of a document is queued, the server
closes the older waiting versions that have no highlights and no voice notes; their status becomes
"superseded", not "done". Edited text counts as marked. serve --no-auto-close turns that off.

--root defaults to the folders listed in $REVIEW_ROOTS (separated by ":"), else the current
folder. ITEM is an item folder, its name, its id, or (for pull) words from its title.
FILE is a PDF, or a UTF-8 text file ending in .txt, .md, .markdown, or .tex. queue and push also send
the images a text file refers to (![](...), <img>, \\includegraphics) if they are in its folder or git repository.
serve --inbox names the folder where files sent with push or the page's Add file button go.

serve --lan listens on the local network as well. Other devices then need a token, which the
server prints in the address to open; it is kept in ~/.config/review-server/token (or set
$REVIEW_TOKEN). Requests from the same computer, including those passed on by
"tailscale serve", never need the token.

Voice notes recorded on the page are saved in <item>/audio/. If the faster-whisper package is
installed for the Python that runs the server, each clip is turned into text in the background
(<clip>.json next to it); $REVIEW_WHISPER_MODEL picks the model (default small.en).
"""
import argparse
import datetime as dt
import difflib
import hashlib
import http.server
import json
import mimetypes
import os
import queue
import re
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
STATIC = HERE / 'static'
QUEUE = 'review_queue'
SKIP = {'.git', 'node_modules', '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache'}
TAGS = ('change', 'discuss')
MAX_BODY = 100 * 1024 * 1024
AUDIO_EXT = {'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/aac': '.aac', 'audio/webm': '.webm',
             'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav',
             'audio/flac': '.flac', 'audio/x-flac': '.flac'}
EXT_TYPE = {'.m4a': 'audio/mp4', '.aac': 'audio/aac', '.webm': 'audio/webm', '.ogg': 'audio/ogg',
            '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac'}
SAFE_FILE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$')
VERSION = re.compile(r'_[vV]([0-9]+)(?=_|\.[A-Za-z0-9]+$|$)')
IDLE_UNLOAD = 15 * 60          # seconds without voice notes before the speech model is unloaded
SWEEP = 3                      # seconds between checks for older versions to close
TEXT_EXT = ('.txt', '.md', '.markdown', '.tex')
MAX_TEXT = 5 * 1024 * 1024
IMAGE_TYPES = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
               '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf'}
MAX_IMAGE = 25 * 1024 * 1024
MD_IMAGE = re.compile(r'!\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)|<img\b[^>]*\bsrc\s*=\s*["\']([^"\']+)["\']', re.I)
TEX_IMAGE = re.compile(r'\\includegraphics\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}')
TEX_PATHS = re.compile(r'\\graphicspath\s*\{((?:\s*\{[^}]*\})+)\s*\}')


# ---------------------------------------------------------------- files

def now():
    return dt.datetime.now().astimezone().isoformat(timespec='seconds')


def read_json(path, default=None):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def write_json(path, data):
    path = Path(path)
    tmp = path.with_name(path.name + '.tmp')
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write('\n')
    os.replace(tmp, path)


def write_bytes(path, data):
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_bytes(data)
    os.replace(tmp, path)


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def git_root(path):
    for p in [path] + list(path.parents):
        if (p / '.git').exists():
            return p
    return None


def roots_from(given):
    if given:
        names = given
    elif os.environ.get('REVIEW_ROOTS'):
        names = [r for r in os.environ['REVIEW_ROOTS'].split(os.pathsep) if r]
    else:
        names = ['.']
    roots = []
    for name in names:
        p = Path(name).expanduser().resolve()
        if not p.is_dir():
            sys.exit('Not a folder: %s' % p)
        roots.append(p)
    return roots


def find_items(roots):
    """Every review item under the roots: a folder inside a review_queue folder with a request.json."""
    items = []
    for root in roots:
        for dirpath, dirnames, _ in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in SKIP and not d.startswith('.')]
            if os.path.basename(dirpath) == QUEUE:
                for d in sorted(dirnames):
                    p = Path(dirpath) / d
                    if (p / 'request.json').is_file():
                        items.append((root, p))
                dirnames[:] = []
    return items


def item_id(path):
    return hashlib.sha1(str(path).encode('utf-8')).hexdigest()[:12]


def safe_file_name(name):
    """A plain name for the copy in the item folder: .pdf unless the name has a text extension."""
    name = Path(str(name).replace('\\', '/')).name
    ext = Path(name).suffix.lower()
    stem = re.sub(r'[^A-Za-z0-9._-]+', '_', Path(name).stem).strip('._-') or 'document'
    return stem[:120] + (ext if ext in TEXT_EXT else '.pdf')


def is_text_name(name):
    return Path(str(name).replace('\\', '/')).suffix.lower() in TEXT_EXT


def decode_text(data):
    """The text of a queued or edited file. ValueError if it is too long, binary, or not UTF-8."""
    if len(data) > MAX_TEXT:
        raise ValueError('a text file can be at most %d MB' % (MAX_TEXT // (1024 * 1024)))
    if data.startswith(b'%PDF-') or b'\0' in data:
        raise ValueError('that is not a text file')
    try:
        return data.decode('utf-8')
    except UnicodeDecodeError:
        raise ValueError('a text file must be UTF-8')


def name_version(name):
    """(document, version) from a file name. The version is the last _v<digits> followed by "_", the
    extension, or the end, and the document is everything before it. A name without one is (its stem, None)."""
    name = Path(str(name)).name
    found = list(VERSION.finditer(name))
    if not found:
        return Path(name).stem, None
    return name[:found[-1].start()], int(found[-1].group(1))


def doc_version(req):
    """An item's document and version: request.json's doc and version where set, else from the PDF's name."""
    doc, version = name_version(req.get('pdf') or req.get('text') or '')
    if str(req.get('doc') or '').strip():
        doc = str(req['doc']).strip()
    if req.get('version') not in (None, ''):
        try:
            version = int(req['version'])
        except (TypeError, ValueError):
            pass
    return doc, version


def make_item(folder, file_name, data, meta):
    """Create <folder>/review_queue/<date>_<stem>/ holding the PDF or text file and request.json."""
    file_name = safe_file_name(file_name)
    base = Path(folder) / QUEUE / ('%s_%s' % (dt.date.today().isoformat(), Path(file_name).stem))
    item, k = base, 2
    while True:
        try:
            item.mkdir(parents=True)
            break
        except FileExistsError:
            item = base.with_name('%s-%d' % (base.name, k))
            k += 1
    (item / file_name).write_bytes(data)
    req = {'title': meta.get('title') or Path(file_name).stem, 'note': meta.get('note') or '',
           'text' if is_text_name(file_name) else 'pdf': file_name,
           'sha256': sha256_bytes(data), 'source': meta.get('source') or file_name,
           'queued_by': meta.get('by') or '', 'queued_at': now()}
    if meta.get('group'):
        req['group'] = meta['group']
    if meta.get('doc'):
        req['doc'] = meta['doc']
    if meta.get('version') is not None:
        req['version'] = int(meta['version'])
    write_json(item / 'request.json', req)
    return item


def load_highlights(item):
    data = read_json(item / 'highlights.json', None) or {}
    hs = list(data.get('highlights', []))
    return {'version': int(data.get('version', 0)), 'updated_at': data.get('updated_at'),
            'max_n': max([int(data.get('max_n', 0))] + [int(h.get('n', 0)) for h in hs]),  # numbers are never reused
            'highlights': hs}


def no_tex_comments(text):
    return '\n'.join(re.sub(r'(^|[^\\])%.*$', r'\1', line) for line in text.split('\n'))


def image_refs(name, text):
    """The images a text file refers to, in the order of the text, without repeats, data: or web addresses."""
    ext = Path(str(name)).suffix.lower()
    if ext == '.tex':
        refs = TEX_IMAGE.findall(no_tex_comments(text))
    elif ext in ('.md', '.markdown'):                # Markdown can hold raw LaTeX figures too
        found = [(m.start(), m.group(1) or m.group(2)) for m in MD_IMAGE.finditer(text)]
        found += [(m.start(), m.group(1)) for m in TEX_IMAGE.finditer(text)]
        refs = [r for _, r in sorted(found)]
    else:
        refs = []
    return [r for r in dict.fromkeys(x.strip() for x in refs) if not re.match(r'^(data:|https?://)', r, re.I)]


def find_images(path, text):
    """[(reference, file or None)] for a text file on disk. A reference is looked for where it says, then as the
    one file with its name under a figures, figs, or images folder beside the text file or one folder up. Only
    files in its folder or git repository count, so a reference cannot pull in anything else from the machine."""
    path = Path(path).expanduser().resolve()
    limit = git_root(path) or path.parent
    dirs = [path.parent]
    if path.suffix.lower() == '.tex':
        found = TEX_PATHS.search(no_tex_comments(text))
        dirs += [path.parent / d for d in re.findall(r'\{([^}]*)\}', found.group(1))] if found else []
    out = []
    for ref in image_refs(path, text):
        name = urllib.parse.unquote(ref)
        exts = ['', '.pdf', '.png', '.jpg', '.jpeg', '.svg']
        tries = [d / (name + ext) for d in dirs for ext in exts]
        for ext in exts:
            names = (Path(name).name + ext)
            same = [Path(w) / names for top in (path.parent, path.parent.parent) for sub in ('figures', 'figs', 'images')
                    for w, _, files in os.walk(str(top / sub)) if names in files]
            if len(same) == 1:                           # two files with that name: leave it for the reviewer to choose
                tries.append(same[0])
        hit = None
        for t in tries:
            try:
                t = t.resolve()
                t.relative_to(limit)
            except (ValueError, OSError):
                continue
            if t.suffix.lower() in IMAGE_TYPES and t.is_file() and t.stat().st_size <= MAX_IMAGE:
                hit = t
                break
        out.append((ref, hit))
    return out


def add_image(item, ref, file_name, data):
    """Keep an image for a reference in the text, in <item>/images/. Returns {reference: file name}."""
    ext = Path(str(file_name).replace('\\', '/')).suffix.lower()
    if ext not in IMAGE_TYPES:
        raise ValueError('an image must be .png, .jpg, .gif, .webp, .svg, or .pdf')
    if not data or len(data) > MAX_IMAGE:
        raise ValueError('an image can be at most %d MB' % (MAX_IMAGE // (1024 * 1024)))
    if not ref or len(ref) > 1000:
        raise ValueError('which image in the text is this?')
    req = read_json(item / 'request.json', {}) or {}
    images = req.get('images') or {}
    stem = re.sub(r'[^A-Za-z0-9._-]+', '_', Path(str(file_name).replace('\\', '/')).stem).strip('._-') or 'image'
    name = '%03d_%s%s' % (len(images) + 1, stem[:60], ext)
    if Path(images.get(ref, '')).suffix == ext:
        name = images[ref]
    (item / 'images').mkdir(exist_ok=True)
    write_bytes(item / 'images' / name, data)
    images[ref] = name
    req['images'] = images
    write_json(item / 'request.json', req)
    return images


def has_edits(item):
    d = item / 'edited'
    return d.is_dir() and any(d.iterdir())


def text_state(item, req):
    """A text item: its file as queued, the file with the reviewer's edits, and a diff between them."""
    name = Path(req['text']).name
    original = (item / name).read_bytes()
    edited = item / 'edited' / name
    current = edited.read_bytes() if edited.is_file() else original
    a, b = original.decode('utf-8'), current.decode('utf-8')
    diff = '\n'.join(difflib.unified_diff(a.split('\n'), b.split('\n'), name, 'edited/' + name, lineterm=''))
    return {'name': name, 'original': a, 'current': b, 'edited': current != original, 'sha256': sha256_bytes(current),
            'updated_at': dt.datetime.fromtimestamp(edited.stat().st_mtime).astimezone().isoformat(timespec='seconds')
            if edited.is_file() else None, 'diff': diff, 'images': req.get('images') or {}}


def summary(root, item):
    req = read_json(item / 'request.json', {}) or {}
    hs = load_highlights(item)['highlights']
    done = read_json(item / 'done.json', None)
    if done is not None and not isinstance(done, dict):
        done = {}
    try:
        folder = item.relative_to(root).parent.parent.name or root.name
    except ValueError:
        folder = item.parent.parent.name
    doc, version = doc_version(req)
    replaced = done or {}
    return {
        'id': item_id(item), 'path': str(item), 'name': item.name, 'folder': req.get('group') or folder,
        'title': req.get('title') or item.name, 'note': req.get('note', ''),
        'queued_by': req.get('queued_by', ''), 'queued_at': req.get('queued_at', ''),
        'pdf': req.get('pdf', ''), 'sha256': req.get('sha256', ''), 'source': req.get('source', ''),
        'kind': 'text' if req.get('text') else 'pdf', 'file': req.get('text') or req.get('pdf', ''),
        'edited': has_edits(item), 'doc': doc, 'version': version,
        # "done" means the reviewer finished it; "superseded" means a newer version replaced it.
        'status': 'waiting' if done is None else 'superseded' if replaced.get('superseded_by') else 'done',
        'done_at': replaced.get('done_at'),
        'superseded_by': replaced.get('superseded_by'), 'superseded_version': replaced.get('superseded_version'),
        'superseded_at': replaced.get('superseded_at'), 'superseded_auto': bool(replaced.get('automatic')),
        'count': len(hs),
        'change': sum(1 for h in hs if h.get('tag') == 'change'),
        'discuss': sum(1 for h in hs if h.get('tag') == 'discuss'),
        'voice_notes': len(audio_files(item)),
    }


def newest_versions(rows):
    """{document: its newest item} over item summaries that have a version. Of several items with the
    top version, the one queued last."""
    top = {}
    for s in rows:
        if s['version'] is None:
            continue
        t = top.get(s['doc'])
        if t is None or (s['version'], s['queued_at'], s['id']) > (t['version'], t['queued_at'], t['id']):
            top[s['doc']] = s
    return top


def clean_highlights(raw):
    if not isinstance(raw, list) or len(raw) > 5000:
        raise ValueError('highlights must be a list')
    out = []
    for h in raw:
        if not isinstance(h, dict):
            raise ValueError('each highlight must be an object')
        if h.get('tag') not in TAGS:
            raise ValueError('tag must be "change" or "discuss"')
        rects = []
        for r in (h.get('rects') or [])[:1000]:
            rects.append({'page': int(r['page']), 'x': round(float(r['x']), 2), 'y': round(float(r['y']), 2),
                          'w': round(float(r['w']), 2), 'h': round(float(r['h']), 2)})
        audio = []
        for c in (h.get('audio') or [])[:50]:
            f = str(c.get('file', ''))
            if SAFE_FILE.match(f):
                audio.append({'file': f, 'mime': str(c.get('mime', ''))[:40],
                              'seconds': round(float(c.get('seconds') or 0), 1), 'created_at': str(c.get('created_at', ''))[:40]})
        out.append({
            'n': int(h.get('n', 0)), 'id': str(h.get('id', ''))[:40], 'tag': h['tag'],
            'page': int(h.get('page') or (rects[0]['page'] if rects else 0)),
            'text': str(h.get('text', ''))[:20000], 'note': str(h.get('note', ''))[:20000], 'rects': rects,
            'audio': audio,
            'created_at': str(h.get('created_at', ''))[:40], 'updated_at': str(h.get('updated_at', ''))[:40],
        })
    return out


def audio_files(item):
    d = item / 'audio'
    return sorted(p for p in d.iterdir() if p.suffix in EXT_TYPE) if d.is_dir() else []


def transcripts(item):
    """{clip file name: {"text": ...} | {"error": ...} | {"pending": true}} for an item's voice notes."""
    out = {}
    for p in audio_files(item):
        out[p.name] = read_json(p.with_name(p.name + '.json'), None) or {'pending': True}
    return out


def clock(seconds):
    s = int(round(float(seconds or 0)))
    return '%d:%02d' % (s // 60, s % 60)


def format_review(s, highlights, path=None, texts=None, text=None):
    """One item as Markdown: its numbered highlights, with notes and transcribed voice notes, or for a
    text file the diff of the reviewer's edits."""
    one = lambda t: ' '.join(str(t).split())
    texts = texts or {}
    hl = sorted(highlights, key=lambda h: h.get('n', 0))
    out = ['# Review: %s' % s['title'], '']
    if path:
        out.append('- Item: %s' % path)
    out.append('- File: %s (sha256 %s), from %s' % (s.get('file') or s['pdf'], (s['sha256'] or '')[:12], s['source'] or 'unknown'))
    out.append('- Document: %s, %s.' % (s.get('doc'), version_label(s.get('version'))))
    if s.get('note'):
        out.append('- Note to the reviewer: %s' % one(s['note']))
    out.append('- Queued %s%s.' % (s['queued_at'], (' by ' + s['queued_by']) if s['queued_by'] else ''))
    if s['status'] == 'done':
        out.append('- Done %s.' % s['done_at'])
    elif s['status'] == 'superseded':
        out.append('- Superseded %s by %s (item %s), %s. The reviewer did not mark this one done.'
                   % (s.get('superseded_at'), version_label(s.get('superseded_version')), s.get('superseded_by'),
                      'closed automatically' if s.get('superseded_auto') else 'closed by the reviewer'))
    else:
        out.append('- Not marked done yet.')
    if text is not None:
        if not text['edited']:
            out.append('- No edits.')
            return '\n'.join(out)
        out.append('- Edited %s; the full text is at edited/%s in the item folder.' % (text['updated_at'], text['name']))
        return '\n'.join(out + ['', '```diff', text['diff'], '```'])
    out.append('- %d highlights: %d change, %d discuss. Numbers follow the order they were made.'
               % (s['count'], s['change'], s['discuss']))
    out.append('')
    for h in hl:
        out.append('%d. **%s**, page %s: "%s"' % (h.get('n', 0), h.get('tag'), h.get('page', '?'), one(h.get('text', ''))))
        if h.get('note'):
            out.append('   Note: %s' % one(h['note']))
        for k, c in enumerate(h.get('audio') or [], 1):
            out.append('   Voice note %d (%s, %s): %s' % (k, clock(c.get('seconds')), c.get('file'), said(texts.get(c.get('file'), {}))))
    used = {c.get('file') for h in hl for c in (h.get('audio') or [])}
    extra = [f for f in sorted(texts) if f not in used]
    if extra:
        number = {h.get('id'): h.get('n') for h in hl}
        out += ['', 'Voice notes not listed under a highlight (the page may have closed while saving one):']
        for f in extra:
            n = number.get(f.split('_')[0])
            out.append('- %s%s: %s' % (f, ', for highlight %d' % n if n else '', said(texts[f])))
    return '\n'.join(out)


def said(t):
    one = ' '.join(str(t.get('text', '')).split())
    if 'text' in t:
        return one or '(no words heard)'
    return '(no transcript: %s)' % t['error'] if t.get('error') else '(not transcribed yet)'


def version_label(v):
    return 'no version' if v is None else 'version %s' % v


def status_label(s):
    """"waiting", "done", or "superseded by v9" for one item summary."""
    if s['status'] != 'superseded':
        return s['status']
    v = s.get('superseded_version')
    return 'superseded by %s' % ('a newer version' if v is None else 'v%s' % v)


def marks_label(s):
    """"  3 highlights", or for a text file whether it has been edited."""
    if s.get('kind') == 'text':
        return 'text, edited' if s.get('edited') else 'text, no edits'
    return '%3d highlights' % s['count']


# ---------------------------------------------------------------- local commands

def cmd_queue(a):
    pdf = Path(a.file).expanduser().resolve()
    if not pdf.is_file() or not (pdf.suffix.lower() == '.pdf' or is_text_name(pdf)):
        sys.exit('Not a PDF or a .txt, .md, or .tex file: %s' % pdf)
    if is_text_name(pdf):
        try:
            decode_text(pdf.read_bytes())
        except ValueError as e:
            sys.exit('%s: %s' % (pdf, e))
    if a.into:
        folder = Path(a.into).expanduser().resolve()
    else:
        folder = pdf.parent.parent if pdf.parent.name == 'drafts' else pdf.parent
    root = git_root(pdf)
    item = make_item(folder, pdf.name, pdf.read_bytes(), {
        'title': a.title, 'note': a.note, 'by': a.by, 'doc': (a.doc or '').strip(), 'version': a.version,
        'source': str(pdf.relative_to(root)) if root else str(pdf)})
    if is_text_name(pdf):
        for ref, found in find_images(pdf, pdf.read_text(encoding='utf-8')):
            if found:
                add_image(item, ref, found.name, found.read_bytes())
            else:
                print('Image not found, so not queued: %s' % ref, file=sys.stderr)
    print(item)


def cmd_list(a):
    rows = sorted((summary(r, i) for r, i in find_items(roots_from(a.root))), key=lambda s: s['queued_at'])
    rows = [s for s in rows if a.all or s['status'] == 'waiting']
    if not rows:
        print('No review items.' if a.all else 'Nothing waiting.')
    for s in rows:
        print('%-7s  %s  %s\n         %s, %s\n         %s'
              % (status_label(s), marks_label(s), s['title'], s['doc'], version_label(s['version']), s['path']))


def resolve_item(arg, roots):
    p = Path(arg).expanduser()
    if p.is_dir() and (p / 'request.json').is_file():
        p = p.resolve()
        for r in roots:
            try:
                p.relative_to(r)
                return r, p
            except ValueError:
                pass
        return (git_root(p) or p.parent.parent), p
    for r, i in find_items(roots):
        if arg in (item_id(i), i.name):
            return r, i
    sys.exit('No review item %r. "review.py list --all" shows them.' % arg)


def cmd_show(a):
    root, item = resolve_item(a.item, roots_from(a.root))
    s = summary(root, item)
    hl = load_highlights(item)['highlights']
    req = read_json(item / 'request.json', {}) or {}
    text = text_state(item, req) if req.get('text') else None
    if a.json:
        print(json.dumps({'item': s, 'request': req, 'done': read_json(item / 'done.json'),
                          'highlights': hl, 'transcripts': transcripts(item), 'text': text}, indent=2, ensure_ascii=False))
    else:
        print(format_review(s, hl, item, transcripts(item), text))


# ---------------------------------------------------------------- remote commands

def http_call(url, data=None, method='GET', ctype=None):
    headers = {'X-Review': '1'}
    if ctype:
        headers['Content-Type'] = ctype
    if os.environ.get('REVIEW_TOKEN'):
        headers['X-Review-Token'] = os.environ['REVIEW_TOKEN']
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            msg = json.load(e).get('error', '')
        except ValueError:
            msg = ''
        sys.exit('The server answered %d %s' % (e.code, msg or e.reason))
    except urllib.error.URLError as e:
        sys.exit('Could not reach %s: %s' % (url.split('/api/')[0], e.reason))


def cmd_push(a):
    pdf = Path(a.file).expanduser()
    data = pdf.read_bytes()
    if is_text_name(pdf):
        try:
            decode_text(data)
        except ValueError as e:
            sys.exit('%s: %s' % (pdf, e))
    elif not data.startswith(b'%PDF-'):
        sys.exit('Not a PDF or a .txt, .md, or .tex file: %s' % pdf)
    q = urllib.parse.urlencode({'title': a.title, 'note': a.note or '', 'by': a.by or '', 'group': a.group or '',
                                'doc': a.doc or '', 'version': '' if a.version is None else a.version,
                                'filename': pdf.name})
    item = http_call(a.server.rstrip('/') + '/api/queue?' + q, data, 'POST', 'application/pdf')['item']
    print('Queued "%s" (id %s, %d KB; document %s, %s).'
          % (item['title'], item['id'], len(data) // 1024, item.get('doc'), version_label(item.get('version'))))
    if is_text_name(pdf):
        for ref, found in find_images(pdf, data.decode('utf-8')):
            if found:
                q = urllib.parse.urlencode({'ref': ref, 'filename': found.name})
                http_call(a.server.rstrip('/') + '/api/items/%s/images?%s' % (item['id'], q), found.read_bytes(), 'POST',
                          'application/octet-stream')
                print('Sent image %s.' % ref)
            else:
                print('Image not found, so not sent: %s' % ref, file=sys.stderr)


def cmd_pull(a):
    base = a.server.rstrip('/')
    items = http_call(base + '/api/items')['items']
    if not a.item:
        for s in items:
            print('%-7s  %s  %s  [%s, id %s]\n         %s, %s'
                  % (status_label(s), marks_label(s), s['title'], s['folder'], s['id'],
                     s.get('doc'), version_label(s.get('version'))))
        return
    words = a.item.lower()
    found = [s for s in items if a.item in (s['id'], s['name'])] or [s for s in items if words in s['title'].lower()]
    if not found:
        sys.exit('No item matches %r.' % a.item)
    if len(found) > 1:
        sys.exit('Several items match %r: %s' % (a.item, '; '.join('%s (id %s)' % (s['title'], s['id']) for s in found)))
    d = http_call(base + '/api/items/' + found[0]['id'])
    if a.json:
        print(json.dumps(d, indent=2, ensure_ascii=False))
    else:
        print(format_review(d['item'], d['highlights']['highlights'], texts=d.get('transcripts'), text=d.get('text')))


# ---------------------------------------------------------------- voice notes

class Transcriber:
    """Turns voice notes into text with faster-whisper, if it is installed: one clip at a time, in the background."""

    def __init__(self):
        try:
            import faster_whisper  # noqa: F401
            self.ok = True
        except ImportError:
            self.ok = False
        self.name = os.environ.get('REVIEW_WHISPER_MODEL', 'small.en')
        self.model = None
        self.cpu = False
        self.q = queue.Queue()
        if self.ok:
            threading.Thread(target=self.run, daemon=True).start()

    def add(self, path):
        if self.ok:
            self.q.put(Path(path))

    def load(self, cpu):
        from faster_whisper import WhisperModel
        self.cpu = cpu
        if cpu:
            return WhisperModel(self.name, device='cpu', compute_type='int8')
        return WhisperModel(self.name, device='auto', compute_type='auto')

    @staticmethod
    def decode(path, rate=16000):
        """The clip as 16 kHz mono floats. faster-whisper's own reader passes an option that newer PyAV
        releases removed, so decode here with PyAV (installed with faster-whisper) directly."""
        import av
        import numpy as np
        parts = []
        resampler = av.AudioResampler(format='s16', layout='mono', rate=rate)
        with av.open(str(path), mode='r') as container:
            try:
                for frame in container.decode(audio=0):
                    for f in resampler.resample(frame):
                        parts.append(f.to_ndarray().reshape(-1))
            except av.error.InvalidDataError:
                pass                                         # keep what was read before a damaged frame
            for f in resampler.resample(None):
                parts.append(f.to_ndarray().reshape(-1))
        if not parts:
            return np.zeros(0, dtype=np.float32)
        return np.concatenate(parts).astype(np.float32) / 32768.0

    def transcribe(self, path):
        audio = self.decode(path)
        if not len(audio):
            return '', 0.0
        segments, _ = self.model.transcribe(audio, beam_size=5)
        text = ' '.join(s.text.strip() for s in segments).strip()   # the work happens while iterating
        return text, round(len(audio) / 16000.0, 1)

    def run(self):
        last = time.time()
        while True:
            try:
                path = self.q.get(timeout=60)
            except queue.Empty:
                if self.model is not None and time.time() - last > IDLE_UNLOAD:
                    self.model = None                        # free the memory until the next clip arrives
                    print('%s voice notes: model unloaded after %d idle minutes' % (now(), IDLE_UNLOAD // 60), flush=True)
                continue
            last = time.time()
            side = path.with_name(path.name + '.json')
            if side.exists() or not path.exists():
                continue
            try:
                if self.model is None:
                    try:
                        self.model = self.load(cpu=False)
                    except Exception:
                        self.model = self.load(cpu=True)
                try:
                    text, seconds = self.transcribe(path)
                except Exception:
                    if self.cpu:
                        raise
                    self.model = self.load(cpu=True)        # for example, a GPU without the libraries it needs
                    text, seconds = self.transcribe(path)
                write_json(side, {'text': text, 'seconds': seconds, 'model': self.name, 'done_at': now()})
            except Exception as e:
                write_json(side, {'error': ('%s: %s' % (type(e).__name__, e))[:500], 'done_at': now()})
            last = time.time()


# ---------------------------------------------------------------- server

class Store:
    def __init__(self, roots, inbox, transcriber, auto_close=True, state=None):
        self.roots = roots
        self.inbox = inbox
        self.transcriber = transcriber
        self.auto_close = auto_close
        self.lock = threading.Lock()
        self.locks = {}
        self.items = {}
        self.scanned = 0.0
        # Items this server has closed as replaced, {id: {"version": the version that replaced it, ...}}.
        # An item found waiting again was reopened (on the page or by deleting done.json), so it is left
        # open until a version higher than that one arrives.
        self.state = Path(state) if state else None
        self.sweeping = threading.Lock()
        self.state_lock = threading.Lock()
        try:
            self.replaced = (read_json(self.state, {}) if self.state else {}) or {}
        except ValueError as e:
            print('%s could not read %s (%s); starting a new record' % (now(), self.state, e), flush=True)
            self.replaced = {}

    def all(self, fresh=False):
        with self.lock:
            if fresh or time.time() - self.scanned > 3:
                self.items = {item_id(i): (r, i) for r, i in find_items(self.roots)}
                self.scanned = time.time()
            return dict(self.items)

    def get(self, iid):
        return self.all().get(iid) or self.all(fresh=True).get(iid)

    def item_lock(self, iid):
        with self.lock:
            return self.locks.setdefault(iid, threading.Lock())

    def supersede(self, iid, item, newer, automatic):
        """Close an item as replaced by `newer` (a summary): done.json with superseded_by. Nothing else in
        the folder changes. Closing automatically needs a waiting item without highlights, voice notes, or edits;
        closing by hand needs one the reviewer has not marked done. Returns whether it closed the item."""
        with self.item_lock(iid):
            done = read_json(item / 'done.json', None)
            hs = load_highlights(item)['highlights']
            if automatic and (done is not None or hs or audio_files(item) or has_edits(item)):
                return False
            if done is not None and not (isinstance(done, dict) and done.get('superseded_by')):
                return False
            write_json(item / 'done.json', {
                'superseded_by': newer['id'], 'superseded_version': newer['version'], 'superseded_at': now(),
                'automatic': bool(automatic), 'edited': has_edits(item), 'count': len(hs),
                'change': sum(1 for h in hs if h.get('tag') == 'change'),
                'discuss': sum(1 for h in hs if h.get('tag') == 'discuss')})
        with self.state_lock:
            self.replaced[iid] = {'version': newer['version'], 'by': newer['id'], 'at': now(), 'path': str(item)}
            if self.state:
                try:
                    self.state.parent.mkdir(parents=True, exist_ok=True)
                    write_json(self.state, self.replaced)
                except OSError as e:
                    print('%s could not save %s: %s' % (now(), self.state, e), flush=True)
        return True

    def sweep(self):
        """Rescan, then close each older waiting version that has no highlights, voice notes, or edits once a
        higher version of its document is queued. Returns [(closed item, newer item)] as summaries."""
        with self.sweeping:
            items = self.all(fresh=True)
            if not self.auto_close:
                return []
            rows = []
            for r, i in items.values():
                try:
                    rows.append(summary(r, i))
                except (OSError, ValueError, TypeError):
                    pass                                     # an unreadable item is left alone
            top = newest_versions(rows)
            closed = []
            for s in rows:
                t = top.get(s['doc']) if s['version'] is not None else None
                if not t or s['status'] != 'waiting' or s['version'] >= t['version']:
                    continue
                if s['count'] or s['voice_notes'] or s['edited']:
                    continue                                 # the reviewer has marked it, so only they close it
                if self.replaced.get(s['id'], {}).get('version', -1) >= t['version']:
                    continue                                 # reopened since this server closed it
                if self.supersede(s['id'], items[s['id']][1], t, automatic=True):
                    closed.append((s, t))
                    print('%s superseded %s (v%s) by %s (v%s)' % (now(), s['name'], s['version'], t['name'], t['version']),
                          flush=True)
            return closed

    def keep_sweeping(self):
        while True:
            time.sleep(SWEEP)
            try:
                self.sweep()
            except Exception as e:                           # keep going; the next pass may succeed
                print('%s closing older versions failed: %s: %s' % (now(), type(e).__name__, e), flush=True)


def make_handler(store, token):
    class Handler(http.server.BaseHTTPRequestHandler):
        server_version = 'review-server/3'
        protocol_version = 'HTTP/1.1'

        def log_message(self, fmt, *args):
            sys.stderr.write('%s %s\n' % (self.log_date_time_string(), fmt % args))

        def reply(self, code, body=b'', ctype='application/json; charset=utf-8', headers=None):
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            if 'Cache-Control' not in (headers or {}):
                self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(body)

        def json_reply(self, code, obj):
            self.reply(code, json.dumps(obj, ensure_ascii=False).encode('utf-8'))

        def route(self):
            """Read any body, check the token and the change guard, then split the path.
            Returns None when a reply has already been sent."""
            # Always consume the body first: on a kept-alive connection, unread bytes would corrupt the next request.
            self._body = b''
            n = int(self.headers.get('Content-Length') or 0)
            if n > MAX_BODY:
                self.close_connection = True
                self.reply(413, b'Request too large.\n', 'text/plain; charset=utf-8')
                return None
            if n:
                self._body = self.rfile.read(n)
            url = urllib.parse.urlsplit(self.path)
            client = self.client_address[0]
            local = client.startswith('127.') or client in ('::1', '::ffff:127.0.0.1')
            if token and not local:
                cookies = [c.strip() for c in self.headers.get('Cookie', '').split(';')]
                ok = any(c.startswith('review_token=') and secrets.compare_digest(c[13:], token) for c in cookies)
                ok = ok or secrets.compare_digest(self.headers.get('X-Review-Token', ''), token)
                given = urllib.parse.parse_qs(url.query).get('token', [''])[0]
                if not ok and given and secrets.compare_digest(given, token) and self.command == 'GET':
                    self.reply(303, b'', 'text/plain', {
                        'Location': url.path or '/',
                        'Set-Cookie': 'review_token=%s; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict' % token})
                    return None
                if not ok:
                    self.reply(401, b'Open this address once with ?token=... at the end.\n', 'text/plain; charset=utf-8')
                    return None
            # Changes need this header. Other websites cannot send it without the server's permission,
            # so a page elsewhere cannot change the queue through your browser.
            if self.command in ('PUT', 'POST', 'DELETE') and self.headers.get('X-Review') != '1':
                self.json_reply(403, {'error': 'missing X-Review header'})
                return None
            self._query = urllib.parse.parse_qs(url.query)
            return [urllib.parse.unquote(p) for p in url.path.split('/') if p]

        def body(self):
            data = json.loads(self._body.decode('utf-8') or '{}') if self._body else {}
            if not isinstance(data, dict):
                raise ValueError('expected a JSON object')
            return data

        def static(self, rel):
            p = (STATIC / rel).resolve()
            try:
                p.relative_to(STATIC)
            except ValueError:
                return self.json_reply(404, {'error': 'not found'})
            if not p.is_file():
                return self.json_reply(404, {'error': 'not found'})
            ctype = mimetypes.guess_type(str(p))[0] or 'application/octet-stream'
            if ctype.startswith('text/') or ctype.endswith('javascript') or ctype.endswith('json'):
                ctype += '; charset=utf-8'
            cache = {'Cache-Control': 'max-age=86400'} if '/pdfjs/' in str(p) or '/codemirror/' in str(p) else None
            self.reply(200, p.read_bytes(), ctype, cache)

        def item(self, parts):
            found = store.get(parts[2]) if len(parts) > 2 else None
            if not found:
                self.json_reply(404, {'error': 'no such item; it may have moved'})
            return found

        def send_file(self, path, ctype, headers=None):
            """Send a file, honoring a byte range: Safari plays audio only from servers that do."""
            size = path.stat().st_size
            rng = self.headers.get('Range', '')
            if rng.startswith('bytes='):
                first, _, last = rng[6:].split(',')[0].strip().partition('-')
                try:
                    if first == '':
                        start, end = max(0, size - int(last)), size - 1
                    else:
                        start, end = int(first), (int(last) if last else size - 1)
                    end = min(end, size - 1)
                    if start > end:
                        raise ValueError
                except ValueError:
                    return self.reply(416, b'', 'text/plain', {'Content-Range': 'bytes */%d' % size})
                with open(path, 'rb') as f:
                    f.seek(start)
                    data = f.read(end - start + 1)
                return self.reply(206, data, ctype, dict({'Content-Range': 'bytes %d-%d/%d' % (start, end, size),
                                                          'Accept-Ranges': 'bytes'}, **(headers or {})))
            self.reply(200, path.read_bytes(), ctype, dict({'Accept-Ranges': 'bytes'}, **(headers or {})))

        def clip(self, item, name):
            if not SAFE_FILE.match(name) or Path(name).suffix not in EXT_TYPE:
                return None
            p = item / 'audio' / name
            return p if p.is_file() else None

        def do_HEAD(self):
            self.do_GET()

        def do_GET(self):
            parts = self.route()
            if parts is None:
                return
            if not parts:
                return self.static('index.html')
            if parts[0] == 'static':
                return self.static('/'.join(parts[1:]))
            if parts[:2] != ['api', 'items']:
                return self.json_reply(404, {'error': 'not found'})
            if len(parts) == 2:
                rows = sorted((summary(r, i) for r, i in store.all(fresh=True).values()), key=lambda s: s['queued_at'])
                return self.json_reply(200, {'items': rows, 'inbox': bool(store.inbox)})
            found = self.item(parts)
            if not found:
                return
            root, item = found
            req = read_json(item / 'request.json', {}) or {}
            if len(parts) == 3:
                reply = {'item': summary(root, item), 'request': req,
                         'highlights': load_highlights(item), 'done': read_json(item / 'done.json'),
                         'transcripts': transcripts(item), 'transcribe': store.transcriber.ok}
                if req.get('text'):
                    reply['text'] = text_state(item, req)
                return self.json_reply(200, reply)
            if parts[3:] == ['file']:
                name = Path(req.get('text') or req.get('pdf', '')).name
                f = item / name
                if not name or not f.is_file():
                    return self.json_reply(404, {'error': 'the file is missing from the item folder'})
                return self.send_file(f, 'text/plain; charset=utf-8' if req.get('text') else 'application/pdf')
            if len(parts) == 5 and parts[3] == 'images':
                ext = Path(parts[4]).suffix.lower()
                p = item / 'images' / parts[4]
                if not SAFE_FILE.match(parts[4]) or ext not in IMAGE_TYPES or not p.is_file():
                    return self.json_reply(404, {'error': 'no such image'})
                # An SVG opened by itself could run scripts on this site; a sandbox stops that.
                return self.send_file(p, IMAGE_TYPES[ext], {'Content-Security-Policy': 'sandbox; default-src \'none\'; '
                                                            'style-src \'unsafe-inline\'; img-src data:'}
                                      if ext == '.svg' else None)
            if parts[3:] == ['transcripts']:
                return self.json_reply(200, {'transcripts': transcripts(item), 'transcribe': store.transcriber.ok})
            if len(parts) == 5 and parts[3] == 'audio':
                p = self.clip(item, parts[4])
                if not p:
                    return self.json_reply(404, {'error': 'no such voice note'})
                return self.send_file(p, EXT_TYPE[p.suffix])
            self.json_reply(404, {'error': 'not found'})

        def do_PUT(self):
            parts = self.route()
            if parts is None:
                return
            if parts[:2] != ['api', 'items'] or parts[3:] not in (['highlights'], ['text']):
                return self.json_reply(404, {'error': 'not found'})
            found = self.item(parts)
            if not found:
                return
            root, item = found
            if parts[3] == 'text':
                return self.save_text(root, item, parts[2])
            try:
                data = self.body()
                highlights = clean_highlights(data.get('highlights'))
                base = int(data.get('base_version', -1))
                sent_max = int(data.get('max_n', 0))
            except (ValueError, KeyError, TypeError) as e:
                return self.json_reply(400, {'error': str(e)})
            with store.item_lock(parts[2]):
                current = load_highlights(item)
                if base != current['version']:
                    return self.json_reply(409, {'error': 'changed on another device', 'highlights': current})
                max_n = max([sent_max, current['max_n']] + [h['n'] for h in highlights])
                new = {'version': current['version'] + 1, 'updated_at': now(), 'max_n': max_n, 'highlights': highlights}
                write_json(item / 'highlights.json', new)
            self.json_reply(200, {'highlights': new, 'item': summary(root, item)})

        def save_text(self, root, item, iid):
            """Save the reviewer's edits, unless the file changed since this page read it. The file as queued
            is never changed, and text the same as it means no edits."""
            req = read_json(item / 'request.json', {}) or {}
            if not req.get('text'):
                return self.json_reply(400, {'error': 'this item is not a text file'})
            try:
                data = self.body()
                if not isinstance(data.get('text'), str):
                    raise ValueError('text must be a string')
                body = data['text'].encode('utf-8')
                decode_text(body)
            except ValueError as e:
                return self.json_reply(400, {'error': str(e)})
            name = Path(req['text']).name
            with store.item_lock(iid):
                state = text_state(item, req)
                if str(data.get('base_sha256')) != state['sha256']:
                    return self.json_reply(409, {'error': 'changed on another device', 'text': state})
                edited = item / 'edited' / name
                if body == (item / name).read_bytes():
                    if edited.exists():
                        edited.unlink()
                        edited.parent.rmdir()
                else:
                    edited.parent.mkdir(exist_ok=True)
                    write_bytes(edited, body)
            state = text_state(item, req)
            self.json_reply(200, {'text': {k: state[k] for k in ('edited', 'sha256', 'updated_at')},
                                  'item': summary(root, item)})

        def do_POST(self):
            parts = self.route()
            if parts is None:
                return
            if parts == ['api', 'queue']:
                return self.upload()
            if parts[:2] != ['api', 'items'] or parts[3:] not in (['done'], ['audio'], ['images']):
                return self.json_reply(404, {'error': 'not found'})
            found = self.item(parts)
            if not found:
                return
            root, item = found
            if parts[3] == 'audio':
                return self.add_clip(item)
            if parts[3] == 'images':
                req = read_json(item / 'request.json', {}) or {}
                if not req.get('text'):
                    return self.json_reply(400, {'error': 'this item is not a text file'})
                get = lambda k: (self._query.get(k, ['']) or [''])[0]
                try:
                    with store.item_lock(parts[2]):
                        images = add_image(item, get('ref'), get('filename'), self._body)
                except ValueError as e:
                    return self.json_reply(400, {'error': str(e)})
                return self.json_reply(200, {'images': images})
            try:
                newer = self.body().get('superseded_by')
            except ValueError:
                newer = None                                 # a body that is not JSON just marks it done
            if newer:
                return self.replace(root, item, parts[2], str(newer))
            with store.item_lock(parts[2]):
                hs = load_highlights(item)['highlights']
                write_json(item / 'done.json', {
                    'done_at': now(), 'edited': has_edits(item), 'count': len(hs),
                    'change': sum(1 for h in hs if h.get('tag') == 'change'),
                    'discuss': sum(1 for h in hs if h.get('tag') == 'discuss')})
            self.json_reply(200, {'item': summary(root, item)})

        def replace(self, root, item, iid, newer_id):
            """Mark older done: close an item as replaced by a higher version of the same document."""
            found = store.get(newer_id)
            if not found:
                return self.json_reply(404, {'error': 'no item %s to replace it' % newer_id})
            s, n = summary(root, item), summary(*found)
            if s['version'] is None or n['version'] is None or s['doc'] != n['doc'] or n['version'] <= s['version']:
                return self.json_reply(400, {'error': 'only a higher version of the same document can replace it'})
            if not store.supersede(iid, item, n, automatic=False):
                return self.json_reply(409, {'error': 'the reviewer has marked it done; Reopen it first'})
            self.json_reply(200, {'item': summary(root, item)})

        def upload(self):
            if not store.inbox:
                return self.json_reply(400, {'error': 'this server has no inbox; start it with --inbox FOLDER'})
            get = lambda k: (self._query.get(k, ['']) or [''])[0].strip()[:2000]
            if get('version') and not re.match(r'^[0-9]{1,9}$', get('version')):
                return self.json_reply(400, {'error': 'version must be a whole number'})
            name = get('filename') or 'document.pdf'
            if is_text_name(name):
                try:
                    decode_text(self._body)
                except ValueError as e:
                    return self.json_reply(400, {'error': str(e)})
            elif not self._body.startswith(b'%PDF-'):
                return self.json_reply(400, {'error': 'send a PDF, or a .txt, .md, or .tex file'})
            item = make_item(store.inbox, name, self._body, {
                'title': get('title'), 'note': get('note'), 'by': get('by'), 'group': get('group')[:80],
                'doc': get('doc')[:200], 'version': int(get('version')) if get('version') else None,
                'source': 'sent to the server as %s' % Path(name.replace('\\', '/')).name[:200]})
            store.sweep()                                    # rescan, and close the older versions this replaces
            self.json_reply(200, {'item': summary(store.inbox, item)})

        def add_clip(self, item):
            """Save a voice note for one highlight; the page then lists it in that highlight."""
            hid = (self._query.get('highlight', ['']) or [''])[0]
            if not re.match(r'^[A-Za-z0-9_-]{1,40}$', hid):
                return self.json_reply(400, {'error': 'which highlight is this for?'})
            ctype = (self.headers.get('Content-Type') or '').split(';')[0].strip().lower()
            ext = AUDIO_EXT.get(ctype)
            if not ext:
                return self.json_reply(400, {'error': 'unsupported audio type %r' % ctype})
            if not self._body:
                return self.json_reply(400, {'error': 'the recording is empty'})
            d = item / 'audio'
            d.mkdir(exist_ok=True)
            stamp = dt.datetime.now().strftime('%Y%m%d-%H%M%S')
            name, k = '%s_%s%s' % (hid, stamp, ext), 2
            while (d / name).exists():
                name, k = '%s_%s-%d%s' % (hid, stamp, k, ext), k + 1
            (d / name).write_bytes(self._body)
            store.transcriber.add(d / name)
            self.json_reply(200, {'file': name, 'mime': EXT_TYPE[ext], 'size': len(self._body),
                                  'transcribe': store.transcriber.ok})

        def do_DELETE(self):
            parts = self.route()
            if parts is None:
                return
            if parts[:2] != ['api', 'items']:
                return self.json_reply(404, {'error': 'not found'})
            found = self.item(parts)
            if not found:
                return
            root, item = found
            if len(parts) == 5 and parts[3] == 'audio':
                p = self.clip(item, parts[4])
                if p:
                    p.unlink()
                    side = p.with_name(p.name + '.json')
                    if side.exists():
                        side.unlink()
                return self.json_reply(200, {'deleted': bool(p)})
            if parts[3:] != ['done']:
                return self.json_reply(404, {'error': 'not found'})
            with store.item_lock(parts[2]):
                if (item / 'done.json').exists():
                    (item / 'done.json').unlink()
            self.json_reply(200, {'item': summary(root, item)})

    return Handler


def saved_token():
    """The token other devices need: $REVIEW_TOKEN, else one kept in ~/.config/review-server/token."""
    if os.environ.get('REVIEW_TOKEN'):
        return os.environ['REVIEW_TOKEN']
    path = Path.home() / '.config' / 'review-server' / 'token'
    if path.is_file() and path.read_text().strip():
        return path.read_text().strip()
    path.parent.mkdir(parents=True, exist_ok=True)
    token = secrets.token_urlsafe(9)
    path.write_text(token + '\n')
    os.chmod(str(path), 0o600)
    return token


def run_quiet(cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=4).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ''


def other_addresses():
    """(label, host) pairs that other devices can use to reach this computer."""
    out = []
    if sys.platform == 'darwin':
        name = run_quiet(['scutil', '--get', 'LocalHostName'])
        if name:
            out.append(('iPad on the same Wi-Fi:', name + '.local'))
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('10.255.255.255', 1))   # picks the outgoing interface; nothing is sent
        out.append(('iPad on the same Wi-Fi:' if not out else '                    or', s.getsockname()[0]))
    except OSError:
        pass
    finally:
        s.close()
    cli = shutil.which('tailscale') or '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
    raw = run_quiet([cli, 'status', '--json']) if os.path.exists(cli) else ''
    try:
        me = json.loads(raw).get('Self', {}) if raw else {}
    except ValueError:
        me = {}
    ts = (me.get('DNSName') or '').rstrip('.') or (me.get('TailscaleIPs') or [''])[0]
    if ts:
        out.append(('iPad over Tailscale:', ts))
    return out


def cmd_serve(a):
    roots = roots_from(a.root) if (a.root or os.environ.get('REVIEW_ROOTS') or not a.inbox) else []
    inbox = None
    if a.inbox:
        inbox = Path(a.inbox).expanduser().resolve()
        inbox.mkdir(parents=True, exist_ok=True)
        if inbox not in roots:
            roots.append(inbox)
    host = '0.0.0.0' if a.lan else a.host
    loopback = host in ('127.0.0.1', 'localhost', '::1')
    token = '' if loopback else saved_token()
    transcriber = Transcriber()
    state = Path(a.state).expanduser() if a.state else Path.home() / '.config' / 'review-server' / 'replaced.json'
    store = Store(roots, inbox, transcriber, auto_close=not a.no_auto_close, state=state)
    server = http.server.ThreadingHTTPServer((host, a.port), make_handler(store, token))
    server.daemon_threads = True
    closed = store.sweep()
    items = find_items(roots)
    waiting = sum(1 for _, i in items if not (i / 'done.json').exists())
    print('Review queue for %s: %d waiting.' % (', '.join(map(str, roots)), waiting))
    if store.auto_close:
        threading.Thread(target=store.keep_sweeping, daemon=True).start()
        print('Older versions without highlights or voice notes are closed when a newer one is queued (%d just now; '
              'record in %s). --no-auto-close turns this off.' % (len(closed), state))
    else:
        print('Older versions are not closed automatically (--no-auto-close).')
    if inbox:
        print('Files sent with push or Add file go to %s.' % inbox)
    if transcriber.ok:
        todo = [p for _, i in items for p in audio_files(i) if not p.with_name(p.name + '.json').exists()]
        for p in todo:
            transcriber.add(p)
        print('Voice notes are transcribed here with faster-whisper (model %s, loaded when needed)%s.'
              % (transcriber.name, '; %d waiting' % len(todo) if todo else ''))
    else:
        print('Voice notes are saved but not transcribed: install faster-whisper for %s to transcribe them.' % sys.executable)
    print('  %-24s http://localhost:%d/' % ('On this computer:', a.port))
    if not loopback:
        others = other_addresses() if host == '0.0.0.0' else [('Other devices:', host)]
        for label, name in others:
            print('  %-24s http://%s:%d/?token=%s' % (label, name, a.port, token))
        print('  Other devices need the token once; the browser then remembers it.')
    print('Leave this running while you review. Control-C stops the server.', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print()


def main(argv=None):
    ap = argparse.ArgumentParser(description='Review queue for PDFs marked up on an iPad, and text files to edit.')
    sub = ap.add_subparsers(dest='cmd')
    q = sub.add_parser('queue', help='queue a PDF or text file for review (on the machine that holds the files)')
    q.add_argument('file')
    q.add_argument('--title', required=True)
    q.add_argument('--note', help='what the reviewer should look at')
    q.add_argument('--by', help='who queued it')
    q.add_argument('--into', help='folder to hold review_queue (default: the folder above drafts/, else the PDF\'s folder)')
    q.add_argument('--doc', help='the document this is a version of (default: the file name before its _v<number>)')
    q.add_argument('--version', type=int, help='its version number (default: the _v<number> in the file name)')
    ls = sub.add_parser('list', help='list items waiting for review')
    ls.add_argument('--root', action='append')
    ls.add_argument('--all', action='store_true', help='include items marked done')
    sh = sub.add_parser('show', help='print an item\'s numbered highlights')
    sh.add_argument('item')
    sh.add_argument('--root', action='append')
    sh.add_argument('--json', action='store_true')
    sv = sub.add_parser('serve', help='run the web page')
    sv.add_argument('--root', action='append')
    sv.add_argument('--inbox', help='folder for files sent with push or the Add file button (also shown in the queue)')
    sv.add_argument('--lan', action='store_true', help='also listen on the local network, with a token')
    sv.add_argument('--host', default='127.0.0.1', help='address to listen on (default: this computer only)')
    sv.add_argument('--port', type=int, default=8765)
    sv.add_argument('--no-auto-close', action='store_true',
                    help='do not close older waiting versions when a newer version is queued')
    sv.add_argument('--state', help='where to remember the items closed as replaced '
                                    '(default ~/.config/review-server/replaced.json)')
    pu = sub.add_parser('push', help='send a PDF or text file to a review server\'s inbox')
    pu.add_argument('file')
    pu.add_argument('--server', required=True, help='for example https://<machine>.<tailnet>.ts.net')
    pu.add_argument('--title', required=True)
    pu.add_argument('--note')
    pu.add_argument('--by')
    pu.add_argument('--group', help='what it belongs to, shown on its card (for example an application folder)')
    pu.add_argument('--doc', help='the document this is a version of (default: the file name before its _v<number>)')
    pu.add_argument('--version', type=int, help='its version number (default: the _v<number> in the file name)')
    pl = sub.add_parser('pull', help='list a review server\'s items, or print one item\'s highlights')
    pl.add_argument('item', nargs='?')
    pl.add_argument('--server', required=True)
    pl.add_argument('--json', action='store_true')
    a = ap.parse_args(argv)
    if not a.cmd:
        ap.print_help()
        return 2
    {'queue': cmd_queue, 'list': cmd_list, 'show': cmd_show, 'serve': cmd_serve,
     'push': cmd_push, 'pull': cmd_pull}[a.cmd](a)
    return 0


if __name__ == '__main__':
    sys.exit(main())
