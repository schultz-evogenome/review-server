/* Review queue: list of PDFs waiting for markup, a viewer for highlighting them, and an editor for text files.
   Highlights are stored in PDF points from the top-left corner of each page. */
'use strict';
(function () {
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/static/pdfjs/pdf.worker.min.js';

  const S = {
    item: null,        // summary of the open item
    hl: [],            // highlights
    version: 0,        // server version of highlights.json
    deleted: new Set(),
    maxN: 0,
    pages: [],         // {n, div, text, over, scale}
    pdf: null,
    tool: 'select',
    finger: false,
    width: 0,
    dirty: false,
    saving: false,
    lastRange: null,
    openN: null,
    lastAdded: null,
    loadToken: 0,
    transcripts: {},   // voice note file -> {text} | {error} | {pending}
    canTranscribe: false,
    rec: null,         // the recording in progress
    uploading: 0,
    reopen: false,     // whether the Done button shows Reopen
  };

  // ------------------------------------------------------------ helpers

  async function api(path, opts) {
    const r = await fetch(path, Object.assign({ credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Review': '1' } }, opts || {}));
    const text = await r.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (e) { body = { error: text }; }
    if (!r.ok) {
      const err = new Error((body && body.error) || r.statusText || ('HTTP ' + r.status));
      err.status = r.status; err.body = body;
      throw err;
    }
    return body;
  }

  function toast(msg, ms) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, ms || 2200);
  }
  const setStatus = s => { $('#status').textContent = s; };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const oneLine = s => String(s || '').replace(/\s+/g, ' ').trim();
  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d) ? iso : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function isoLocal() {
    const d = new Date(), off = -d.getTimezoneOffset(), p = x => String(Math.floor(Math.abs(x))).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' +
      p(d.getSeconds()) + (off >= 0 ? '+' : '-') + p(off / 60) + ':' + p(off % 60);
  }
  const newId = () => 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  // ------------------------------------------------------------ theme

  const THEMES = ['auto', 'dark', 'light'], THEME_LABEL = { auto: 'Theme: auto', dark: 'Theme: dark', light: 'Theme: light' };
  function showTheme() {
    let t = 'auto';
    try { t = localStorage.getItem('review.theme') || 'auto'; } catch (e) { /* follows the device */ }
    if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
    $('#themeBtn').textContent = THEME_LABEL[t] || THEME_LABEL.auto;
    return t;
  }
  $('#themeBtn').addEventListener('click', () => {
    const next = THEMES[(THEMES.indexOf(showTheme()) + 1) % THEMES.length];
    try { localStorage.setItem('review.theme', next); } catch (e) { /* this page only */ }
    if (next === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = next;
    $('#themeBtn').textContent = THEME_LABEL[next];
  });
  showTheme();

  // ------------------------------------------------------------ routing

  window.addEventListener('hashchange', route);
  $('#back').addEventListener('click', async () => {
    await flush();
    if (unsavedWarning()) return;
    location.hash = '#/';
  });
  $('#refresh').addEventListener('click', () => showQueue());

  function route() {
    const m = location.hash.match(/^#\/item\/([0-9a-f]{6,40})$/);
    if (m && T.cm && S.item && S.item.id === m[1]) return;     // came back from a refused Back
    if (m) openItem(m[1]); else showQueue();
  }

  // ------------------------------------------------------------ queue

  async function showQueue() {
    await flush();
    // Back in the browser comes here too: stay with text that could not be saved.
    if (T.cm && S.item && unsavedWarning()) { location.hash = '#/item/' + S.item.id; return; }
    teardown();
    S.item = null;
    $('#viewer').hidden = true; $('#queue').hidden = false; $('#brief').hidden = true;
    $('#tools').hidden = true; $('#back').hidden = true; $('#doneBtn').hidden = true; $('#refresh').hidden = false;
    $('#addBtn').hidden = true;
    $('#title').textContent = 'Review queue'; document.title = 'Review queue'; setStatus('');
    const q = $('#queue');
    q.innerHTML = '<p class="muted">Loading&hellip;</p>';
    let items;
    try {
      const data = await api('/api/items');
      items = data.items;
      $('#addBtn').hidden = !data.inbox;
    }
    catch (e) { q.innerHTML = '<p class="error">Could not load the queue: ' + esc(e.message) + '</p>'; return; }
    const byId = new Map(items.map(i => [i.id, i]));
    const cards = groupWaiting(items.filter(i => i.status === 'waiting'));
    const done = items.filter(i => i.status === 'done').sort((a, b) => String(b.done_at || '').localeCompare(String(a.done_at || '')));
    const replaced = items.filter(i => i.status === 'superseded').sort((a, b) => String(b.superseded_at || '').localeCompare(String(a.superseded_at || '')));
    const replacedBy = i => {
      const n = byId.get(i.superseded_by), v = n ? n.version : i.superseded_version;
      return 'replaced by ' + (v == null ? 'a newer version' : 'v' + v) + ' &middot; closed ' + (i.superseded_auto ? 'automatically ' : '') + esc(fmtTime(i.superseded_at));
    };
    const card = (i, older) => '<div class="card ' + i.status + '" data-id="' + i.id + '">' +
      '<a class="card-link" href="#/item/' + i.id + '">' +
      '<div class="card-title">' + esc(i.title) + '</div>' +
      '<div class="card-meta">' + esc(i.folder) + (i.version == null ? '' : ' &middot; v' + i.version) +
      ' &middot; queued ' + esc(fmtTime(i.queued_at)) + (i.queued_by ? ' by ' + esc(i.queued_by) : '') +
      (i.status === 'done' ? ' &middot; done ' + esc(fmtTime(i.done_at)) : '') +
      (i.status === 'superseded' ? ' &middot; ' + replacedBy(i) : '') + '</div>' +
      (i.note ? '<div class="card-note">' + esc(i.note) + '</div>' : '') +
      '<div class="card-counts">' + (i.kind === 'text' ? (i.edited ? 'Text file, edited' : 'Text file, no edits yet') : i.count ? i.count + ' highlight' + (i.count === 1 ? '' : 's') + ': ' + i.change + ' change, ' + i.discuss + ' discuss' : 'No highlights yet') + '</div>' +
      '</a>' + (older && older.length ? olderBlock(older) : '') + '</div>';
    Q.cards = new Map(cards.map(c => [c.item.id, c]));
    q.innerHTML = '<h2>Waiting <span class="count">' + cards.length + '</span></h2>' +
      (cards.length ? cards.map(c => card(c.item, c.older)).join('') : '<p class="muted">Nothing waiting.</p>') +
      (done.length ? '<details><summary>Done <span class="count">' + done.length + '</span></summary>' + done.map(i => card(i)).join('') + '</details>' : '') +
      (replaced.length ? '<details><summary>Replaced <span class="count">' + replaced.length + '</span></summary>' +
        '<p class="muted">Older versions closed when a newer one arrived. Open one and tap Reopen to put it back in Waiting.</p>' +
        replaced.map(i => card(i)).join('') + '</details>' : '');
  }

  // ------------------------------------------------------------ versions of one document

  const Q = { cards: new Map() };   // waiting card id -> {item, older}
  const marks = i => [i.count ? i.count + ' highlight' + (i.count === 1 ? '' : 's') : '',
    i.voice_notes ? i.voice_notes + ' voice note' + (i.voice_notes === 1 ? '' : 's') : '',
    i.edited ? 'your edits' : ''].filter(Boolean).join(', ');

  // One card per document: its newest waiting version, carrying the older waiting versions. An item without
  // a version is a document of its own, and items with the same version stay separate cards.
  function groupWaiting(waiting) {
    const docs = new Map(), cards = [];
    for (const i of waiting) {
      if (i.version == null) { cards.push({ item: i, older: [] }); continue; }
      if (!docs.has(i.doc)) docs.set(i.doc, []);
      docs.get(i.doc).push(i);
    }
    for (const list of docs.values()) {
      list.sort((a, b) => b.version - a.version || String(b.queued_at).localeCompare(String(a.queued_at)));
      const heads = list.filter(i => i.version === list[0].version);
      cards.push({ item: heads[0], older: list.filter(i => i.version < list[0].version) });
      heads.slice(1).forEach(i => cards.push({ item: i, older: [] }));
    }
    return cards.sort((a, b) => String(a.item.queued_at).localeCompare(String(b.item.queued_at)));
  }

  function olderBlock(older) {
    return '<div class="older"><div class="older-row">' +
      '<button class="older-toggle" aria-expanded="false">' + older.length + ' older version' + (older.length === 1 ? '' : 's') + '</button>' +
      '<button class="older-done">Mark older done</button></div>' +
      '<div class="older-list" hidden>' + older.map(i => '<a href="#/item/' + i.id + '"><b>v' + i.version + '</b> ' + esc(i.title) +
        '<span class="muted"> &middot; queued ' + esc(fmtTime(i.queued_at)) + ' &middot; ' + (marks(i) || (i.kind === 'text' ? 'No edits' : 'No highlights')) + '</span></a>').join('') + '</div>' +
      '<div class="older-ask" hidden></div></div>';
  }

  $('#queue').addEventListener('click', e => {
    const b = e.target.closest('button');
    const el = b && b.closest('.card');
    const c = el && Q.cards.get(el.dataset.id);
    if (!c) return;
    const ask = $('.older-ask', el);
    if (b.classList.contains('older-toggle')) {
      const list = $('.older-list', el);
      list.hidden = !list.hidden;
      b.setAttribute('aria-expanded', String(!list.hidden));
    } else if (b.classList.contains('older-done')) {
      const marked = c.older.filter(i => marks(i)), plain = c.older.filter(i => !marks(i));
      if (!marked.length) { closeOlder(c.item, c.older); return; }
      ask.innerHTML = '<p>' + (marked.length === 1 ? 'This older version has' : 'These older versions have') + ' your highlights, voice notes, or edits:</p>' +
        '<ul>' + marked.map(i => '<li><b>v' + i.version + '</b> ' + esc(i.title) + ' <span class="muted">(' + marks(i) + ')</span></li>').join('') + '</ul>' +
        '<p>Close ' + (marked.length === 1 ? 'it' : 'them') + ' too? Closed versions go to Replaced, not Done, and Reopen brings them back.</p>' +
        '<div class="row"><button data-close="none">Cancel</button>' +
        (plain.length ? '<button data-close="plain">Close only the ' + plain.length + ' without marks</button>' : '') +
        '<button data-close="all" class="danger">Close ' + (plain.length ? 'all ' + c.older.length : (marked.length === 1 ? 'it' : 'them')) + '</button></div>';
      ask.hidden = false;
    } else if (b.dataset.close) {
      ask.hidden = true;
      if (b.dataset.close === 'all') closeOlder(c.item, c.older);
      else if (b.dataset.close === 'plain') closeOlder(c.item, c.older.filter(i => !marks(i)));
    }
  });

  async function closeOlder(newest, list) {
    let n = 0;
    const failed = [];
    for (const i of list) {
      try { await api('/api/items/' + i.id + '/done', { method: 'POST', body: JSON.stringify({ superseded_by: newest.id }) }); n++; }
      catch (e) { failed.push('v' + i.version + ': ' + e.message); }
    }
    if (failed.length) toast('Could not close ' + failed.join('; '), 6000);
    else toast('Closed ' + n + ' older version' + (n === 1 ? '; it is' : 's; they are') + ' under Replaced');
    showQueue();
  }

  // ------------------------------------------------------------ adding a PDF from this device

  let pendingFile = null;
  $('#addBtn').addEventListener('click', () => $('#addFile').click());
  $('#addFile').addEventListener('change', () => {
    const f = $('#addFile').files[0];
    if (!f) return;
    pendingFile = f;
    $('#addName').textContent = f.name + ' (' + Math.max(1, Math.round(f.size / 1024)) + ' KB)';
    $('#addTitle').value = f.name.replace(/\.(pdf|txt|md|markdown|tex)$/i, '').replace(/_+/g, ' ');
    $('#addNote').value = '';
    $('#addPanel').hidden = false;
  });
  function closeAdd() { $('#addPanel').hidden = true; pendingFile = null; $('#addFile').value = ''; }
  $('#addCancel').addEventListener('click', closeAdd);
  $('#addGo').addEventListener('click', async () => {
    if (!pendingFile) return;
    const go = $('#addGo');
    const q = new URLSearchParams({ title: $('#addTitle').value.trim() || pendingFile.name, note: $('#addNote').value.trim(), filename: pendingFile.name });
    go.disabled = true; go.textContent = 'Sending…';
    try {
      const r = await fetch('/api/queue?' + q.toString(), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': pendingFile.type || 'application/octet-stream', 'X-Review': '1' }, body: pendingFile });
      let body = {};
      try { body = await r.json(); } catch (e) { /* not JSON */ }
      if (!r.ok) throw new Error(body.error || r.statusText);
      closeAdd();
      toast('Added to the queue');
      showQueue();
    } catch (e) {
      toast('Could not add it: ' + e.message, 5000);
    } finally {
      go.disabled = false; go.textContent = 'Add to queue';
    }
  });

  // ------------------------------------------------------------ text editor

  const T = {
    cm: null,
    sha: '',           // sha256 of the text as last saved
    original: '',      // the file as queued
    origLines: [],
    crlf: false,
    dirty: false,
    saving: false,
    conflict: null,    // the other device's text, until a version is chosen
    timer: null,
    refreshTimer: null,
    marks: [],         // tints on edited text
    images: {},        // reference in the text -> file in the item's images folder
    refs: [],          // images in the order of the text: {line, ref, alt, node, widget}
    imgKey: '',
    nodes: new Map(),  // figures already built, kept so they need not load again
    addRef: null,
  };
  const CM = '/static/codemirror/', CM_VERSION = '?v=4';   // these files are cached; raise this when they change
  const pref = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* not remembered */ } },
  };

  let cmReady = null;
  function loadEditor() {
    if (cmReady) return cmReady;
    ['lib/codemirror.css', 'addon/dialog/dialog.css'].forEach(f => {
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = CM + f;
      document.head.insertBefore(l, $('link[href="/static/app.css"]'));   // app.css keeps the last word
    });
    const js = ['lib/codemirror.js', 'addon/search/searchcursor.js', 'addon/dialog/dialog.js', 'addon/edit/matchbrackets.js',
      'keymap/vim.js', 'mode/markdown/markdown.js', 'mode/stex/stex.js', '../vim-fixes.js', '../marked/marked.min.js'];
    cmReady = js.reduce((p, f) => p.then(() => new Promise((ok, no) => {
      const s = document.createElement('script');
      s.src = CM + f + CM_VERSION; s.onload = ok; s.onerror = () => no(new Error('could not load ' + f));
      document.head.appendChild(s);
    })), Promise.resolve()).then(() => {
      window.reviewVim.install({
        save: saveNow,
        leave: async () => { await flushText(); if (!T.conflict && !T.dirty) location.hash = '#/'; },
      });
    }).catch(e => { cmReady = null; throw e; });
    return cmReady;
  }

  async function openText(data, token) {
    $('#viewer').hidden = true; $('#tools').hidden = true;
    $('#editor').hidden = false; $('#textTools').hidden = false;
    document.body.classList.add('writing');
    $('#editor').innerHTML = '<div class="loading">Loading&hellip;</div>';
    try { await loadEditor(); }
    catch (e) { $('#editor').innerHTML = '<div class="loading error">Could not load the editor: ' + esc(e.message) + '</div>'; return; }
    if (token !== S.loadToken) return;
    $('#editor').innerHTML = '';
    const t = data.text, name = t.name.toLowerCase();
    // A file's last line break ends its last line, as in Vim; it is not one more empty line to land on.
    T.sha = t.sha256; T.original = t.original; T.origLines = t.original.replace(/\r?\n$/, '').split(/\r\n?|\n/);
    T.endsInBreak = /\n$/.test(t.current);
    T.crlf = /\r\n/.test(t.current); T.images = t.images || {};
    T.conflict = null; T.dirty = false; T.refs = []; T.imgKey = ''; T.nodes = new Map(); T.marks = [];
    T.saveError = ''; T.lastSent = null; T.typingSince = 0;
    // Every line's ending, so that one edit does not rewrite the endings of the others.
    T.origEnds = /\r/.test(t.original) ? t.original.match(/\r\n?|\n/g) || [] : null;
    $('#conflict').hidden = true;
    $('#vimOn').checked = pref.get('review.vim') === '1';
    T.cm = CodeMirror($('#editor'), {
      value: t.current.replace(/\r?\n$/, ''),
      indentWithTabs: /^\t/m.test(t.current),
      mode: /\.tex$/.test(name) ? 'stex' : /\.(md|markdown)$/.test(name) ? { name: 'markdown', highlightFormatting: true } : null,
      theme: 'goyo',
      keyMap: $('#vimOn').checked ? 'vim' : 'default',
      lineWrapping: true,            // wraps on screen only; the file's line breaks stay as they are
      viewportMargin: Infinity,      // the page scrolls, not a box inside it
      matchBrackets: true,
      showCursorWhenSelecting: true,
      spellcheck: true,
      autocorrect: false,
      readOnly: S.reopen,
    });
    T.cm.on('change', onTextChange);
    window.reviewVim.attach(T.cm);
    restoreDraft(t);
    T.cm.on('vim-mode-change', e => showVimMode(e.mode + (e.subMode ? ' ' + e.subMode : '')));
    showVimMode('normal');
    refreshChanges(); refreshImages(); updateWords();
    T.cm.on('cursorActivity', () => { clearTimeout(PV.syncTimer); PV.syncTimer = setTimeout(syncPreview, 80); });
    PV.figures = new Map();
    $('#previewBtn').hidden = !isMarkdown();
    setPreview(isMarkdown() && pref.get('review.preview') === '1');
    setStatus(t.edited ? 'Saved' : '');
    if (!S.reopen && window.matchMedia('(pointer: fine)').matches) T.cm.focus();
  }

  function closeText() {
    if (window.reviewVim) window.reviewVim.detach();
    setPreview(false);
    $('#previewBtn').hidden = true;
    clearTimeout(T.timer); clearTimeout(T.refreshTimer);
    T.cm = null; T.dirty = false; T.conflict = null;
    $('#editor').innerHTML = ''; $('#editor').hidden = true; $('#textTools').hidden = true;
    $('#imagesPanel').hidden = true; $('#conflict').hidden = true; $('#vimMode').hidden = true;
    document.body.classList.remove('writing', 'typing');
  }

  function showVimMode(mode) {
    const on = !!T.cm && $('#vimOn').checked;
    $('#vimMode').hidden = !on;
    if (on) $('#vimMode').textContent = mode;
  }
  $('#vimOn').addEventListener('change', e => {
    pref.set('review.vim', e.target.checked ? '1' : '0');
    if (!T.cm) return;
    T.cm.setOption('keyMap', e.target.checked ? 'vim' : 'default');
    showVimMode('normal');
    T.cm.focus();
  });

  // The toolbar slides away while typing and comes back when the pointer or a finger moves.
  function showBarAgain(e) {
    if (e.type === 'mousemove' && Math.abs(e.movementX) + Math.abs(e.movementY) < 3) return;
    document.body.classList.remove('typing');
  }
  document.addEventListener('mousemove', showBarAgain);
  document.addEventListener('touchstart', showBarAgain, { passive: true });
  $('#editor').addEventListener('click', e => { if (T.cm && e.target === e.currentTarget) T.cm.focus(); });

  function editorText() {
    const nl = T.cm.getValue('\n');
    if (nl === T.origLines.join('\n')) return T.original;      // exactly as queued, whatever its line endings
    // A lone half of an emoji cannot be stored, and would stop every later save.
    const clean = nl.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
    if (!T.origEnds) return clean + (T.endsInBreak ? '\n' : '');
    // Lines that have not changed keep their own endings; new ones take the file's most common.
    const crlf = T.origEnds.filter(e => e === '\r\n').length, lf = T.origEnds.filter(e => e === '\n').length, usual = crlf >= lf ? '\r\n' : '\n';
    const now = clean.split('\n'), out = [];
    let a = 0, b = 0;
    const put = (line, end, last) => out.push(line, last ? '' : end);
    for (const [a0, a1, b0, b1] of diffSeq(T.origLines, now).concat([[T.origLines.length, T.origLines.length, now.length, now.length]])) {
      while (b < b0) { put(now[b], T.origEnds[a] || usual, b === now.length - 1); a++; b++; }
      while (b < b1) { put(now[b], (a1 - a0 === b1 - b0 && T.origEnds[a0 + b - b0]) || usual, b === now.length - 1); b++; }
      a = a1;
    }
    if (T.endsInBreak) out.push(T.origEnds[T.origEnds.length - 1] || usual);
    return out.join('');
  }

  // A copy of unsaved text in this browser, in case the page closes before it reaches the server.
  const draftKey = () => 'review.draft.' + S.item.id;
  function keepDraft() {
    if (!T.cm || !S.item) return;
    try { localStorage.setItem(draftKey(), JSON.stringify({ base: T.sha, text: editorText(), at: Date.now() })); } catch (e) { /* too big, or not allowed */ }
  }
  function dropDraft() { try { localStorage.removeItem(draftKey()); } catch (e) { /* nothing kept */ } }
  function restoreDraft(t) {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(draftKey())); } catch (e) { /* none */ }
    if (!d) return;
    if (d.text === t.current || d.base !== t.sha256 || S.reopen) { dropDraft(); return; }
    T.cm.setValue(d.text.replace(/\r?\n$/, ''));
    toast('Restored edits that had not reached the server', 5000);
  }

  // Why the page should not be left, if there is a reason; says so.
  function unsavedWarning() {
    if (!T.cm) return false;
    if (T.conflict) { toast('Choose a version first', 4000); $('#conflict').hidden = false; return true; }
    if (T.dirty || T.saving) {
      document.body.classList.remove('typing');
      toast(T.saveError ? 'Not saved: ' + T.saveError : 'Your edits are not saved yet; try again in a moment', 5000);
      return true;
    }
    return false;
  }
  window.addEventListener('beforeunload', e => {
    if (T.cm && (T.dirty || T.saving || T.conflict)) { keepDraft(); e.preventDefault(); e.returnValue = ''; }
  });

  function onTextChange() {
    T.dirty = true;
    setStatus('Not saved yet');
    document.body.classList.add('typing');
    clearTimeout(T.timer);
    // Save when typing pauses, and at least every few seconds during steady typing.
    const now = Date.now();
    if (!T.typingSince) T.typingSince = now;
    T.timer = setTimeout(saveText, now - T.typingSince > 4000 ? 0 : 600);
    clearTimeout(T.refreshTimer);
    T.refreshTimer = setTimeout(() => { if (T.cm) { keepDraft(); refreshChanges(); refreshImages(); updateWords(); renderPreview(); } }, 250);
  }

  function updateWords() {
    const n = (T.cm.getValue().match(/\S+/g) || []).length;
    $('#wordCount').textContent = n.toLocaleString() + ' word' + (n === 1 ? '' : 's');
  }

  async function saveText() {
    if (!T.cm || T.conflict) return;
    if (T.saving) { clearTimeout(T.timer); T.timer = setTimeout(saveText, 400); return; }
    T.saving = true; T.typingSince = 0; setStatus('Saving…');
    const id = S.item.id, cm = T.cm, text = editorText();
    T.lastSent = text;
    try {
      const r = await api('/api/items/' + id + '/text', { method: 'PUT', body: JSON.stringify({ base_sha256: T.sha, text }) });
      if (T.cm !== cm) return;
      T.sha = r.text.sha256; T.saveError = '';
      T.dirty = editorText() !== text;     // still unsaved until the server has it, and if typing went on
      if (!T.dirty) dropDraft();
      if (S.item && S.item.id === id) S.item = r.item;
      setStatus(T.dirty ? 'Not saved yet' : 'Saved');
      if (T.dirty) { clearTimeout(T.timer); T.timer = setTimeout(saveText, 600); }
    } catch (e) {
      if (T.cm !== cm) return;
      T.dirty = true;
      keepDraft();
      if (e.status === 409 && e.body && e.body.closed) {
        T.saveError = e.message;
        setStatus('Not saved');
        document.body.classList.remove('typing');
        S.item = e.body.item;
        updateDoneBtn();
        toast(e.message, 6000);
      } else if (e.status === 409 && e.body && e.body.text) {
        showConflict(e.body.text);
      } else if (e.status >= 400 && e.status < 500) {
        T.saveError = e.message;
        setStatus('Not saved: ' + e.message);
        document.body.classList.remove('typing');
        toast('Not saved: ' + e.message, 6000);
      } else {
        T.saveError = 'the server cannot be reached';
        setStatus('Not saved; retrying');
        document.body.classList.remove('typing');
        clearTimeout(T.timer);
        T.timer = setTimeout(saveText, 4000);
      }
    } finally {
      T.saving = false;
    }
  }
  async function flushText() {
    if (!T.cm) return;
    // Text still being composed, as by dictation, is not in the editor until this.
    const input = T.cm.display && T.cm.display.input;
    if (input && input.forceCompositionEnd) { try { input.forceCompositionEnd(); } catch (e) { /* no composition */ } }
    if (input && input.poll) { try { input.poll(); } catch (e) { /* nothing to read */ } }
    clearTimeout(T.timer);
    for (let i = 0; i < 300 && T.saving; i++) await new Promise(r => setTimeout(r, 100));
    if (T.dirty && !T.conflict && !T.saving) await saveText();
  }
  async function saveNow() {
    await flushText();
    if (!T.cm) return;
    if (T.dirty || T.conflict || T.saving) unsavedWarning();
    else toast('Saved');
  }

  function showConflict(server) {
    if (T.cm && server.current === editorText()) {      // our last save arrived; only its answer was lost
      T.sha = server.sha256; T.dirty = false; T.saveError = ''; dropDraft(); setStatus('Saved');
      return;
    }
    if (T.cm && server.current === T.lastSent) {        // the same, and there has been more typing since
      T.sha = server.sha256;
      clearTimeout(T.timer);
      T.timer = setTimeout(saveText, 0);
      return;
    }
    T.conflict = server;
    setStatus('Not saved');
    document.body.classList.remove('typing');
    $('#conflict').hidden = false;
  }
  $('#keepMine').addEventListener('click', () => {
    T.sha = T.conflict.sha256; T.conflict = null;
    $('#conflict').hidden = true;
    saveText();
  });
  $('#useOther').addEventListener('click', () => {
    const server = T.conflict;
    T.conflict = null;
    $('#conflict').hidden = true;
    T.endsInBreak = /\n$/.test(server.current);
    T.cm.setValue(server.current.replace(/\r?\n$/, ''));   // Undo still brings your text back
    T.sha = server.sha256;
  });

  $('#revertBtn').addEventListener('click', () => {
    if (!T.cm || T.cm.getOption('readOnly')) return;
    if (T.cm.getValue('\n') === T.origLines.join('\n')) { toast('There are no edits'); return; }
    const btn = $('#revertBtn');
    if (!btn.dataset.armed) {          // two taps, because a reload after this cannot be undone
      btn.dataset.armed = '1'; btn.textContent = 'Tap again to revert';
      setTimeout(() => { delete btn.dataset.armed; btn.textContent = 'Revert'; }, 3000);
      return;
    }
    delete btn.dataset.armed; btn.textContent = 'Revert';
    T.cm.setValue(T.origLines.join('\n'));
    toast('Back to the file as queued. Undo brings your edits back.', 4000);
  });

  // What differs between two lists, as [aFrom, aTo, bFrom, bTo]. A very long changed stretch counts as one change.
  function diffSeq(a, b) {
    let s = 0, ea = a.length, eb = b.length;
    while (s < ea && s < eb && a[s] === b[s]) s++;
    while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
    const n = ea - s, m = eb - s;
    if (!n && !m) return [];
    if (!n || !m || n * m > 4000000) return [[s, ea, s, eb]];
    const w = m + 1, L = new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        L[i * w + j] = a[s + i] === b[s + j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
      }
    }
    const out = [];
    let i = 0, j = 0, cur = null;
    while (i < n || j < m) {
      if (i < n && j < m && a[s + i] === b[s + j]) { cur = null; i++; j++; continue; }
      if (!cur) { cur = [s + i, s + i, s + j, s + j]; out.push(cur); }
      if (j < m && (i >= n || L[i * w + j + 1] >= L[(i + 1) * w + j])) { j++; cur[3] = s + j; } else { i++; cur[1] = s + i; }
    }
    return out;
  }

  // What differs from the file as queued: changed spans, and the places where text was removed.
  function changedSpans(now) {
    const spans = [], gone = [];
    for (const [a0, a1, b0, b1] of diffSeq(T.origLines, now)) {
      if (a1 - a0 === b1 - b0) {
        for (let k = 0; k < b1 - b0; k++) {
          const A = T.origLines[a0 + k].split(/(\s+)/), B = now[b0 + k].split(/(\s+)/), at = [0];
          B.forEach(x => at.push(at[at.length - 1] + x.length));
          for (const [, , w0, w1] of diffSeq(A, B)) {
            if (at[w1] > at[w0]) spans.push({ line: b0 + k, from: at[w0], to: at[w1] });
            else gone.push({ line: b0 + k, ch: at[w0] });
          }
        }
      } else if (b1 > b0) {
        for (let l = b0; l < b1; l++) if (now[l]) spans.push({ line: l, from: 0, to: now[l].length });
      } else {
        gone.push({ line: Math.min(b0, now.length - 1), ch: 0 });
      }
    }
    return { spans, gone };
  }

  // Tint what differs from the file as queued, and leave a small tick where text was removed.
  function refreshChanges() {
    const cm = T.cm;
    cm.operation(() => {
      T.marks.forEach(m => m.clear());
      T.marks = [];
      const { spans, gone } = changedSpans(cm.getValue('\n').split('\n'));
      for (const x of spans.slice(0, 5000)) T.marks.push(cm.markText({ line: x.line, ch: x.from }, { line: x.line, ch: x.to }, { className: 'cm-changed' }));
      for (const x of gone) {
        const w = document.createElement('span');
        w.className = 'cm-gone';
        T.marks.push(cm.setBookmark({ line: x.line, ch: x.ch }, { widget: w }));
      }
    });
  }

  // ------------------------------------------------------------ images in a text file

  const IMAGE_FORMS = {
    md: [/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?[^)]*\)/g, /<img\b[^>]*\bsrc\s*=\s*["']()([^"']+)["']/gi,
      /\\includegraphics\s*(?:\[()[^\]]*\]\s*)?\{([^}]+)\}/g],
    tex: [/\\includegraphics\s*(?:\[()[^\]]*\]\s*)?\{([^}]+)\}/g],
  };

  function findImages() {
    const name = S.item.file.toLowerCase();
    const forms = /\.tex$/.test(name) ? IMAGE_FORMS.tex : /\.(md|markdown)$/.test(name) ? IMAGE_FORMS.md : [];
    const out = [];
    T.cm.getValue('\n').split('\n').forEach((text, line) => {
      if (forms === IMAGE_FORMS.tex) text = text.replace(/(^|[^\\])%.*$/, '$1');
      const here = [];
      for (const re of forms) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text))) here.push({ at: m.index, line, alt: m[1] || '', ref: m[2].trim() });
      }
      here.sort((a, b) => a.at - b.at).forEach(x => out.push(x));
    });
    return out;
  }

  function imageSrc(ref) {
    if (/^(data:image\/|https?:\/\/)/i.test(ref)) return ref;
    return Object.prototype.hasOwnProperty.call(T.images, ref) ? '/api/items/' + S.item.id + '/images/' + encodeURIComponent(T.images[ref]) : null;
  }
  const refLabel = ref => (/^data:/i.test(ref) ? 'embedded image' : ref);

  function buildFigure(x) {
    const fig = document.createElement('figure');
    fig.className = 'cm-figure';
    const src = imageSrc(x.ref), cap = document.createElement('figcaption');
    cap.textContent = x.alt || refLabel(x.ref);
    if (!src) {
      fig.classList.add('missing');
      cap.textContent = 'Image not sent: ' + refLabel(x.ref) + ' ';
      const b = document.createElement('button');
      b.textContent = 'Add image';
      b.addEventListener('click', () => { T.addRef = x.ref; $('#imageFile').click(); });
      cap.appendChild(b);
    } else {
      const a = document.createElement('a');
      a.href = src; a.target = '_blank'; a.rel = 'noopener noreferrer';
      if (/\.pdf$/i.test(T.images[x.ref] || '')) {
        const c = document.createElement('canvas');
        a.appendChild(c);
        drawPdfFigure(c, src, fig);
      } else {
        const img = document.createElement('img');
        img.alt = x.alt; img.src = src;
        img.addEventListener('load', () => {
          if (fig.widget) fig.widget.changed();
          if (T.cm && window.reviewVim) window.reviewVim.keepCursorInView(T.cm);
        });
        a.appendChild(img);
      }
      fig.appendChild(a);
    }
    fig.appendChild(cap);
    return fig;
  }

  // A PDF figure, as LaTeX files often have: browsers cannot show one in an image, so draw its first page.
  async function drawPdfFigure(canvas, src, fig) {
    try {
      const pdf = await pdfjsLib.getDocument({ url: src, withCredentials: true }).promise;
      const page = await pdf.getPage(1);
      const width = Math.min($('#editor').clientWidth || 700, 900) * Math.min(window.devicePixelRatio || 1, 2);
      const vp = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
      canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      pdf.destroy();
      if (fig.widget) fig.widget.changed();
      if (T.cm && window.reviewVim) window.reviewVim.keepCursorInView(T.cm);
    } catch (e) {
      $('figcaption', fig).textContent += ' (could not draw this PDF: ' + e.message + ')';
    }
  }

  function refreshImages() {
    const found = findImages();
    const key = found.map(x => x.line + ':' + x.ref).join('\n');
    // Replacing a line (Revert, or deleting and undoing) takes its image with it, even if the text ends up the same.
    const intact = T.refs.every(x => ((T.cm.lineInfo(x.line) || {}).widgets || []).includes(x.widget));
    if (key === T.imgKey && intact) return;
    T.imgKey = key;
    T.cm.operation(() => {
      T.refs.forEach(x => x.widget.clear());
      const seen = {};
      found.forEach(x => {
        seen[x.ref] = (seen[x.ref] || 0) + 1;
        const k = x.ref + '#' + seen[x.ref];
        if (!T.nodes.has(k)) T.nodes.set(k, buildFigure(x));
        x.node = T.nodes.get(k);
        x.widget = x.node.widget = T.cm.addLineWidget(x.line, x.node, { handleMouseEvents: true });
      });
    });
    T.refs = found;
    const b = $('#imagesBtn');
    b.hidden = !found.length;
    b.textContent = 'Images (' + found.length + ')';
    if (!$('#imagesPanel').hidden) renderImagesPanel();
  }

  function renderImagesPanel() {
    const L = $('#imagesPanel');
    L.innerHTML = '<div class="list-head"><b>' + T.refs.length + ' image' + (T.refs.length === 1 ? '' : 's') + '</b>' +
      '<span class="muted">in the order of the text</span><button id="imagesClose">Close</button></div>' +
      T.refs.map((x, k) => {
        const src = imageSrc(x.ref), pdf = /\.pdf$/i.test(T.images[x.ref] || '');
        return '<div class="li" data-k="' + k + '"><span class="badge discuss">' + (k + 1) + '</span><div>' +
          (src && !pdf ? '<img class="li-thumb" alt="" src="' + esc(src) + '">' : '') +
          '<div class="li-note">' + esc(x.alt || refLabel(x.ref)) + '</div>' +
          '<div class="li-meta">line ' + (x.line + 1) + (src ? (pdf ? ' &middot; PDF' : '') : ' &middot; not sent') + '</div></div></div>';
      }).join('');
    $('#imagesClose').addEventListener('click', () => { L.hidden = true; });
    $$('.li', L).forEach(el => el.addEventListener('click', () => {
      const x = T.refs[Number(el.dataset.k)];
      x.node.scrollIntoView({ block: 'center', behavior: 'smooth' });
      T.cm.setCursor({ line: x.line, ch: 0 });
      if (window.innerWidth < 700) L.hidden = true;
    }));
  }
  $('#imagesBtn').addEventListener('click', () => {
    const L = $('#imagesPanel');
    if (!L.hidden) { L.hidden = true; return; }
    L.style.top = $('#bar').getBoundingClientRect().bottom + 'px';
    renderImagesPanel();
    L.hidden = false;
  });

  $('#imageFile').addEventListener('change', async () => {
    const f = $('#imageFile').files[0], ref = T.addRef;
    $('#imageFile').value = '';
    if (!f || !ref || !T.cm) return;
    try {
      const q = new URLSearchParams({ ref, filename: f.name });
      const r = await fetch('/api/items/' + S.item.id + '/images?' + q.toString(), {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-Review': '1' }, body: f });
      let body = {};
      try { body = await r.json(); } catch (e) { /* not JSON */ }
      if (!r.ok) throw new Error(body.error || r.statusText);
      T.images = body.images;
      Array.from(T.nodes.keys()).filter(k => k.startsWith(ref + '#')).forEach(k => T.nodes.delete(k));
      Array.from(PV.figures.keys()).filter(k => k.startsWith(ref + '#')).forEach(k => PV.figures.delete(k));
      T.imgKey = '';
      refreshImages();
      renderPreview();
      toast('Image added');
    } catch (e) {
      toast('Could not add it: ' + e.message, 5000);
    }
  });

  // ------------------------------------------------------------ live preview of Markdown

  // The Markdown is rendered in the browser whenever typing pauses, a top-level block at a time, so each block knows
  // its source lines. Changed text is marked by private-use characters put into the source before rendering, and
  // those become <mark> afterwards. Raw HTML from the file is shown as text, never run.
  const PV = { on: false, blocks: [], figures: new Map(), syncTimer: null, ready: false };
  const MARK_START = '', MARK_END = '', MARK_GONE = '';
  const noMarks = s => String(s || '').replace(/[-]|%EE%80%9[0-2]/gi, '');
  const isMarkdown = () => !!S.item && /\.(md|markdown)$/i.test(S.item.file || '');

  // Turn the bits of LaTeX that Markdown drafts carry into HTML. Takes text that is already escaped.
  function latexInline(html) {
    for (let i = 0; i < 4; i++) {
      html = html.replace(/\\textbf\{([^{}]*)\}/g, '<b>$1</b>').replace(/\\(?:emph|textit)\{([^{}]*)\}/g, '<i>$1</i>')
        .replace(/\\texttt\{([^{}]*)\}/g, '<code>$1</code>');
    }
    return html.replace(/\\([%&_#$])/g, '$1');
  }
  function figurePlaceholder(ref, alt) {
    return '<span class="pv-fig" data-ref="' + esc(noMarks(ref)) + '" data-alt="' + esc(noMarks(alt)) + '"></span>';
  }
  // A raw LaTeX block: show its figures and captions, and leave out layout commands.
  function latexBlock(code) {
    const figs = [];
    const rest = code.replace(/\\includegraphics\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}/g, (_m, ref) => { figs.push(ref.trim()); return ''; })
      .replace(/\\(?:begin|end)\{[^}]*\}(?:\[[^\]]*\])?/g, '').replace(/\\(?:vspace|hspace|label)\*?\{[^}]*\}/g, '')
      .replace(/\\(?:centering|raggedright|par|newpage|noindent|clearpage|smallskip|medskip|bigskip)\b/g, '');
    const caption = latexInline(esc(rest)).replace(/[{}]/g, '').replace(/~/g, ' ').trim();
    if (!figs.length && !noMarks(caption).trim()) return '';
    return '<div class="pv-latex">' + figs.map(r => figurePlaceholder(r, '')).join('') + (noMarks(caption).trim() ? '<p class="pv-caption">' + caption + '</p>' : '') + '</div>';
  }
  function setUpMarked() {
    if (PV.ready) return;
    PV.ready = true;
    marked.use({ renderer: {
      html(html) {
        const img = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i.exec(html);
        return img ? figurePlaceholder(img[1], '') : esc(html);
      },
      code(code, lang) {
        return /^\{?=?latex\}?/.test(lang || '') ? latexBlock(code) : '<pre><code>' + esc(code) + '</code></pre>';
      },
      link(href, title, text) {
        const url = noMarks(href);
        if (!/^(https?:|mailto:|#)/i.test(url)) return text;
        return '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + text + '</a>';
      },
      image(href, title, text) {
        let ref = noMarks(href);
        try { ref = decodeURI(ref); } catch (e) { /* as written */ }
        return figurePlaceholder(ref, text);
      },
    } });
  }
  // The source with its changes marked, keeping line starts as they are so that lists and headings still parse.
  function markedSource(lines) {
    const { spans, gone } = changedSpans(lines);
    const edits = new Map();
    const add = (line, at, text, order) => { if (!edits.has(line)) edits.set(line, []); edits.get(line).push({ at, text, order }); };
    for (const x of spans) {
      const lead = x.from === 0 ? /^\s*(?:(?:[-*+]|\d+[.)]|#{1,6}|>)\s+)*/.exec(lines[x.line])[0].length : x.from;
      if (lead >= x.to) continue;
      add(x.line, lead, MARK_START, 1);
      add(x.line, x.to, MARK_END, 0);
    }
    for (const x of gone) if (lines[x.line]) add(x.line, x.ch, MARK_GONE, 2);
    return lines.map((text, n) => {
      const list = edits.get(n);
      if (!list) return text;
      list.sort((p, q) => q.at - p.at || q.order - p.order);
      for (const e of list) text = text.slice(0, e.at) + e.text + text.slice(e.at);
      return text;
    }).join('\n');
  }
  function renderPreview() {
    if (!PV.on || !T.cm) return;
    setUpMarked();
    const box = $('#preview'), top = box.scrollTop;
    const tokens = marked.lexer(markedSource(T.cm.getValue('\n').split('\n')));
    let line = 0, html = '';
    PV.blocks = [];
    for (const t of tokens) {
      const count = ((t.raw || '').match(/\n/g) || []).length;
      if (t.type !== 'space') {
        const end = line + Math.max(0, count - (/\n$/.test(t.raw || '') ? 1 : 0));
        html += '<div class="pv-block" data-from="' + line + '" data-to="' + end + '">' + latexInline(marked.parser([t])) + '</div>';
      }
      line += count;
    }
    box.innerHTML = html.split(MARK_START).join('<mark class="pv-new">').split(MARK_END).join('</mark>')
      .split(MARK_GONE).join('<span class="pv-gone"></span>');
    const seen = {};
    $$('.pv-fig', box).forEach(el => {
      const ref = el.dataset.ref, alt = el.dataset.alt;
      seen[ref] = (seen[ref] || 0) + 1;
      const key = ref + '#' + seen[ref];
      if (!PV.figures.has(key)) PV.figures.set(key, buildFigure({ ref, alt }));
      el.replaceWith(PV.figures.get(key));
    });
    box.scrollTop = top;
    syncPreview();
  }
  // Keep the block with the cursor in view.
  function syncPreview() {
    if (!PV.on || !T.cm) return;
    const line = T.cm.getCursor().line, box = $('#preview');
    const blocks = $$('.pv-block', box);
    let found = null;
    for (const b of blocks) {
      if (Number(b.dataset.from) > line) break;
      found = b;
    }
    if (!found) return;
    const r = found.getBoundingClientRect(), b = box.getBoundingClientRect(), pad = 90;
    if (r.top < b.top + pad || r.top > b.bottom - pad * 2) box.scrollTop += r.top - b.top - pad - 30;
  }
  function setPreview(on) {
    PV.on = !!on;
    document.body.classList.toggle('previewing', PV.on);
    const box = $('#preview'), btn = $('#previewBtn');
    box.hidden = !PV.on;
    btn.classList.toggle('on', PV.on);
    btn.setAttribute('aria-pressed', String(PV.on));
    if (!PV.on) { box.innerHTML = ''; }
    if (T.cm) T.cm.refresh();
    if (PV.on) renderPreview();
  }
  $('#previewBtn').addEventListener('click', () => {
    setPreview(!PV.on);
    pref.set('review.preview', PV.on ? '1' : '0');
  });

  // ------------------------------------------------------------ viewer

  function teardown() {
    S.loadToken++;
    closeText();
    if (S.pdf) { try { S.pdf.destroy(); } catch (e) { /* ignore */ } }
    S.pdf = null; S.pages = []; S.openN = null; S.lastRange = null;
    $('#pages').innerHTML = '';
    $('#selbar').hidden = true; $('#lastbar').hidden = true; $('#sheet').hidden = true; $('#list').hidden = true;
  }

  async function openItem(id) {
    await flush();
    teardown();
    const token = S.loadToken;
    $('#queue').hidden = true; $('#viewer').hidden = false;
    $('#tools').hidden = false; $('#back').hidden = false; $('#doneBtn').hidden = false; $('#refresh').hidden = true;
    $('#addBtn').hidden = true; $('#addPanel').hidden = true;
    setStatus('');
    $('#pages').innerHTML = '<div class="loading">Loading&hellip;</div>';
    let data;
    try { data = await api('/api/items/' + id); }
    catch (e) { toast('Could not open it: ' + e.message, 5000); location.hash = '#/'; return; }
    if (token !== S.loadToken) return;
    S.item = data.item;
    S.version = data.highlights.version;
    S.hl = data.highlights.highlights || [];
    S.deleted = new Set();
    S.maxN = S.hl.reduce((m, h) => Math.max(m, h.n || 0), data.highlights.max_n || 0);
    S.transcripts = data.transcripts || {};
    S.canTranscribe = !!data.transcribe;
    $('#title').textContent = S.item.title; document.title = S.item.title;
    updateDoneBtn();
    if (S.item.kind === 'text') return openText(data, token);
    try { S.pdf = await pdfjsLib.getDocument({ url: '/api/items/' + id + '/file', withCredentials: true }).promise; }
    catch (e) { $('#pages').innerHTML = '<div class="loading error">Could not load the PDF: ' + esc(e.message) + '</div>'; return; }
    if (token !== S.loadToken) return;
    await renderPages(token);
    setStatus(S.hl.length ? 'Saved' : '');
    pollTranscripts();
  }

  async function renderPages(token, keep) {
    const wrap = $('#pages');
    const avail = Math.min(document.documentElement.clientWidth - 16, 1100);
    S.width = document.documentElement.clientWidth;
    wrap.innerHTML = '';
    S.pages = [];
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    for (let n = 1; n <= S.pdf.numPages; n++) {
      const page = await S.pdf.getPage(n);
      if (token !== S.loadToken) return;
      const scale = avail / page.getViewport({ scale: 1 }).width;
      const vp = page.getViewport({ scale });
      const div = document.createElement('div');
      div.className = 'page'; div.dataset.page = String(n);
      div.style.width = vp.width + 'px'; div.style.height = vp.height + 'px';
      div.style.setProperty('--scale-factor', String(scale));
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width * dpr); canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = vp.width + 'px'; canvas.style.height = vp.height + 'px';
      const text = document.createElement('div'); text.className = 'textLayer';
      const over = document.createElement('div'); over.className = 'overlay';
      div.append(canvas, text, over);
      wrap.appendChild(div);
      const P = { n, div, text, over, scale };
      S.pages.push(P);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
      if (token !== S.loadToken) return;
      const tc = await page.getTextContent();
      await pdfjsLib.renderTextLayer({ textContentSource: tc, container: text, viewport: vp, textDivs: [] }).promise;
      drawHighlights(P);
      if (keep && keep.page === n) window.scrollTo(0, div.getBoundingClientRect().top + window.scrollY + keep.frac * vp.height - keep.offset);
    }
  }

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!S.pdf || Math.abs(document.documentElement.clientWidth - S.width) < 40) return;
      const top = $('#bar').offsetHeight + 4;
      const P = S.pages.find(p => p.div.getBoundingClientRect().bottom > top) || S.pages[0];
      const r = P.div.getBoundingClientRect();
      renderPages(++S.loadToken, { page: P.n, frac: (top - r.top) / r.height, offset: top });
    }, 300);
  });

  // ------------------------------------------------------------ drawing highlights

  function drawHighlights(P) {
    P.over.innerHTML = '';
    const placed = [];
    for (const h of S.hl) {
      const rs = (h.rects || []).filter(r => r.page === P.n);
      if (!rs.length) continue;
      for (const r of rs) {
        const d = document.createElement('div');
        d.className = 'hl ' + h.tag + (S.openN === h.n ? ' open' : '');
        d.style.left = r.x * P.scale + 'px'; d.style.top = r.y * P.scale + 'px';
        d.style.width = r.w * P.scale + 'px'; d.style.height = r.h * P.scale + 'px';
        P.over.appendChild(d);
      }
      if (h.rects[0].page !== P.n) continue;           // number only where the highlight starts
      const y = (rs[0].y + rs[0].h / 2) * P.scale;
      const k = placed.filter(py => Math.abs(py - y) < 14).length;
      placed.push(y);
      const b = document.createElement('div');
      b.className = 'badge ' + h.tag + (h.note ? ' noted' : '') + (h.audio && h.audio.length ? ' voiced' : '');
      b.dataset.n = String(h.n);
      b.textContent = h.n;
      b.style.top = y + 'px';
      b.style.left = (6 + k * 30) + 'px';
      P.over.appendChild(b);
    }
  }
  function redrawAll() { S.pages.forEach(drawHighlights); if (!$('#list').hidden) renderList(); }

  function preview(range, tag) {
    clearPreview();
    for (const r of rangeParts(range)) {
      const P = S.pages[r.page - 1];
      const d = document.createElement('div');
      d.className = 'hl preview ' + tag;
      d.style.left = r.x * P.scale + 'px'; d.style.top = r.y * P.scale + 'px';
      d.style.width = r.w * P.scale + 'px'; d.style.height = r.h * P.scale + 'px';
      P.over.appendChild(d);
    }
  }
  const clearPreview = () => $$('.hl.preview').forEach(d => d.remove());

  // ------------------------------------------------------------ geometry

  function pageAt(x, y, slack) {
    slack = slack || 0;
    for (const P of S.pages) {
      const b = P.div.getBoundingClientRect();
      if (x >= b.left - slack && x <= b.right + slack && y >= b.top - slack && y <= b.bottom + slack) return P;
    }
    return null;
  }

  // The text position under a point: the caret if the point is on text, else the nearest character on that line.
  function boundaryAt(x, y) {
    const P = pageAt(x, y, 24);
    if (!P) return null;
    let node = null, offset = 0;
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      if (r && r.startContainer.nodeType === 3 && P.text.contains(r.startContainer)) { node = r.startContainer; offset = r.startOffset; }
    } else if (document.caretPositionFromPoint) {
      const c = document.caretPositionFromPoint(x, y);
      if (c && c.offsetNode && c.offsetNode.nodeType === 3 && P.text.contains(c.offsetNode)) { node = c.offsetNode; offset = c.offset; }
    }
    if (!node) {
      let best = null, bd = Infinity;
      for (const sp of P.text.querySelectorAll('span')) {
        const t = sp.firstChild;
        if (!t || t.nodeType !== 3 || !t.length) continue;
        const b = sp.getBoundingClientRect();
        if (!b.width || !b.height) continue;
        const dy = y < b.top ? b.top - y : y > b.bottom ? y - b.bottom : 0;
        const dx = x < b.left ? b.left - x : x > b.right ? x - b.right : 0;
        const d = dy * 4 + dx;
        if (d < bd) { bd = d; best = { t, b }; }
      }
      if (!best) return null;
      node = best.t;
      offset = Math.max(0, Math.min(node.length, Math.round((x - best.b.left) / best.b.width * node.length)));
    }
    return { node, offset };
  }

  function rangeBetween(a, b) {
    const r = document.createRange();
    r.setStart(a.node, a.offset); r.collapse(true);
    if (r.comparePoint(b.node, b.offset) >= 0) r.setEnd(b.node, b.offset);
    else { r.setStart(b.node, b.offset); r.setEnd(a.node, a.offset); }
    return r;
  }

  // Widen a pen stroke's range to whole words.
  function snapToWords(r) {
    if (r.startContainer.nodeType === 3) {
      const s = r.startContainer.data; let i = r.startOffset;
      while (i > 0 && /\S/.test(s[i - 1])) i--;
      r.setStart(r.startContainer, i);
    }
    if (r.endContainer.nodeType === 3) {
      const s = r.endContainer.data; let j = r.endOffset;
      while (j < s.length && /\S/.test(s[j])) j++;
      r.setEnd(r.endContainer, j);
    }
    return r;
  }

  // Rectangles of a range, per page, in PDF points from each page's top-left corner.
  function rangeParts(range) {
    const out = [];
    for (const P of S.pages) {
      if (!range.intersectsNode(P.text)) continue;
      const layer = document.createRange(); layer.selectNodeContents(P.text);
      const sub = range.cloneRange();
      if (sub.compareBoundaryPoints(Range.START_TO_START, layer) < 0) sub.setStart(layer.startContainer, layer.startOffset);
      if (sub.compareBoundaryPoints(Range.END_TO_END, layer) > 0) sub.setEnd(layer.endContainer, layer.endOffset);
      const base = P.div.getBoundingClientRect();
      const rects = [];
      for (const cr of sub.getClientRects()) {
        if (cr.width < 0.5 || cr.height < 0.5) continue;
        const x0 = Math.max(cr.left, base.left), x1 = Math.min(cr.right, base.right);
        const y0 = Math.max(cr.top, base.top), y1 = Math.min(cr.bottom, base.bottom);
        if (x1 - x0 < 0.5 || y1 - y0 < 0.5) continue;
        if ((x1 - x0) > 0.95 * base.width && (y1 - y0) > 0.5 * base.height) continue;   // a whole-layer box, not text
        rects.push({ page: P.n, x: (x0 - base.left) / P.scale, y: (y0 - base.top) / P.scale, w: (x1 - x0) / P.scale, h: (y1 - y0) / P.scale });
      }
      out.push(...mergeRects(rects));
    }
    return out;
  }

  function mergeRects(rs) {
    rs.sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2) || a.x - b.x);
    const lines = [];
    for (const r of rs) {
      const line = lines.find(L => {
        const ov = Math.min(L.y + L.h, r.y + r.h) - Math.max(L.y, r.y);
        return ov > 0.5 * Math.min(L.h, r.h);
      });
      if (line) {
        const x = Math.min(line.x, r.x), y = Math.min(line.y, r.y);
        line.w = Math.max(line.x + line.w, r.x + r.w) - x; line.h = Math.max(line.y + line.h, r.y + r.h) - y;
        line.x = x; line.y = y;
      } else lines.push(Object.assign({}, r));
    }
    return lines.map(r => ({ page: r.page, x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.w.toFixed(2), h: +r.h.toFixed(2) }));
  }

  // The text of a range, with spaces where the PDF's text runs meet across lines or gaps.
  function rangeText(range) {
    const out = [];
    let prev = null;
    let root = range.commonAncestorContainer;
    if (root.nodeType === 3) root = root.parentNode;
    const it = document.createNodeIterator(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = it.nextNode())) {
      if (!range.intersectsNode(n)) continue;
      const span = n.parentNode;
      const layer = span.closest && span.closest('.textLayer');
      if (!layer) continue;
      const a = n === range.startContainer ? range.startOffset : 0;
      const z = n === range.endContainer ? range.endOffset : n.data.length;
      const s = n.data.slice(a, z);
      if (!s) continue;
      const b = span.getBoundingClientRect();
      if (prev) {
        const sameLine = prev.layer === layer && Math.abs((b.top + b.bottom) / 2 - (prev.b.top + prev.b.bottom) / 2) < 0.4 * Math.max(b.height, prev.b.height);
        const gap = b.left - prev.b.right;
        if (!/\s$/.test(prev.s) && !/^\s/.test(s) && (!sameLine || gap > 0.15 * b.height)) out.push(' ');
      }
      out.push(s);
      prev = { b, s, layer };
    }
    return oneLine(out.join(''));
  }

  // ------------------------------------------------------------ making highlights

  function addFromRange(range, tag, snap) {
    if (!range) return;
    if (S.reopen) { toast('Reopen it to add highlights'); return; }
    if (snap) snapToWords(range);
    const rects = rangeParts(range), text = rangeText(range);
    if (!rects.length || !text) { toast('No text there'); return; }
    const t = isoLocal();
    S.maxN = Math.max(S.maxN, S.hl.reduce((m, h) => Math.max(m, h.n || 0), 0)) + 1;
    const h = { n: S.maxN, id: newId(), tag, page: rects[0].page, text, note: '', rects, created_at: t, updated_at: t };
    S.hl.push(h);
    redrawAll();
    scheduleSave();
    showBar('#' + h.n + ' ' + h.tag + ': ' + h.text.slice(0, 60) + (h.text.length > 60 ? '…' : ''), { type: 'add', id: h.id }, true);
  }

  // The bar after an action: "Add note" and "Undo".
  let lastAction = null, barTimer = null;
  function showBar(text, action, allowNote) {
    lastAction = action;
    $('#lastText').textContent = text;
    $('#lastNote').hidden = !allowNote;
    $('#lastbar').hidden = false; $('#selbar').hidden = true;
    clearTimeout(barTimer);
    barTimer = setTimeout(() => { $('#lastbar').hidden = true; lastAction = null; }, 6000);
  }
  $('#lastNote').addEventListener('click', () => {
    const a = lastAction;
    $('#lastbar').hidden = true;
    const h = a && a.type === 'add' && S.hl.find(x => x.id === a.id);
    if (h) openSheet(h.n, true);
  });
  $('#lastUndo').addEventListener('click', () => {
    const a = lastAction;
    lastAction = null;
    $('#lastbar').hidden = true;
    if (!a) return;
    if (a.type === 'add') {
      const h = S.hl.find(x => x.id === a.id);
      if (!h) return;
      S.hl = S.hl.filter(x => x.id !== h.id); S.deleted.add(h.id);
      toast('Removed #' + h.n);
    } else if (a.type === 'delete') {
      S.deleted.delete(a.h.id); S.hl.push(a.h); S.hl.sort((x, y) => x.n - y.n);
      toast('Restored #' + a.h.n);
    }
    redrawAll(); scheduleSave();
  });

  // text selection (Select tool, or a mouse)
  let selTimer = null;
  document.addEventListener('selectionchange', () => { clearTimeout(selTimer); selTimer = setTimeout(onSelection, 180); });
  function onSelection() {
    if (!S.item || !S.pages.length || S.tool !== 'select') { $('#selbar').hidden = true; return; }
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) { $('#selbar').hidden = true; return; }
    const r = sel.getRangeAt(0);
    if (!S.pages.some(P => r.intersectsNode(P.text))) { $('#selbar').hidden = true; return; }
    S.lastRange = r.cloneRange();
    $('#lastbar').hidden = true;
    $('#selbar').hidden = false;
  }
  $$('#selbar button').forEach(b => {
    b.addEventListener('pointerdown', e => e.preventDefault());   // keep the selection while tapping
    b.addEventListener('mousedown', e => e.preventDefault());
    b.addEventListener('click', () => {
      const r = S.lastRange;
      $('#selbar').hidden = true;
      const sel = window.getSelection(); if (sel) sel.removeAllRanges();
      addFromRange(r, b.dataset.mark, false);
      S.lastRange = null;
    });
  });

  // pen strokes and taps
  const pagesEl = $('#pages');
  pagesEl.addEventListener('touchstart', e => {
    if (S.tool === 'select') return;
    const stylus = Array.from(e.touches).some(t => t.touchType === 'stylus');
    if (stylus || S.finger) e.preventDefault();          // the pencil draws; fingers scroll unless "Finger draws" is on
  }, { passive: false });

  let stroke = null, tap = null;
  pagesEl.addEventListener('pointerdown', e => {
    tap = { x: e.clientX, y: e.clientY, t: Date.now() };
    const draws = S.tool !== 'select' && (e.pointerType === 'pen' || e.pointerType === 'mouse' || (e.pointerType === 'touch' && S.finger));
    if (!draws || e.button > 0) return;
    const a = boundaryAt(e.clientX, e.clientY);
    if (!a) return;
    e.preventDefault();
    try { pagesEl.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
    stroke = { id: e.pointerId, a, b: a, x0: e.clientX, y0: e.clientY, tag: S.tool };
  });
  pagesEl.addEventListener('pointermove', e => {
    if (!stroke || e.pointerId !== stroke.id) return;
    e.preventDefault();
    const b = boundaryAt(e.clientX, e.clientY);
    if (!b) return;
    stroke.b = b;
    if (Math.hypot(e.clientX - stroke.x0, e.clientY - stroke.y0) >= 6) preview(snapToWords(rangeBetween(stroke.a, b)), stroke.tag);
  });
  pagesEl.addEventListener('pointerup', e => {
    const t = tap; tap = null;
    if (stroke && e.pointerId === stroke.id) {
      const s = stroke; stroke = null;
      clearPreview();
      if (Math.hypot(e.clientX - s.x0, e.clientY - s.y0) >= 6) {
        addFromRange(rangeBetween(s.a, boundaryAt(e.clientX, e.clientY) || s.b), s.tag, true);
        return;
      }
    }
    if (t && Math.hypot(e.clientX - t.x, e.clientY - t.y) < 8 && Date.now() - t.t < 500) {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      const h = hitTest(e.clientX, e.clientY);
      if (h) openSheet(h.n);
    }
  });
  pagesEl.addEventListener('pointercancel', () => { stroke = null; tap = null; clearPreview(); });

  function hitTest(x, y) {
    for (const b of $$('.badge', pagesEl)) {
      const r = b.getBoundingClientRect();
      if (x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 4 && y <= r.bottom + 4) return S.hl.find(h => String(h.n) === b.dataset.n);
    }
    const P = pageAt(x, y);
    if (!P) return null;
    const base = P.div.getBoundingClientRect();
    const px = (x - base.left) / P.scale, py = (y - base.top) / P.scale;
    for (let i = S.hl.length - 1; i >= 0; i--) {
      const h = S.hl[i];
      for (const r of h.rects) {
        if (r.page === P.n && px >= r.x - 1 && px <= r.x + r.w + 1 && py >= r.y - 1 && py <= r.y + r.h + 1) return h;
      }
    }
    return null;
  }

  // tools
  $$('[data-tool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
  function setTool(tool) {
    S.tool = tool;
    $$('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === tool));
    pagesEl.classList.toggle('drawing', tool !== 'select');
    if (tool !== 'select') { const sel = window.getSelection(); if (sel) sel.removeAllRanges(); $('#selbar').hidden = true; }
  }
  $('#finger').addEventListener('change', e => {
    S.finger = e.target.checked;
    pagesEl.classList.toggle('finger', S.finger);
  });

  // ------------------------------------------------------------ editing one highlight

  function openSheet(n, focusNote) {
    const h = S.hl.find(x => x.n === n);
    if (!h) return;
    clearTimeout(noteTimer);
    commitNote();                      // the note still being typed belongs to the highlight it was typed for
    S.openN = n;
    $('#sheetNum').textContent = '#' + h.n;
    $('#sheetPage').textContent = 'page ' + h.page;
    const q = $('#sheetQuote');
    q.textContent = h.text; q.className = h.tag;
    $$('[data-settag]').forEach(b => b.classList.toggle('on', b.dataset.settag === h.tag));
    $('#sheetNote').value = h.note || '';
    $('#sheet').hidden = false; $('#selbar').hidden = true; $('#lastbar').hidden = true;
    renderClips(); updateRecUI();
    redrawAll();
    if (focusNote) $('#sheetNote').focus();
  }
  function closeSheet() {
    if ($('#sheet').hidden) return;
    if (S.rec) stopRecording();
    commitNote();
    $('#sheet').hidden = true;
    $('#sheetNote').blur();
    S.openN = null;
    redrawAll();
  }
  function commitNote() {
    const h = S.hl.find(x => x.n === S.openN);
    if (!h) return;
    const v = $('#sheetNote').value.trim();
    if (v !== (h.note || '')) { h.note = v; h.updated_at = isoLocal(); scheduleSave(); }
  }
  let noteTimer = null;
  $('#sheetNote').addEventListener('input', () => { clearTimeout(noteTimer); noteTimer = setTimeout(commitNote, 700); });
  $('#sheetClose').addEventListener('click', closeSheet);
  $$('[data-settag]').forEach(b => b.addEventListener('click', () => {
    const h = S.hl.find(x => x.n === S.openN);
    if (!h || h.tag === b.dataset.settag) return;
    h.tag = b.dataset.settag; h.updated_at = isoLocal();
    $$('[data-settag]').forEach(x => x.classList.toggle('on', x === b));
    $('#sheetQuote').className = h.tag;
    redrawAll(); scheduleSave();
  }));
  $('#sheetDelete').addEventListener('click', () => {
    const h = S.hl.find(x => x.n === S.openN);
    if (!h) return;
    $('#sheet').hidden = true; S.openN = null;
    S.hl = S.hl.filter(x => x.id !== h.id); S.deleted.add(h.id);
    redrawAll(); scheduleSave();
    showBar('Deleted #' + h.n, { type: 'delete', h }, false);
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (S.rec) stopRecording();
    else if (!$('#addPanel').hidden) closeAdd();
    else if (!$('#sheet').hidden) closeSheet();
    else if (!$('#list').hidden) $('#list').hidden = true;
  });

  // ------------------------------------------------------------ voice notes

  const clockStr = sec => { const s = Math.round(Number(sec) || 0); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

  function clipStatus(file) {
    const t = S.transcripts[file];
    if (t && typeof t.text === 'string') return t.text ? esc(t.text) : '<span class="muted">(no words heard)</span>';
    if (t && t.error) return '<span class="muted">No transcript: ' + esc(t.error) + '</span>';
    return '<span class="muted">' + (S.canTranscribe ? 'Transcribing…' : 'Saved; the server is not set up to transcribe voice notes') + '</span>';
  }

  function renderClips() {
    const box = $('#clips');
    const h = S.hl.find(x => x.n === S.openN);
    const list = (h && h.audio) || [];
    box.innerHTML = list.map((c, k) => '<div class="clip" data-file="' + esc(c.file) + '">' +
      '<div class="clip-head"><b>Voice note ' + (k + 1) + '</b> <span class="muted">' + clockStr(c.seconds) + '</span>' +
      '<button class="clip-del">Delete</button></div>' +
      '<audio controls preload="none" src="/api/items/' + S.item.id + '/audio/' + encodeURIComponent(c.file) + '"></audio>' +
      '<div class="clip-text">' + clipStatus(c.file) + '</div></div>').join('');
    $$('.clip', box).forEach(el => {
      const del = $('.clip-del', el);
      del.addEventListener('click', () => {
        if (!del.dataset.armed) {          // two taps, so a stray tap cannot delete a recording
          del.dataset.armed = '1'; del.textContent = 'Tap again to delete';
          setTimeout(() => { delete del.dataset.armed; del.textContent = 'Delete'; }, 3000);
          return;
        }
        deleteClip(h, el.dataset.file);
      });
    });
  }

  function updateClipTexts() {           // only the text, so a clip that is playing keeps playing
    $$('#clips .clip').forEach(el => { $('.clip-text', el).innerHTML = clipStatus(el.dataset.file); });
  }

  async function deleteClip(h, file) {
    try { await api('/api/items/' + S.item.id + '/audio/' + encodeURIComponent(file), { method: 'DELETE' }); }
    catch (e) { /* already gone */ }
    h.audio = (h.audio || []).filter(c => c.file !== file);
    h.updated_at = isoLocal();
    delete S.transcripts[file];
    renderClips(); redrawAll(); scheduleSave();
  }

  function pickMime() {
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
    return ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find(t => MediaRecorder.isTypeSupported(t)) || '';
  }

  async function startRecording(h) {
    if (S.rec || !h) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      toast('This browser cannot record here. It needs the https:// address.', 5000);
      return;
    }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { toast('No microphone: ' + (e.message || e.name), 5000); return; }
    const mime = pickMime();
    let rec;
    try { rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); }
    catch (e) { stream.getTracks().forEach(t => t.stop()); toast('Could not start recording: ' + e.message, 5000); return; }
    const R = { rec, stream, hid: h.id, itemId: S.item.id, t0: Date.now(), chunks: [], mime };
    S.rec = R;
    rec.ondataavailable = e => { if (e.data && e.data.size) R.chunks.push(e.data); };
    rec.onstop = () => finishRecording(R);
    rec.start(1000);
    R.timer = setInterval(updateRecUI, 250);
    R.limit = setTimeout(stopRecording, 5 * 60 * 1000);
    updateRecUI();
  }

  function stopRecording() {
    const R = S.rec;
    if (!R || R.stopping) return;
    R.stopping = true;
    clearInterval(R.timer); clearTimeout(R.limit);
    try { R.rec.stop(); } catch (e) { finishRecording(R); }
  }

  async function finishRecording(R) {
    if (R.finished) return;
    R.finished = true;
    R.stream.getTracks().forEach(t => t.stop());
    S.rec = null;
    updateRecUI();
    const seconds = Math.round((Date.now() - R.t0) / 100) / 10;
    const type = (R.rec.mimeType || R.mime || 'audio/mp4').split(';')[0];
    const blob = new Blob(R.chunks, { type });
    if (!blob.size) { toast('Nothing was recorded'); return; }
    S.uploading++;
    setStatus('Saving voice note…');
    try {
      const r = await fetch('/api/items/' + R.itemId + '/audio?highlight=' + encodeURIComponent(R.hid), {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': type, 'X-Review': '1' }, body: blob });
      let body = {};
      try { body = await r.json(); } catch (e) { /* not JSON */ }
      if (!r.ok) throw new Error(body.error || r.statusText);
      const h = S.item && S.item.id === R.itemId && S.hl.find(x => x.id === R.hid);
      if (h) {
        h.audio = (h.audio || []).concat([{ file: body.file, mime: body.mime, seconds, created_at: isoLocal() }]);
        h.updated_at = isoLocal();
        S.transcripts[body.file] = { pending: true };
        S.canTranscribe = !!body.transcribe;
        redrawAll(); renderClips(); scheduleSave();
        pollTranscripts();
        toast('Voice note saved (' + clockStr(seconds) + ')');
      }
    } catch (e) {
      toast('Could not save the voice note: ' + e.message, 6000);
      setStatus('Voice note not saved');
    } finally {
      S.uploading--;
    }
  }

  function updateRecUI() {
    const b = $('#recBtn');
    const R = S.rec;
    if (R) {
      const t = clockStr((Date.now() - R.t0) / 1000);
      b.textContent = '■ Stop ' + t;
      b.classList.add('recording');
      setStatus('Recording ' + t);
    } else {
      b.textContent = '● Record';
      b.classList.remove('recording');
      if (/^Recording/.test($('#status').textContent)) setStatus('');
    }
  }

  $('#recBtn').addEventListener('click', () => {
    if (S.rec) { stopRecording(); return; }
    startRecording(S.hl.find(x => x.n === S.openN));
  });
  $('#lastRec').addEventListener('click', () => {
    const a = lastAction;
    $('#lastbar').hidden = true;
    const h = a && a.type === 'add' && S.hl.find(x => x.id === a.id);
    if (h) { openSheet(h.n); startRecording(h); }
  });

  let pollTimer = null, pollUntil = 0;
  function pollTranscripts() {
    pollUntil = Date.now() + 5 * 60 * 1000;
    if (pollTimer) return;
    const waiting = () => S.hl.some(h => (h.audio || []).some(c => { const t = S.transcripts[c.file]; return !t || t.pending; }));
    const tick = async () => {
      pollTimer = null;
      if (!S.item || !S.canTranscribe || !waiting() || Date.now() > pollUntil) return;
      try {
        const r = await api('/api/items/' + S.item.id + '/transcripts');
        S.transcripts = r.transcripts || {};
        S.canTranscribe = !!r.transcribe;
        updateClipTexts();
        if (!$('#list').hidden) renderList();
      } catch (e) { /* try again */ }
      pollTimer = setTimeout(tick, 3000);
    };
    pollTimer = setTimeout(tick, 2500);
  }

  // ------------------------------------------------------------ list of highlights

  $('#listBtn').addEventListener('click', () => {
    const L = $('#list');
    if (!L.hidden) { L.hidden = true; return; }
    L.style.top = $('#bar').getBoundingClientRect().bottom + 'px';
    renderList(); L.hidden = false;
  });
  function renderList() {
    const L = $('#list');
    const items = S.hl.slice().sort((a, b) => a.n - b.n);
    const counts = { change: items.filter(h => h.tag === 'change').length, discuss: items.filter(h => h.tag === 'discuss').length };
    L.innerHTML = '<div class="list-head"><b>' + items.length + ' highlight' + (items.length === 1 ? '' : 's') + '</b>' +
      '<span class="muted">' + counts.change + ' change, ' + counts.discuss + ' discuss</span>' +
      '<button id="listClose">Close</button></div>' +
      (items.length ? items.map(h => '<div class="li" data-n="' + h.n + '"><span class="badge ' + h.tag + (h.note ? ' noted' : '') + (h.audio && h.audio.length ? ' voiced' : '') + '">' + h.n + '</span><div>' +
        '<div class="li-text">' + esc(h.text.length > 220 ? h.text.slice(0, 220) + '…' : h.text) + '</div>' +
        (h.note ? '<div class="li-note">' + esc(h.note) + '</div>' : '') +
        (h.audio || []).map((c, k) => '<div class="li-voice">Voice note ' + (k + 1) + ' (' + clockStr(c.seconds) + '): ' + clipStatus(c.file) + '</div>').join('') +
        '<div class="li-meta">page ' + h.page + ' &middot; ' + h.tag + '</div></div></div>').join('')
        : '<p class="muted">No highlights yet.</p>');
    $('#listClose').addEventListener('click', () => { L.hidden = true; });
    $$('.li', L).forEach(el => el.addEventListener('click', () => {
      const h = S.hl.find(x => String(x.n) === el.dataset.n);
      if (!h) return;
      const P = S.pages[h.rects[0].page - 1];
      if (P) {
        const y = P.div.getBoundingClientRect().top + window.scrollY + h.rects[0].y * P.scale - $('#bar').offsetHeight - 80;
        window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
      }
      if (window.innerWidth < 700) L.hidden = true;
      openSheet(h.n);
    }));
  }

  // ------------------------------------------------------------ saving

  let saveTimer = null;
  function scheduleSave(ms) {
    S.dirty = true; setStatus('Not saved yet');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, ms == null ? 350 : ms);
  }
  async function save() {
    if (!S.item) return;
    if (S.saving) { scheduleSave(400); return; }
    S.saving = true; S.dirty = false; setStatus('Saving…');
    const id = S.item.id;
    try {
      const r = await api('/api/items/' + id + '/highlights', { method: 'PUT', body: JSON.stringify({ base_version: S.version, max_n: S.maxN, highlights: S.hl }) });
      if (S.item && S.item.id === id) { S.version = r.highlights.version; S.item = r.item; }
      setStatus(S.dirty ? 'Not saved yet' : 'Saved');
    } catch (e) {
      S.dirty = true;
      if (e.status === 409 && e.body && e.body.highlights) { merge(e.body.highlights); setTimeout(save, 50); }
      else { setStatus('Not saved; retrying'); setTimeout(save, 4000); }
    } finally {
      S.saving = false;
    }
  }
  function merge(server) {
    const mine = new Map(S.hl.map(h => [h.id, h]));
    for (const h of server.highlights || []) {
      if (S.deleted.has(h.id)) continue;
      const m = mine.get(h.id);
      if (!m || String(h.updated_at || '') > String(m.updated_at || '')) mine.set(h.id, h);
    }
    const list = Array.from(mine.values()).sort((a, b) => a.n - b.n || String(a.created_at).localeCompare(String(b.created_at)));
    let max = list.reduce((m, h) => Math.max(m, h.n || 0), Math.max(S.maxN, server.max_n || 0));
    const seen = new Set();
    for (const h of list) { if (seen.has(h.n)) h.n = ++max; seen.add(h.n); }
    S.maxN = max; S.hl = list; S.version = server.version;
    redrawAll();
  }
  async function flush() {
    if (S.rec) stopRecording();
    for (let i = 0; i < 100 && (S.rec || S.uploading); i++) await new Promise(r => setTimeout(r, 100));
    commitNote();
    clearTimeout(saveTimer);
    for (let i = 0; i < 40 && S.saving; i++) await new Promise(r => setTimeout(r, 100));
    if (S.dirty && S.item) await save();
    await flushText();
  }
  window.addEventListener('pagehide', () => {
    commitNote();
    if (S.dirty && S.item) {
      fetch('/api/items/' + S.item.id + '/highlights', {
        method: 'PUT', keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Review': '1' },
        body: JSON.stringify({ base_version: S.version, max_n: S.maxN, highlights: S.hl }),
      }).catch(() => {});
    }
    if (T.cm && T.dirty && !T.conflict && S.item) {
      fetch('/api/items/' + S.item.id + '/text', {
        method: 'PUT', keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Review': '1' },
        body: JSON.stringify({ base_sha256: T.sha, text: editorText() }),
      }).catch(() => {});
    }
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });

  // ------------------------------------------------------------ done

  // The button acts on what it shows, even if a newer version has replaced the item since it was opened.
  function updateDoneBtn() {
    const b = $('#doneBtn');
    S.reopen = !!S.item && S.item.status !== 'waiting';
    b.textContent = S.reopen ? 'Reopen' : 'Done';
    b.classList.toggle('primary', !S.reopen);
    const i = S.item, brief = $('#brief'), lines = [];
    if (i && i.status === 'superseded') {
      lines.push('<b>Replaced</b> by ' + (i.superseded_version == null ? 'a newer version' : 'v' + i.superseded_version) +
        ', closed ' + (i.superseded_auto ? 'automatically ' : '') + esc(fmtTime(i.superseded_at)) + '. Reopen puts it back in Waiting.');
    }
    if (i && i.kind === 'text' && i.status === 'done') lines.push('<b>Done</b> ' + esc(fmtTime(i.done_at)) + '. Reopen to edit it again.');
    if (i && i.note) lines.push('<b>Note:</b> ' + esc(i.note));
    if (T.cm) T.cm.setOption('readOnly', S.reopen);
    brief.hidden = !lines.length;
    brief.innerHTML = lines.map(l => '<div>' + l + '</div>').join('');
  }
  $('#doneBtn').addEventListener('click', async () => {
    if (!S.item) return;
    closeSheet();
    await flush();
    if (unsavedWarning()) return;
    try {
      if (S.reopen) {
        S.item = (await api('/api/items/' + S.item.id + '/done', { method: 'DELETE' })).item;
        updateDoneBtn(); toast('Reopened');
      } else {
        S.item = (await api('/api/items/' + S.item.id + '/done', { method: 'POST', body: '{}' })).item;
        toast(S.item.kind === 'text' ? (S.item.edited ? 'Done: your edits are saved' : 'Done: no edits') :
          'Done: ' + S.item.count + ' highlight' + (S.item.count === 1 ? '' : 's') + ' saved', 3000);
        location.hash = '#/';
      }
    } catch (e) { toast('Could not save that: ' + e.message, 5000); }
  });

  // test hook for automated checks
  window.__review = { S, T, PV, boundaryAt, rangeBetween, addFromRange, rangeText, rangeParts, save, flush };

  route();
})();
