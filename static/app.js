/* Review queue: list of PDFs waiting for markup, and a viewer for highlighting them.
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

  // ------------------------------------------------------------ routing

  window.addEventListener('hashchange', route);
  $('#back').addEventListener('click', async () => { await flush(); location.hash = '#/'; });
  $('#refresh').addEventListener('click', () => showQueue());

  function route() {
    const m = location.hash.match(/^#\/item\/([0-9a-f]{6,40})$/);
    if (m) openItem(m[1]); else showQueue();
  }

  // ------------------------------------------------------------ queue

  async function showQueue() {
    await flush();
    teardown();
    S.item = null;
    $('#viewer').hidden = true; $('#queue').hidden = false;
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
      '<div class="card-counts">' + (i.count ? i.count + ' highlight' + (i.count === 1 ? '' : 's') + ': ' + i.change + ' change, ' + i.discuss + ' discuss' : 'No highlights yet') + '</div>' +
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
  const marks = i => (i.count ? i.count + ' highlight' + (i.count === 1 ? '' : 's') : '') +
    (i.count && i.voice_notes ? ', ' : '') + (i.voice_notes ? i.voice_notes + ' voice note' + (i.voice_notes === 1 ? '' : 's') : '');

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
        '<span class="muted"> &middot; queued ' + esc(fmtTime(i.queued_at)) + ' &middot; ' + (marks(i) || 'No highlights') + '</span></a>').join('') + '</div>' +
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
      const marked = c.older.filter(i => i.count || i.voice_notes), plain = c.older.filter(i => !i.count && !i.voice_notes);
      if (!marked.length) { closeOlder(c.item, c.older); return; }
      ask.innerHTML = '<p>' + (marked.length === 1 ? 'This older version has' : 'These older versions have') + ' your highlights or voice notes:</p>' +
        '<ul>' + marked.map(i => '<li><b>v' + i.version + '</b> ' + esc(i.title) + ' <span class="muted">(' + marks(i) + ')</span></li>').join('') + '</ul>' +
        '<p>Close ' + (marked.length === 1 ? 'it' : 'them') + ' too? Closed versions go to Replaced, not Done, and Reopen brings them back.</p>' +
        '<div class="row"><button data-close="none">Cancel</button>' +
        (plain.length ? '<button data-close="plain">Close only the ' + plain.length + ' without marks</button>' : '') +
        '<button data-close="all" class="danger">Close ' + (plain.length ? 'all ' + c.older.length : (marked.length === 1 ? 'it' : 'them')) + '</button></div>';
      ask.hidden = false;
    } else if (b.dataset.close) {
      ask.hidden = true;
      if (b.dataset.close === 'all') closeOlder(c.item, c.older);
      else if (b.dataset.close === 'plain') closeOlder(c.item, c.older.filter(i => !i.count && !i.voice_notes));
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
    $('#addTitle').value = f.name.replace(/\.pdf$/i, '').replace(/_+/g, ' ');
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
      const r = await fetch('/api/queue?' + q.toString(), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/pdf', 'X-Review': '1' }, body: pendingFile });
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

  // ------------------------------------------------------------ viewer

  function teardown() {
    S.loadToken++;
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
  }
  window.addEventListener('pagehide', () => {
    commitNote();
    if (S.dirty && S.item) {
      fetch('/api/items/' + S.item.id + '/highlights', {
        method: 'PUT', keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Review': '1' },
        body: JSON.stringify({ base_version: S.version, max_n: S.maxN, highlights: S.hl }),
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
    if (i && i.note) lines.push('<b>Note:</b> ' + esc(i.note));
    brief.hidden = !lines.length;
    brief.innerHTML = lines.map(l => '<div>' + l + '</div>').join('');
  }
  $('#doneBtn').addEventListener('click', async () => {
    if (!S.item) return;
    closeSheet();
    await flush();
    try {
      if (S.reopen) {
        S.item = (await api('/api/items/' + S.item.id + '/done', { method: 'DELETE' })).item;
        updateDoneBtn(); toast('Reopened');
      } else {
        S.item = (await api('/api/items/' + S.item.id + '/done', { method: 'POST', body: '{}' })).item;
        toast('Done: ' + S.item.count + ' highlight' + (S.item.count === 1 ? '' : 's') + ' saved', 3000);
        location.hash = '#/';
      }
    } catch (e) { toast('Could not save that: ' + e.message, 5000); }
  });

  // test hook for automated checks
  window.__review = { S, boundaryAt, rangeBetween, addFromRange, rangeText, rangeParts, save, flush };

  route();
})();
