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
    shape: null,       // marking areas: 'box', 'blob', or 'trace'
    regionsEnabled: false,
    regionImages: new Map(),  // crops waiting to be saved with their figure marks
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
    $('#fbBtn').hidden = false;
    const q = $('#queue');
    if (!q.querySelector('.swipe')) q.innerHTML = '<p class="muted">Loading&hellip;</p>';
    const open = Q.open;
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
    const byClosing = (a, b) => String(b.closed_at || '').localeCompare(String(a.closed_at || ''));
    const archived = items.filter(i => i.status === 'archived').sort(byClosing), trashed = items.filter(i => i.status === 'trashed').sort(byClosing);
    const section = (key, title, list, note) => list.length ? '<details data-key="' + key + '"' + (open.has(key) ? ' open' : '') + '><summary>' + title +
      ' <span class="count">' + list.length + '</span></summary>' + (note ? '<p class="muted">' + note + '</p>' : '') + list.map(i => card(i)).join('') + '</details>' : '';
    const replacedBy = i => {
      const n = byId.get(i.superseded_by), v = n ? n.version : i.superseded_version;
      return 'replaced by ' + (v == null ? 'a newer version' : 'v' + v) + ' &middot; closed ' + (i.superseded_auto ? 'automatically ' : '') + esc(fmtTime(i.superseded_at));
    };
    const card = (i, older) => '<div class="swipe" data-id="' + i.id + '" data-status="' + i.status + '">' + swipeButtons(i.status) +
      '<div class="card ' + i.status + '" data-id="' + i.id + '">' +
      '<a class="card-link" href="#/item/' + i.id + '">' +
      '<div class="card-title">' + esc(i.title) + '</div>' +
      '<div class="card-meta">' + esc(i.folder) + (i.version == null ? '' : ' &middot; v' + i.version) +
      ' &middot; queued ' + esc(fmtTime(i.queued_at)) + (i.queued_by ? ' by ' + esc(i.queued_by) : '') +
      (i.status === 'done' ? ' &middot; done ' + esc(fmtTime(i.done_at)) : '') +
      (i.status === 'superseded' ? ' &middot; ' + replacedBy(i) : '') + '</div>' +
      (i.note ? '<div class="card-note">' + esc(i.note) + '</div>' : '') +
      '<div class="card-counts">' + (i.kind === 'text' ? [i.edited ? 'Text file, edited' : 'Text file, no edits yet', i.count ? i.count + ' highlight' + (i.count === 1 ? '' : 's') : '', i.voice_notes ? i.voice_notes + ' voice note' + (i.voice_notes === 1 ? '' : 's') : ''].filter(Boolean).join(', ') : i.count ? i.count + ' highlight' + (i.count === 1 ? '' : 's') + ': ' + i.change + ' change, ' + i.discuss + ' discuss' : 'No highlights yet') + '</div>' +
      (i.status === 'archived' || i.status === 'trashed' ? '<div class="card-meta">' + (i.status === 'archived' ? 'archived ' : 'put in the trash ') + esc(fmtTime(i.closed_at)) + '</div>' : '') +
      '</a>' + (older && older.length ? olderBlock(older) : '') + '</div></div>';
    Q.cards = new Map(cards.map(c => [c.item.id, c]));
    q.innerHTML = '<h2>Waiting <span class="count">' + cards.length + '</span></h2>' +
      (cards.length ? cards.map(c => card(c.item, c.older)).join('') : '<p class="muted">Nothing waiting.</p>') +
      section('done', 'Done', done) +
      section('replaced', 'Replaced', replaced, 'Older versions closed when a newer one arrived. Open one and tap Reopen to put it back in Waiting.') +
      section('archived', 'Archived', archived, 'Put away. Swipe left on one to restore it.') +
      section('trashed', 'Trash', trashed, 'Nothing here is deleted: the files stay where they are. Swipe left on one to restore it.');
    SW.open = null;
    q.insertAdjacentHTML('afterbegin', '<div id="fbBanner"></div>');
    renderFbBanner();
    loadFeedback();
  }

  // ------------------------------------------------------------ messages with the app's agent

  // One agent on the server looks after this app. Write to it here; it answers here, can offer choices to tap,
  // and says what it is doing. Nothing it changes goes live until you tap to put it live.
  const FB = { data: { messages: [], agent: {} }, open: false, timer: null };
  const fbSeen = () => pref.get('review.fbSeen') || '';
  function fbUnread() {
    const msgs = FB.data.messages, seen = fbSeen(), i = msgs.findIndex(m => m.id === seen);
    return msgs.slice(i + 1).filter(m => m.from === 'agent').length;
  }
  const fbWaiting = () => FB.data.messages.filter(m => m.from === 'agent' && m.choices && !m.answer);
  async function loadFeedback() {
    try { FB.data = await api('/api/feedback'); } catch (e) { return; }
    const n = fbUnread() + fbWaiting().filter(m => FB.data.messages.findIndex(x => x.id === m.id) <= FB.data.messages.findIndex(x => x.id === fbSeen())).length;
    $('#fbCount').textContent = n; $('#fbCount').hidden = !n;
    renderFbBanner();
    if (FB.open) renderFeedback();
    clearTimeout(FB.timer);
    FB.timer = setTimeout(() => { if (!$('#queue').hidden || FB.open) loadFeedback(); }, FB.open ? 8000 : 30000);
  }
  function renderFbBanner() {
    const box = $('#fbBanner');
    if (!box) return;
    const ask = fbWaiting().slice(-1)[0], unread = fbUnread();
    if (!ask && !unread) { box.innerHTML = ''; return; }
    const m = ask || FB.data.messages.filter(x => x.from === 'agent').slice(-1)[0];
    box.innerHTML = '<div class="fb-banner"><span><b>' + (ask ? 'The app\'s agent asks:' : 'The app\'s agent wrote:') + '</b> ' + esc(oneLine(m.text)) + '</span>' +
      '<button class="primary" id="fbBannerOpen">' + (ask ? 'Answer' : 'Read') + '</button></div>';
    $('#fbBannerOpen').addEventListener('click', openFeedback);
  }
  function agentLine(a) {
    if (!a || !a.seen_at) return 'No agent has connected yet. Your messages will wait for it.';
    const ago = (Date.now() - new Date(a.seen_at).getTime()) / 60000;
    if (ago > 5) return 'The app\'s agent last checked in ' + fmtTime(a.seen_at) + '. Your messages will wait for it.';
    return 'The app\'s agent is ' + (a.state === 'working' ? 'working' + (a.note ? ': ' + a.note : '') : 'here, and reads new messages within a minute') + '.';
  }
  function renderFeedback() {
    const list = $('#fbList'), atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    $('#fbAgent').textContent = agentLine(FB.data.agent);
    list.innerHTML = FB.data.messages.length ? FB.data.messages.map(m => '<div class="fb-msg ' + (m.from === 'agent' ? 'agent' : 'you') + '" data-id="' + esc(m.id) + '">' +
      esc(m.text) + (m.deploy ? '\n<span class="muted">commit ' + esc(m.deploy.slice(0, 7)) + '</span>' : '') +
      (m.choices ? '<div class="fb-choices">' + m.choices.map(c => '<button data-choice="' + esc(c) + '"' + (m.answer ? ' disabled' : '') +
        (m.answer === c ? ' class="chosen"' : '') + '>' + esc(c) + '</button>').join('') + '</div>' +
        (m.answer ? '<div class="fb-answer">You chose ' + esc(m.answer) + '</div>' : '') : '') +
      '<span class="fb-time">' + esc(fmtTime(m.at)) + '</span></div>').join('')
      : '<p class="muted">Tell the agent that looks after this app what you would like changed or fixed. It replies here.</p>';
    if (atEnd || !FB.rendered) list.scrollTop = list.scrollHeight;
    FB.rendered = true;
    const last = FB.data.messages.slice(-1)[0];
    if (last) pref.set('review.fbSeen', last.id);
    $('#fbCount').hidden = true;
    renderFbBanner();
  }
  function openFeedback() {
    FB.open = true; FB.rendered = false;
    $('#fbPanel').hidden = false;
    renderFeedback();
    loadFeedback();
  }
  $('#fbBtn').addEventListener('click', () => { if (FB.open) { FB.open = false; $('#fbPanel').hidden = true; } else openFeedback(); });
  $('#fbClose').addEventListener('click', () => { FB.open = false; $('#fbPanel').hidden = true; renderFbBanner(); });
  $('#fbForm').addEventListener('submit', async e => {
    e.preventDefault();
    const box = $('#fbText'), text = box.value.trim();
    if (!text) return;
    box.disabled = true;
    try { await api('/api/feedback', { method: 'POST', body: JSON.stringify({ text }) }); box.value = ''; FB.rendered = false; }
    catch (err) { toast('Could not send that: ' + err.message, 5000); }
    box.disabled = false;
    loadFeedback();
  });
  $('#fbText').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#fbForm').requestSubmit(); });
  $('#fbList').addEventListener('click', async e => {
    const b = e.target.closest('[data-choice]');
    if (!b || b.disabled) return;
    const id = b.closest('.fb-msg').dataset.id;
    $$('button', b.parentNode).forEach(x => { x.disabled = true; });
    try { await api('/api/feedback/' + encodeURIComponent(id) + '/answer', { method: 'POST', body: JSON.stringify({ choice: b.dataset.choice }) }); }
    catch (err) { toast('Could not send that: ' + err.message, 5000); }
    loadFeedback();
  });

  // ------------------------------------------------------------ swiping a card away

  // As in Mail: swipe a card left to show its actions, or all the way to do the one on the right. Fingers, a pen, a
  // mouse drag, or a two-finger swipe on a trackpad. Archive and Trash only change the item's status; Undo, or
  // Restore from Archived or Trash, puts it back where it was.
  const ICON = {
    archive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3" y="4" width="18" height="5" rx="1.2"/><path d="M5 9v9.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V9"/><path d="M10 13h4" stroke-linecap="round"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5h16"/><path d="M9 6.5V4.8c0-.5.4-.8.8-.8h4.4c.4 0 .8.3.8.8v1.7"/><path d="M6.2 6.5l.9 12.3c.1.7.6 1.2 1.3 1.2h7.2c.7 0 1.2-.5 1.3-1.2l.9-12.3"/><path d="M10 10.5v6M14 10.5v6"/></svg>',
    restore: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
  };
  const ACTION_LABEL = { archive: 'Archive', trash: 'Trash', restore: 'Restore' };
  // The rightmost action is the one a full swipe does.
  const actionsFor = status => status === 'trashed' ? ['restore'] : status === 'archived' ? ['trash', 'restore'] : ['trash', 'archive'];
  function swipeButtons(status) {
    const list = actionsFor(status);
    return '<div class="swipe-actions">' + list.map((a, k) => '<button class="swipe-btn ' + a + (k === list.length - 1 ? ' main' : '') +
      '" data-act="' + a + '" tabindex="-1" aria-label="' + ACTION_LABEL[a] + '">' + ICON[a] + '<span>' + ACTION_LABEL[a] + '</span></button>').join('') + '</div>';
  }
  const SW = { open: null, drag: null, wheel: null, clickBlockUntil: 0 };
  const ACTION_WIDTH = 78;
  const openWidth = s => actionsFor(s.dataset.status).length * ACTION_WIDTH;
  function place(s, x, animate) {
    s.classList.toggle('dragging', !animate);
    const width = s.offsetWidth;
    s.classList.toggle('full', -x > width * 0.6);
    $('.card', s).style.transform = x ? 'translateX(' + x + 'px)' : '';
    $('.swipe-actions', s).style.width = Math.max(0, -x) + 'px';
  }
  function closeSwipe(s) {
    if (!s) return;
    place(s, 0, true);
    s.classList.remove('full');
    $$('.swipe-btn', s).forEach(b => { b.tabIndex = -1; });
    if (SW.open === s) SW.open = null;
  }
  function openSwipe(s) {
    if (SW.open && SW.open !== s) closeSwipe(SW.open);
    place(s, -openWidth(s), true);
    $$('.swipe-btn', s).forEach(b => { b.tabIndex = 0; });
    SW.open = s;
  }
  // Where a drag lets go: past most of the card does the action on the right; past half the buttons, or a flick,
  // leaves them open; anything less closes.
  function settle(s, x, flick) {
    if (-x > s.offsetWidth * 0.6) { const list = actionsFor(s.dataset.status); act(s, list[list.length - 1]); return; }
    if (-x > openWidth(s) / 2 || flick) openSwipe(s); else closeSwipe(s);
  }
  const queueEl = $('#queue');
  queueEl.addEventListener('pointerdown', e => {
    const s = e.target.closest('.swipe');
    if (SW.open && SW.open !== s) closeSwipe(SW.open);
    if (!s || e.button > 0 || e.target.closest('.swipe-actions')) return;
    SW.drag = { s, id: e.pointerId, x0: e.clientX, y0: e.clientY, base: SW.open === s ? -openWidth(s) : 0, dir: null, x: 0, t: e.timeStamp, vx: 0 };
  });
  window.addEventListener('pointermove', e => {
    const d = SW.drag;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
    if (!d.dir) {
      if (Math.hypot(dx, dy) < 8) return;
      d.dir = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'x' : 'y';
      if (d.dir === 'y') { SW.drag = null; return; }   // a scroll, not a swipe
      try { d.s.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
      const sel = window.getSelection();
      if (sel) sel.removeAllRanges();
    }
    e.preventDefault();
    let x = d.base + dx;
    if (x > 0) x = x * 0.2;                               // nothing on the left side: it gives a little and comes back
    const dt = Math.max(1, e.timeStamp - d.t);
    d.vx = (x - d.x) / dt; d.x = x; d.t = e.timeStamp;
    place(d.s, x, false);
  }, { passive: false });
  const endDrag = (e, cancelled) => {
    const d = SW.drag;
    if (!d || e.pointerId !== d.id) return;
    SW.drag = null;
    if (d.dir !== 'x') return;
    SW.clickBlockUntil = Date.now() + 400;               // the drag was not a tap on the card
    if (cancelled) { closeSwipe(d.s); return; }
    settle(d.s, d.x, d.vx < -0.6);
  };
  window.addEventListener('pointerup', e => endDrag(e, false));
  window.addEventListener('pointercancel', e => endDrag(e, true));
  queueEl.addEventListener('dragstart', e => { if (e.target.closest('.swipe')) e.preventDefault(); });
  queueEl.addEventListener('click', e => {
    const b = e.target.closest('.swipe-btn');
    if (b) { e.preventDefault(); e.stopPropagation(); act(b.closest('.swipe'), b.dataset.act); return; }
    const s = e.target.closest('.swipe');
    if (Date.now() < SW.clickBlockUntil || (s && SW.open === s)) {
      e.preventDefault(); e.stopPropagation();
      if (s && SW.open === s && Date.now() >= SW.clickBlockUntil) closeSwipe(s);   // a tap on an open card closes it
    }
  }, true);
  window.addEventListener('scroll', () => { if (SW.open && !SW.drag) closeSwipe(SW.open); }, { passive: true });
  // A tap anywhere else closes open actions, as in Mail.
  document.addEventListener('pointerdown', e => { if (SW.open && !SW.open.contains(e.target)) closeSwipe(SW.open); }, true);
  // A two-finger swipe on a trackpad.
  queueEl.addEventListener('wheel', e => {
    const s = e.target.closest('.swipe');
    if (!s || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    e.preventDefault();
    let w = SW.wheel;
    if (!w || w.s !== s) {
      if (SW.open && SW.open !== s) closeSwipe(SW.open);
      w = SW.wheel = { s, x: SW.open === s ? -openWidth(s) : 0, timer: null };
    }
    w.x = Math.min(0, w.x - e.deltaX);
    place(s, w.x, false);
    clearTimeout(w.timer);
    w.timer = setTimeout(() => { SW.wheel = null; settle(s, w.x, false); }, 160);
  }, { passive: false });

  async function act(s, what) {
    const id = s.dataset.id, c = Q.cards.get(id);
    const items = c && s.dataset.status === 'waiting' ? [c.item].concat(c.older) : [{ id, title: $('.card-title', s).textContent }];
    const title = $('.card-title', s).textContent;
    // Out of the list first, as Mail does, then tell the server.
    s.classList.remove('dragging');
    s.classList.add('full');
    place(s, -s.offsetWidth, true);
    s.style.height = s.offsetHeight + 'px';
    requestAnimationFrame(() => requestAnimationFrame(() => { s.classList.add('leaving'); s.style.height = '0px'; s.style.marginTop = s.style.marginBottom = '0px'; s.style.opacity = '0'; }));
    if (SW.open === s) SW.open = null;
    const kind = what === 'archive' ? 'archived' : what === 'trash' ? 'trashed' : null;
    const send = (i, put) => api('/api/items/' + i.id + '/done' + (put ? '' : '?closed_as=1'), put ? { method: 'POST', body: JSON.stringify({ closed_as: put }) } : { method: 'DELETE' });
    try {
      for (const i of items) await send(i, kind);
    } catch (e) {
      toast('Could not do that: ' + e.message, 5000);
      showQueue();
      return;
    }
    const was = s.dataset.status;
    const n = items.length > 1 ? ' and ' + (items.length - 1) + ' older version' + (items.length > 2 ? 's' : '') : '';
    showUndo((kind === 'archived' ? 'Archived' : kind === 'trashed' ? 'Moved to Trash' : 'Restored') + ': ' + title + n, async () => {
      for (const i of items) {
        if (kind) await send(i, null);                                        // back to where it was
        else await send(i, was);                                              // back into Archived or Trash
      }
      showQueue();
    });
    setTimeout(() => { if (!$('#queue').hidden) showQueue(); }, 320);
  }
  let undoTimer = null, undoFn = null;
  function showUndo(text, fn) {
    undoFn = fn;
    $('#undoText').textContent = text;
    $('#undoBar').hidden = false;
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => { $('#undoBar').hidden = true; undoFn = null; }, 6000);
  }
  $('#undoBtn').addEventListener('click', async () => {
    const fn = undoFn;
    undoFn = null;
    $('#undoBar').hidden = true;
    clearTimeout(undoTimer);
    if (!fn) return;
    try { await fn(); toast('Undone'); } catch (e) { toast('Could not undo that: ' + e.message, 5000); showQueue(); }
  });

  // ------------------------------------------------------------ versions of one document

  const Q = { cards: new Map(), open: new Set() };   // waiting card id -> {item, older}; sections left open
  // Coming back to the app shows only Waiting open, so the queue is never scrolled past by accident.
  let hiddenSince = 0;
  const collapseSections = () => { Q.open.clear(); $$('#queue details[open]').forEach(d => { d.open = false; }); };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { hiddenSince = Date.now(); return; }
    if (hiddenSince) { collapseSections(); if (!$('#queue').hidden) loadFeedback(); }
  });
  window.addEventListener('pageshow', e => { if (e.persisted) collapseSections(); });
  $('#queue').addEventListener('toggle', e => {
    const k = e.target.dataset && e.target.dataset.key;
    if (k) { if (e.target.open) Q.open.add(k); else Q.open.delete(k); }
  }, true);
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
  const CM = '/static/codemirror/', CM_VERSION = '?v=6';   // these files are cached; raise this when they change
  const pref = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* not remembered */ } },
  };

  // The size of the text in the editor, per device.
  const TEXT_SIZE = { least: 12, most: 30, usual: 18 };
  function textSize() {
    const n = parseInt(pref.get('review.textSize'), 10);
    return n >= TEXT_SIZE.least && n <= TEXT_SIZE.most ? n : TEXT_SIZE.usual;
  }
  function showTextSize() {
    const n = textSize();
    document.documentElement.style.setProperty('--editor-size', n + 'px');
    $('#sizeDown').disabled = n <= TEXT_SIZE.least;
    $('#sizeUp').disabled = n >= TEXT_SIZE.most;
  }
  function stepTextSize(by) {
    const n = Math.min(TEXT_SIZE.most, Math.max(TEXT_SIZE.least, textSize() + by));
    keepingWords(() => {
      pref.set('review.textSize', String(n));
      showTextSize();
      if (T.cm) T.cm.refresh();
    });
    scheduleBadges();
    toast('Text size ' + n);
  }
  [['#sizeDown', -1], ['#sizeUp', 1]].forEach(([sel, by]) => {
    const b = $(sel);
    b.addEventListener('mousedown', e => e.preventDefault());      // the editor keeps the keyboard
    b.addEventListener('click', () => stepTextSize(by));
  });
  showTextSize();

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
    T.cm.on('change', (_c, ch) => { if (ch.origin === 'setValue') TX.reanchor = true; });
    T.cm.on('update', scheduleBadges);
    T.cm.on('cursorActivity', noteTextSelection);
    anchorHighlights();
    placeHighlights();
    setTextTool(pref.get('review.textTool') || (window.matchMedia('(pointer: coarse)').matches ? 'change' : 'edit'));
    PV.figures = new Map();
    $('#previewBtn').hidden = !isMarkdown();
    setPreview(isMarkdown() && pref.get('review.preview') === '1');
    setStatus(t.edited ? 'Saved' : '');
    if (!S.reopen && S.textTool === 'edit' && window.matchMedia('(pointer: fine)').matches) T.cm.focus();
    restorePlace();
    T.cm.on('cursorActivity', notePlace);
    pollTranscripts();
  }

  function closeText() {
    keepPlace();
    if (window.reviewVim) window.reviewVim.detach();
    setPreview(false);
    $('#previewBtn').hidden = true;
    clearTimeout(T.timer); clearTimeout(T.refreshTimer); clearTimeout(TX.selTimer);
    cancelAnimationFrame(TX.frame); cancelAnimationFrame(TX.badgeFrame);
    TX.marks.clear(); TX.trial = null; TX.stroke = null; TX.tap = null; TX.reanchor = false;
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

  // Where the reader was, per item in this browser: the cursor, and how far down the window it sat.
  const placeKey = () => 'review.place.' + S.item.id;
  function keepPlace() {
    clearTimeout(T.placeTimer);
    if (!T.cm || !S.item || T.placing) return;
    const u = T.cm.getCursor(), y = T.cm.charCoords(u, 'window').top;
    try { localStorage.setItem(placeKey(), JSON.stringify({ line: u.line, ch: u.ch, y: Math.round(y) })); } catch (e) { /* not kept */ }
  }
  function notePlace() {
    clearTimeout(T.placeTimer);
    T.placeTimer = setTimeout(keepPlace, 300);
  }
  // Figures load after this and push the text down, so stay on the place until they settle or the reader moves.
  function restorePlace() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(placeKey())); } catch (e) { /* none */ }
    if (!d || !Number.isFinite(d.line) || !Number.isFinite(d.ch) || !Number.isFinite(d.y)) return;
    const cm = T.cm, at = cm.clipPos({ line: d.line, ch: d.ch });
    T.placing = true;
    cm.setCursor(at);
    const go = () => { if (T.cm === cm) window.scrollTo(window.scrollX, cm.charCoords(at, 'page').top - d.y); };
    go();
    const seen = window.ResizeObserver ? new ResizeObserver(go) : null;
    if (seen) seen.observe(cm.getWrapperElement());
    const stop = () => {
      if (seen) seen.disconnect();
      clearTimeout(timer);
      ['keydown', 'wheel', 'pointerdown', 'touchstart'].forEach(k => window.removeEventListener(k, stop, true));
      T.placing = false;
    };
    const timer = setTimeout(stop, 5000);
    ['keydown', 'wheel', 'pointerdown', 'touchstart'].forEach(k => window.addEventListener(k, stop, true));
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
  window.addEventListener('scroll', () => { if (T.cm) notePlace(); }, { passive: true });
  window.addEventListener('beforeunload', e => {
    keepPlace();
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
    T.refreshTimer = setTimeout(() => { if (T.cm) { keepDraft(); refreshChanges(); refreshImages(); updateWords(); followEdits(); renderPreview(true); } }, 250);
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
    fig.dataset.ref = x.ref;
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
      const surface = document.createElement('span');
      surface.className = 'figure-surface';
      const a = document.createElement('a');
      a.href = src; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.draggable = false;
      if (/\.pdf$/i.test(T.images[x.ref] || '')) {
        const c = document.createElement('canvas');
        a.appendChild(c);
        drawPdfFigure(c, src, fig);
      } else {
        const img = document.createElement('img');
        img.alt = x.alt; img.src = src;
        img.draggable = false;
        img.addEventListener('load', () => {
          if (fig.widget) fig.widget.changed();
          if (T.cm && !T.placing && window.reviewVim) window.reviewVim.keepCursorInView(T.cm);
        });
        a.appendChild(img);
      }
      surface.appendChild(a);
      const over = document.createElement('span'); over.className = 'overlay';
      surface.appendChild(over);
      fig.appendChild(surface);
    }
    fig.appendChild(cap);
    drawFigureRegions(fig);
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
      if (T.cm && !T.placing && window.reviewVim) window.reviewVim.keepCursorInView(T.cm);
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
    drawAllFigureRegions();
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
  const PV = { on: false, blocks: [], figures: new Map(), ready: false, driver: 'editor', sizes: '', expectPage: null, expectBox: null, observer: null, body: null };
  const MARK_START = '', MARK_END = '', MARK_GONE = '';
  const HL_CHANGE = '\uE013', HL_DISCUSS = '\uE014', HL_END = '\uE015';   // highlights, the same way
  const noMarks = s => String(s || '').replace(/[-]|%EE%80%9[0-5]/gi, '');
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
      .replace(/\\caption(?:of)?\*?(?:\{figure\})?(?:\[[^\]]*\])?/g, '')
      .replace(/\\(?:centering|raggedright|par|newpage|noindent|clearpage|smallskip|medskip|bigskip|small|footnotesize|scriptsize)\b/g, '');
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
    for (const h of S.hl) {
      const a = h.anchor;
      if (!a) continue;
      for (let l = a.line; l <= a.end_line && l < lines.length; l++) {
        // Fences and rules must stay as they are, or the Markdown around them stops parsing.
        if (/^\s*(?:```|~~~|[-=*_]{3,}\s*$)/.test(lines[l])) continue;
        const lead = /^\s*(?:(?:[-*+]|\d+[.)]|#{1,6}|>)\s+)*/.exec(lines[l])[0].length;
        const from = Math.max(l === a.line ? a.ch : 0, lead), to = l === a.end_line ? a.end_ch : lines[l].length;
        if (from >= to) continue;
        add(l, from, h.tag === 'discuss' ? HL_DISCUSS : HL_CHANGE, 1);
        add(l, to, HL_END, 0);
      }
    }
    return lines.map((text, n) => {
      const list = edits.get(n);
      if (!list) return text;
      list.sort((p, q) => q.at - p.at || q.order - p.order);
      for (const e of list) text = text.slice(0, e.at) + e.text + text.slice(e.at);
      return text;
    }).join('\n');
  }
  function renderPreview(edited) {
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
    box.innerHTML = '<div class="pv-body">' + html.split(MARK_START).join('<mark class="pv-new">').split(MARK_END).join('</mark>')
      .split(MARK_GONE).join('<span class="pv-gone"></span>').split(HL_CHANGE).join('<mark class="pv-hl change">')
      .split(HL_DISCUSS).join('<mark class="pv-hl discuss">').split(HL_END).join('</mark>') + '</div>';
    const seen = {};
    $$('.pv-fig', box).forEach(el => {
      const ref = el.dataset.ref, alt = el.dataset.alt;
      seen[ref] = (seen[ref] || 0) + 1;
      const key = ref + '#' + seen[ref];
      if (!PV.figures.has(key)) PV.figures.set(key, buildFigure({ ref, alt }));
      el.replaceWith(PV.figures.get(key));
    });
    drawAllFigureRegions();
    box.scrollTop = top;
    watchPanes();
    if (edited) PV.driver = 'editor';
    alignPanes(PV.driver);
    if (edited) showEdit();
  }
  // Keep the block being edited in view.
  function showEdit() {
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
    PV.expectBox = box.scrollTop;
  }

  // The two panes scroll together. Each block knows its lines, so a height in the editor's page can be matched to a
  // height in the preview, in straight lines between block edges, whichever side a figure or a long line makes taller.
  function scrollAnchors() {
    const box = $('#preview'), out = [[0, 0]];
    const add = (e, p) => { const last = out[out.length - 1]; if (e > last[0] && p > last[1]) out.push([e, p]); };
    for (const b of $$('.pv-block', box)) {
      add(T.cm.heightAtLine(Number(b.dataset.from), 'page'), b.offsetTop);
      add(T.cm.heightAtLine(Number(b.dataset.to) + 1, 'page'), b.offsetTop + b.offsetHeight);
    }
    add(document.documentElement.scrollHeight, box.scrollHeight);
    return out;
  }
  function across(y, a, from, to) {
    if (a.length < 2) return 0;
    let i = 1;
    while (i < a.length - 1 && a[i][from] < y) i++;
    const p = a[i - 1], q = a[i], t = (y - p[from]) / (q[from] - p[from]);
    return p[to] + Math.min(1, Math.max(0, t)) * (q[to] - p[to]);
  }
  // The panes are level at a reading line partway down the window. That line runs up to the very top as a pane reaches
  // its top, and down to the very bottom as it reaches its end, so both panes get to both ends together.
  const READING_LINE = 0.4;
  function readingLine(s, most, height) {
    const r = READING_LINE * height, head = Math.min(r, most / 2), tail = Math.min(height - r, most / 2);
    if (s < head) return s + s / head * r;
    if (s > most - tail) return s + r + (s - most + tail) / tail * (height - r);
    return s + r;
  }
  function scrollForLine(y, most, height) {
    if (most <= 0) return 0;
    const r = READING_LINE * height, head = Math.min(r, most / 2), tail = Math.min(height - r, most / 2);
    if (y < head + r) return y / (1 + r / head);
    if (y > most - tail + r) return most - tail + (y - most + tail - r) / (1 + (height - r) / tail);
    return y - r;
  }
  function alignPanes(driver) {
    if (!PV.on || !T.cm) return;
    const box = $('#preview'), a = scrollAnchors();
    const pageH = window.innerHeight, pageMost = document.documentElement.scrollHeight - pageH;
    const boxH = box.clientHeight, boxMost = box.scrollHeight - boxH;
    if (driver === 'preview') {
      const y = across(readingLine(box.scrollTop, boxMost, boxH), a, 1, 0);
      window.scrollTo(window.scrollX, scrollForLine(y, pageMost, pageH));
      PV.expectPage = window.scrollY;
    } else {
      const y = across(readingLine(window.scrollY, pageMost, pageH), a, 0, 1);
      box.scrollTop = scrollForLine(y, boxMost, boxH);
      PV.expectBox = box.scrollTop;
    }
  }
  // A pane moved by the other one fires a scroll event too; those are not the reader's, and are not followed.
  const atExpected = (now, expected) => expected !== null && Math.abs(now - expected) < 1.5;
  window.addEventListener('scroll', () => {
    if (!PV.on) return;
    if (atExpected(window.scrollY, PV.expectPage)) { PV.expectPage = null; return; }
    PV.driver = 'editor';
    alignPanes('editor');
  }, { passive: true });
  $('#preview').addEventListener('scroll', () => {
    if (!PV.on) return;
    if (atExpected($('#preview').scrollTop, PV.expectBox)) { PV.expectBox = null; return; }
    PV.driver = 'preview';
    alignPanes('preview');
  }, { passive: true });
  // Figures that finish loading, and a window that rewraps the text, move everything below them.
  const paneSizes = () => {
    const w = T.cm.getWrapperElement();
    return [w.offsetWidth, w.offsetHeight, PV.body ? PV.body.offsetWidth : 0, PV.body ? PV.body.offsetHeight : 0].join();
  };
  function watchPanes() {
    if (!window.ResizeObserver) return;
    if (!PV.observer) {
      PV.observer = new ResizeObserver(() => {
        if (!PV.on || !T.cm || paneSizes() === PV.sizes) return;
        PV.sizes = paneSizes();
        alignPanes(PV.driver);
      });
      PV.observer.observe(T.cm.getWrapperElement());
    }
    if (PV.body) PV.observer.unobserve(PV.body);
    PV.body = $('#preview .pv-body');
    PV.observer.observe(PV.body);
    PV.sizes = paneSizes();
  }
  function setPreview(on) {
    PV.on = !!on;
    document.body.classList.toggle('previewing', PV.on);
    const box = $('#preview'), btn = $('#previewBtn');
    box.hidden = !PV.on;
    btn.classList.toggle('on', PV.on);
    btn.setAttribute('aria-pressed', String(PV.on));
    if (!PV.on) {
      box.innerHTML = '';
      if (PV.observer) PV.observer.disconnect();
      PV.observer = PV.body = null;
    }
    if (T.cm) T.cm.refresh();
    if (PV.on) { PV.driver = 'editor'; renderPreview(); }
  }
  $('#previewBtn').addEventListener('click', () => {
    keepingWords(() => {
      setPreview(!PV.on);
      pref.set('review.preview', PV.on ? '1' : '0');
    });
  });
  // The text is about to rewrap: stay on the same words.
  function keepingWords(change) {
    const cm = T.cm, y = READING_LINE * window.innerHeight;
    const at = cm && window.scrollY > 2 ? cm.coordsChar({ left: cm.getWrapperElement().getBoundingClientRect().left + 8, top: y }, 'window') : null;
    change();
    if (at) window.scrollTo(window.scrollX, cm.charCoords(at, 'page').top - y);
  }

  // ------------------------------------------------------------ highlights in a text file

  // In the editor a highlight is a mark, so it moves with the text as it is edited. It is saved as a line and column
  // with the words it covers, which find it again if the text has changed since. A Pencil stroke marks the words it
  // crosses; nothing is written by hand. While a pen is chosen the editor takes no input, so neither Scribble nor the
  // keyboard can step in, and fingers still scroll.
  const TX = { marks: new Map(), trial: null, stroke: null, tap: null, frame: 0, badgeFrame: 0, selTimer: null, reanchor: false };
  const anchorOf = f => ({ line: f.from.line, ch: f.from.ch, end_line: f.to.line, end_ch: f.to.ch });
  const sameAnchor = (a, b) => (!a && !b) || (!!a && !!b && a.line === b.line && a.ch === b.ch && a.end_line === b.end_line && a.end_ch === b.end_ch);
  const fromOf = a => ({ line: a.line, ch: a.ch }), toOf = a => ({ line: a.end_line, ch: a.end_ch });

  function placeOf(h) {
    if (h.region) {
      const what = h.region.shape === 'vector' ? 'tracing' : 'figure';
      return h.region.image ? what + ': ' + refLabel(h.region.image) : what + ' on page ' + h.region.page;
    }
    if (h.rects && h.rects.length) return 'page ' + h.page;
    return h.anchor ? 'line ' + (h.anchor.line + 1) : 'its text is gone';
  }

  // Where this highlight's words are now: where they were, or else the nearest place they appear.
  function findWords(h) {
    const cm = T.cm, a = h.anchor;
    if (a && cm.getRange(fromOf(a), toOf(a), '\n') === h.text) return a;
    if (!h.text) return null;
    const all = cm.getValue('\n'), want = a ? a.line : (h.page || 1) - 1;
    let best = null;
    for (let i = all.indexOf(h.text); i >= 0; i = all.indexOf(h.text, i + 1)) {
      const line = cm.posFromIndex(i).line;
      if (!best || Math.abs(line - want) < Math.abs(best.line - want)) best = { i, line };
    }
    return best && anchorOf({ from: cm.posFromIndex(best.i), to: cm.posFromIndex(best.i + h.text.length) });
  }
  function anchorHighlights() {
    let changed = false;
    for (const h of S.hl) {
      if (h.region) continue;
      const a = findWords(h);
      if (!sameAnchor(a, h.anchor)) { h.anchor = a; if (a) h.page = a.line + 1; changed = true; }
    }
    TX.reanchor = false;
    return changed;
  }
  // After edits: where the marks have moved to, and the words they now cover. A highlight whose words were all deleted
  // stays, with its voice notes, and keeps the words it last had.
  function readMarks() {
    let changed = false;
    for (const h of S.hl) {
      const m = TX.marks.get(h.id);
      if (!m) continue;
      const f = m.find(), a = f ? anchorOf(f) : null, text = f ? T.cm.getRange(f.from, f.to, '\n') : h.text;
      if (sameAnchor(a, h.anchor) && text === h.text) continue;
      h.anchor = a; h.text = text;
      if (a) h.page = a.line + 1;
      h.updated_at = isoLocal();
      changed = true;
    }
    return changed;
  }
  function placeHighlights() {
    const cm = T.cm;
    cm.operation(() => {
      TX.marks.forEach(m => m.clear());
      TX.marks.clear();
      for (const h of S.hl) {
        if (h.anchor) TX.marks.set(h.id, cm.markText(fromOf(h.anchor), toOf(h.anchor), { className: 'cm-hl-' + h.tag + (S.openN === h.n ? ' cm-hl-open' : '') }));
      }
    });
    drawBadges();
  }
  function followEdits() {
    if (!S.hl.length) return;
    if (TX.reanchor) {            // the whole text was replaced, which takes the marks with it
      if (anchorHighlights()) scheduleSave();
      placeHighlights();
    } else if (readMarks()) scheduleSave();
  }
  function redrawTextHighlights() {
    if (TX.reanchor) anchorHighlights();
    else if (readMarks()) scheduleSave();
    placeHighlights();
    renderPreview();
  }

  // Numbers in the margin, as on a PDF: they do not disturb the text, its wrapping, or the cursor's movement.
  function scheduleBadges() {
    cancelAnimationFrame(TX.badgeFrame);
    TX.badgeFrame = requestAnimationFrame(drawBadges);
  }
  function drawBadges() {
    const cm = T.cm, ed = $('#editor');
    if (!cm) return;
    let box = $('#hlBadges');
    if (!box) { box = document.createElement('div'); box.id = 'hlBadges'; ed.appendChild(box); }
    box.innerHTML = '';
    const base = ed.getBoundingClientRect(), left = Math.max(0, cm.getWrapperElement().getBoundingClientRect().left - base.left - 34);
    const placed = [];
    for (const h of S.hl) {
      if (!h.anchor) continue;
      const c = cm.charCoords(fromOf(h.anchor), 'window'), y = (c.top + c.bottom) / 2 - base.top;
      const k = placed.filter(p => Math.abs(p - y) < 14).length;
      placed.push(y);
      const b = document.createElement('div');
      b.className = 'badge ' + h.tag + (h.note ? ' noted' : '') + (h.audio && h.audio.length ? ' voiced' : '');
      b.dataset.n = String(h.n);
      b.textContent = h.n;
      b.style.top = y + 'px';
      b.style.left = Math.max(0, left - k * 30) + 'px';
      box.appendChild(b);
    }
  }

  function setTextTool(tool) {
    S.textTool = tool;
    pref.set('review.textTool', tool);
    $$('[data-ttool]').forEach(b => b.classList.toggle('on', b.dataset.ttool === tool));
    $('#editor').classList.toggle('drawing', tool !== 'edit');
    $('#preview').classList.toggle('drawing', tool !== 'edit');
    applyReadOnly();
    if (tool === 'edit') setShape(null);
    if (tool !== 'edit') {
      $('#selbar').hidden = true;
      if (T.cm && T.cm.somethingSelected()) T.cm.setCursor(T.cm.getCursor());
    } else if (T.cm && !S.reopen && window.matchMedia('(pointer: fine)').matches) T.cm.focus();
  }
  function applyReadOnly() {
    if (T.cm) T.cm.setOption('readOnly', S.reopen ? true : S.textTool === 'edit' ? false : 'nocursor');
  }
  $$('[data-ttool]').forEach(b => b.addEventListener('click', () => setTextTool(b.dataset.ttool)));
  // Typing with a pen chosen would otherwise seem to do nothing.
  document.addEventListener('keydown', e => {
    if (!T.cm || S.reopen || S.textTool === 'edit' || e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    toast('A pen is chosen. Tap Edit to type.');
  });

  // The words a stroke crosses, without the spaces at either end. Null if there are none.
  function wordsBetween(a, b) {
    const cm = T.cm, first = CodeMirror.cmpPos(a, b) <= 0;
    return trimmed(cm.findWordAt(first ? a : b).anchor, cm.findWordAt(first ? b : a).head);
  }
  function trimmed(from, to) {
    const cm = T.cm, text = cm.getRange(from, to, '\n');
    if (!text.trim()) return null;
    const start = cm.indexFromPos(from), lead = text.length - text.trimStart().length;
    return { from: cm.posFromIndex(start + lead), to: cm.posFromIndex(start + text.trimEnd().length) };
  }
  function addTextHighlight(r, tag) {
    if (S.reopen) { toast('Reopen it to add highlights'); return; }
    if (!r) { toast('No text there'); return; }
    const t = isoLocal(), anchor = anchorOf(r);
    S.maxN = Math.max(S.maxN, S.hl.reduce((m, h) => Math.max(m, h.n || 0), 0)) + 1;
    const h = { n: S.maxN, id: newId(), tag, page: anchor.line + 1, text: T.cm.getRange(r.from, r.to, '\n'), note: '', rects: [], anchor, created_at: t, updated_at: t };
    S.hl.push(h);
    redrawAll();
    scheduleSave();
    showBar('#' + h.n + ' ' + h.tag + ': ' + h.text.slice(0, 60) + (h.text.length > 60 ? '…' : ''), { type: 'add', id: h.id }, true);
  }
  function showTrial(r, tag) {
    if (TX.trial) TX.trial.clear();
    TX.trial = r ? T.cm.markText(r.from, r.to, { className: 'cm-hl-' + tag + ' cm-hl-trial' }) : null;
  }

  const editorEl = $('#editor');
  editorEl.addEventListener('touchstart', e => {
    if (!T.cm || S.textTool === 'edit') return;
    if (Array.from(e.touches).some(t => t.touchType === 'stylus')) { e.preventDefault(); e.stopPropagation(); }
  }, { passive: false, capture: true });
  // A hand drifts: within most of a row of where the stroke began, it stays on that row.
  function strokePos(e) {
    const s = TX.stroke, y = s && Math.abs(e.clientY - s.y0) < 0.7 * T.cm.defaultTextHeight() ? s.y0 : e.clientY;
    return T.cm.coordsChar({ left: e.clientX, top: y }, 'window');
  }
  editorEl.addEventListener('pointerdown', e => {
    if (!T.cm) return;
    const badge = e.target.closest && e.target.closest('#hlBadges .badge');
    TX.tap = { x: e.clientX, y: e.clientY, t: Date.now(), n: badge ? Number(badge.dataset.n) : null };
    if (badge) { e.stopPropagation(); return; }
    if (S.textTool === 'edit' || S.shape || e.button > 0 || e.pointerType === 'touch' || (e.target.closest && e.target.closest('.cm-figure'))) return;
    e.preventDefault(); e.stopPropagation();
    try { editorEl.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
    TX.stroke = { id: e.pointerId, x0: e.clientX, y0: e.clientY, tag: S.textTool, moved: false };
    TX.stroke.a = strokePos(e);
  }, true);
  editorEl.addEventListener('pointermove', e => {
    const s = TX.stroke;
    if (!s || e.pointerId !== s.id) return;
    e.preventDefault();
    if (Math.hypot(e.clientX - s.x0, e.clientY - s.y0) < 6) return;
    s.moved = true;
    const b = strokePos(e);
    cancelAnimationFrame(TX.frame);
    TX.frame = requestAnimationFrame(() => { if (TX.stroke === s) showTrial(wordsBetween(s.a, b), s.tag); });
  }, true);
  editorEl.addEventListener('pointerup', e => {
    const t = TX.tap, s = TX.stroke;
    TX.tap = null;
    if (!T.cm) return;
    if (s && e.pointerId === s.id) {
      const b = strokePos(e);
      TX.stroke = null;
      cancelAnimationFrame(TX.frame);
      showTrial(null);
      if (s.moved) { addTextHighlight(wordsBetween(s.a, b), s.tag); return; }
    }
    if (!t || Math.hypot(e.clientX - t.x, e.clientY - t.y) >= 8 || Date.now() - t.t >= 500) return;
    if (t.n !== null) { openSheet(t.n); return; }
    if (S.textTool === 'edit') return;
    const pos = T.cm.coordsChar({ left: e.clientX, top: e.clientY }, 'window');
    const here = T.cm.findMarksAt(pos);
    for (const h of S.hl) if (here.includes(TX.marks.get(h.id))) { openSheet(h.n); return; }
  }, true);
  editorEl.addEventListener('pointercancel', () => {
    TX.stroke = null; TX.tap = null;
    cancelAnimationFrame(TX.frame);
    if (T.cm) showTrial(null);
  }, true);

  // A selection made by finger, mouse, or visual mode can be marked too.
  function noteTextSelection() {
    clearTimeout(TX.selTimer);
    TX.selTimer = setTimeout(() => {
      const cm = T.cm;
      if (!cm) return;
      const show = !S.reopen && S.textTool === 'edit' && cm.somethingSelected() && cm.listSelections().length === 1;
      $('#selbar').hidden = !show;
      if (show) $('#lastbar').hidden = true;
    }, 150);
  }
  function markTextSelection(tag) {
    const cm = T.cm, s = cm.listSelections()[0], first = CodeMirror.cmpPos(s.anchor, s.head) <= 0;
    const r = trimmed(first ? s.anchor : s.head, first ? s.head : s.anchor);
    $('#selbar').hidden = true;
    addTextHighlight(r, tag);
    if (cm.state.vim && cm.state.vim.visualMode) CodeMirror.Vim.exitVisualMode(cm);
    else cm.setCursor(first ? s.head : s.anchor);
  }

  // ------------------------------------------------------------ highlights drawn in the preview

  // What is rendered is not what is written: *word*, renders as word, and \\emph{word} as word. Each rendered block knows
  // its lines, so its words are found in order among those lines, passing over markup. A highlight made here is then the
  // same as one made in the editor, on the same words of the source.
  const MARKUP = new Set('*_`~\\{}$');
  const wordChar = c => /[\p{L}\p{N}]/u.test(c || '');
  function matchWord(src, word, from) {
    for (let k = src.indexOf(word[0], from); k >= 0 && k <= from + 600; k = src.indexOf(word[0], k + 1)) {
      if (wordChar(word[0]) && wordChar(src[k - 1])) continue;
      let m = k + 1, i = 1;
      for (; i < word.length; i++, m++) {
        while (m < src.length && src[m] !== word[i] && MARKUP.has(src[m])) m++;
        if (src[m] !== word[i]) break;
      }
      if (i === word.length && !(wordChar(word[word.length - 1]) && wordChar(src[m]))) return { s: k, e: m };
    }
    return null;
  }
  function blockTexts(block) {
    const walk = document.createTreeWalker(block, NodeFilter.SHOW_TEXT), nodes = [];
    let at = 0, text = '';
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (n.parentElement.closest('.cm-figure')) continue;
      nodes.push({ node: n, at });
      at += n.data.length;
      text += n.data;
    }
    return { nodes, text };
  }
  function blockWords(block) {
    const cm = T.cm, from = Number(block.dataset.from), start = { line: from, ch: 0 };
    const src = cm.getRange(start, { line: Number(block.dataset.to) + 1, ch: 0 }, '\n'), base = cm.indexFromPos(start);
    const words = [];
    let j = 0;
    for (const w of blockTexts(block).text.matchAll(/\S+/g)) {
      const hit = matchWord(src, w[0], j);
      if (hit) j = hit.e;
      // The letters of the word, without punctuation around it: a stroke takes the comma only if it reaches the comma.
      const r0 = w.index, r1 = r0 + w[0].length;
      const lead = (/^[^\p{L}\p{N}]*/u.exec(w[0]) || [''])[0].length, tail = (/[^\p{L}\p{N}]*$/u.exec(w[0]) || [''])[0].length;
      let s = hit ? hit.s : null, e = hit ? hit.e : null;
      if (hit && lead < w[0].length) {
        while (s < e && !wordChar(src[s])) s++;
        while (e > s && !wordChar(src[e - 1])) e--;
      }
      words.push({ r0, r1, s: hit ? base + hit.s : null, e: hit ? base + hit.e : null, inR0: r0 + lead, inR1: r1 - tail, inS: hit ? base + s : null, inE: hit ? base + e : null });
    }
    return words;
  }
  // A point in the preview: which block, and how far along its rendered text.
  function pointFromDom(node, off) {
    const box = $('#preview');
    if (!node || !box.contains(node)) return null;
    const el = node.nodeType === 3 ? node.parentElement : node, block = el.closest('.pv-block');
    if (!block) return null;
    const { nodes, text } = blockTexts(block);
    const here = nodes.find(n => n.node === node);
    if (here) return { block, offset: here.at + off };
    const r = document.createRange();
    r.setStart(node, off);
    const next = nodes.find(n => r.comparePoint(n.node, 0) >= 0);
    return { block, offset: next ? next.at : text.length };
  }
  function pointAt(x, y) {
    const box = $('#preview');
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      const p = r && pointFromDom(r.startContainer, r.startOffset);
      if (p) return p;
    } else if (document.caretPositionFromPoint) {
      const r = document.caretPositionFromPoint(x, y);
      const p = r && pointFromDom(r.offsetNode, r.offset);
      if (p) return p;
    }
    // In a margin, or between blocks: the nearest block.
    const blocks = $$('.pv-block', box);
    if (!blocks.length) return null;
    const below = blocks.find(b => b.getBoundingClientRect().bottom >= y);
    return below ? { block: below, offset: 0 } : { block: blocks[blocks.length - 1], offset: Infinity };
  }
  // The source words between two points, whichever came first.
  function sourceBetween(a, b) {
    const flip = a.block !== b.block ? !!(a.block.compareDocumentPosition(b.block) & Node.DOCUMENT_POSITION_PRECEDING) : b.offset < a.offset;
    const first = flip ? b : a, last = flip ? a : b;
    const startWords = blockWords(first.block), endWords = last.block === first.block ? startWords : blockWords(last.block);
    const start = startWords.find(w => w.r1 > first.offset && w.s !== null);
    let end = null;
    for (const w of endWords) if (w.r0 < last.offset && w.e !== null) end = w;
    if (first.block === last.block && start && (!end || end.e <= start.s)) end = start;  // within one word
    if (!start || !end) return null;
    const s = first.offset >= start.inR0 ? start.inS : start.s, e = last.offset <= end.inR1 ? end.inE : end.e;
    return e > s ? trimmed(T.cm.posFromIndex(s), T.cm.posFromIndex(e)) : null;
  }
  function highlightAtPoint(p) {
    const w = blockWords(p.block).find(x => x.r1 > p.offset && x.s !== null);
    if (!w) return null;
    const pos = T.cm.posFromIndex(w.s), cmp = CodeMirror.cmpPos;
    return S.hl.slice().reverse().find(h => h.anchor && cmp(fromOf(h.anchor), pos) <= 0 && cmp(pos, toOf(h.anchor)) < 0) || null;
  }
  function domAt(block, offset) {
    const { nodes } = blockTexts(block);
    let n = nodes[0];
    for (const x of nodes) if (x.at <= offset) n = x;
    return n && { node: n.node, off: Math.min(offset - n.at, n.node.data.length) };
  }
  function showPreviewTrial(a, b, tag) {
    const box = $('#preview');
    $$('.pv-trial', box).forEach(d => d.remove());
    if (!a || !b) return;
    const flip = a.block !== b.block ? !!(a.block.compareDocumentPosition(b.block) & Node.DOCUMENT_POSITION_PRECEDING) : b.offset < a.offset;
    const from = domAt((flip ? b : a).block, (flip ? b : a).offset), to = domAt((flip ? a : b).block, (flip ? a : b).offset);
    if (!from || !to) return;
    const r = document.createRange();
    r.setStart(from.node, from.off); r.setEnd(to.node, to.off);
    const base = box.getBoundingClientRect();
    for (const q of r.getClientRects()) {
      const d = document.createElement('div');
      d.className = 'pv-trial ' + tag;
      d.style.cssText = 'left:' + (q.left - base.left + box.scrollLeft) + 'px;top:' + (q.top - base.top + box.scrollTop) + 'px;width:' + q.width + 'px;height:' + q.height + 'px';
      box.appendChild(d);
    }
  }
  const previewEl = $('#preview');
  previewEl.addEventListener('touchstart', e => {
    if (!T.cm || S.textTool === 'edit') return;
    if (Array.from(e.touches).some(t => t.touchType === 'stylus')) e.preventDefault();
  }, { passive: false });
  const previewStrokePoint = (e, s) => {
    const row = parseFloat(getComputedStyle(previewEl).lineHeight) || 26;
    return pointAt(e.clientX, s && Math.abs(e.clientY - s.y0) < 0.7 * row ? s.y0 : e.clientY);
  };
  previewEl.addEventListener('pointerdown', e => {
    if (!T.cm || !PV.on || S.textTool === 'edit' || S.shape || e.button > 0 || e.target.closest('.cm-figure')) return;
    TX.tap = { x: e.clientX, y: e.clientY, t: Date.now(), n: null };
    if (e.pointerType === 'touch') return;
    e.preventDefault();
    try { previewEl.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
    TX.stroke = { id: e.pointerId, x0: e.clientX, y0: e.clientY, tag: S.textTool, moved: false, inPreview: true };
    TX.stroke.a = previewStrokePoint(e, TX.stroke);
  });
  previewEl.addEventListener('pointermove', e => {
    const s = TX.stroke;
    if (!s || !s.inPreview || e.pointerId !== s.id) return;
    e.preventDefault();
    if (Math.hypot(e.clientX - s.x0, e.clientY - s.y0) < 6) return;
    s.moved = true;
    const b = previewStrokePoint(e, s);
    cancelAnimationFrame(TX.frame);
    TX.frame = requestAnimationFrame(() => { if (TX.stroke === s) showPreviewTrial(s.a, b, s.tag); });
  });
  previewEl.addEventListener('pointerup', e => {
    const t = TX.tap, s = TX.stroke;
    TX.tap = null;
    if (!T.cm || !PV.on) return;
    if (s && s.inPreview && e.pointerId === s.id) {
      TX.stroke = null;
      cancelAnimationFrame(TX.frame);
      showPreviewTrial(null);
      if (s.moved) {
        const b = previewStrokePoint(e, s);
        addTextHighlight(s.a && b ? sourceBetween(s.a, b) : null, s.tag);
        return;
      }
    }
    if (S.textTool === 'edit' || !t || Math.hypot(e.clientX - t.x, e.clientY - t.y) >= 8 || Date.now() - t.t >= 500) return;
    const p = pointAt(e.clientX, e.clientY), h = p && highlightAtPoint(p);
    if (h) openSheet(h.n);
  });
  previewEl.addEventListener('pointercancel', () => {
    if (TX.stroke && TX.stroke.inPreview) TX.stroke = null;
    TX.tap = null;
    cancelAnimationFrame(TX.frame);
    showPreviewTrial(null);
  });
  // Text selected in the preview, with Edit chosen.
  function notePreviewSelection() {
    if (!PV.on || S.textTool !== 'edit') return;
    const sel = window.getSelection(), r = sel && sel.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0) : null;
    if (r && previewEl.contains(r.commonAncestorContainer)) {
      S.lastRange = r.cloneRange();
      $('#lastbar').hidden = true;
      $('#selbar').hidden = false;
    } else if (S.lastRange) {
      S.lastRange = null;
      if (!T.cm.somethingSelected()) $('#selbar').hidden = true;
    }
  }
  function markPreviewSelection(tag) {
    const r = S.lastRange;
    S.lastRange = null;
    $('#selbar').hidden = true;
    const a = pointFromDom(r.startContainer, r.startOffset), b = pointFromDom(r.endContainer, r.endOffset);
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    addTextHighlight(a && b ? sourceBetween(a, b) : null, tag);
    if (T.cm && window.matchMedia('(pointer: fine)').matches) T.cm.focus();
  }

  // ------------------------------------------------------------ viewer

  function teardown() {
    S.loadToken++;
    cancelRegion();
    S.regionImages.clear();
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
    $('#queue').hidden = true; $('#viewer').hidden = false; $('#undoBar').hidden = true;
    $('#fbBtn').hidden = true; $('#fbPanel').hidden = true; FB.open = false;
    $('#tools').hidden = false; $('#back').hidden = false; $('#doneBtn').hidden = false; $('#refresh').hidden = true;
    $('#addBtn').hidden = true; $('#addPanel').hidden = true;
    setStatus('');
    $('#pages').innerHTML = '<div class="loading">Loading&hellip;</div>';
    let data;
    try { data = await api('/api/items/' + id); }
    catch (e) { toast('Could not open it: ' + e.message, 5000); location.hash = '#/'; return; }
    if (token !== S.loadToken) return;
    S.item = data.item;
    S.regionsEnabled = !!data.figure_regions;
    $$('[data-shapes]').forEach(b => { b.hidden = !S.regionsEnabled; });
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
    S.zoom = 1;
    await renderPages(token);
    setStatus(S.hl.length ? 'Saved' : '');
    pollTranscripts();
  }

  async function renderPages(token, keep) {
    const wrap = $('#pages');
    const avail = Math.min(document.documentElement.clientWidth - 16, 1100) * (S.zoom || 1);
    S.width = document.documentElement.clientWidth;
    wrap.classList.toggle('zoomed', (S.zoom || 1) > 1.001);
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
      const pdpr = Math.min(dpr, Math.sqrt(16e6 / (vp.width * vp.height)));   // iPad canvases stop drawing above ~16 million pixels
      canvas.width = Math.floor(vp.width * pdpr); canvas.height = Math.floor(vp.height * pdpr);
      canvas.style.width = vp.width + 'px'; canvas.style.height = vp.height + 'px';
      const text = document.createElement('div'); text.className = 'textLayer';
      const over = document.createElement('div'); over.className = 'overlay';
      div.append(canvas, text, over);
      wrap.appendChild(div);
      const P = { n, div, text, over, scale };
      S.pages.push(P);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, transform: pdpr !== 1 ? [pdpr, 0, 0, pdpr, 0, 0] : null }).promise;
      if (token !== S.loadToken) return;
      const tc = await page.getTextContent();
      await pdfjsLib.renderTextLayer({ textContentSource: tc, container: text, viewport: vp, textDivs: [] }).promise;
      drawHighlights(P);
      if (keep && keep.page === n) {
        const br = div.getBoundingClientRect();
        const x = keep.fracX != null ? br.left + window.scrollX + keep.fracX * vp.width - keep.offsetX : 0;
        window.scrollTo(Math.max(0, x), br.top + window.scrollY + keep.frac * vp.height - keep.offset);
      }
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
      if (h.region) {
        if (h.region.page === P.n) P.over.appendChild(regionBox(h));
        continue;
      }
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
  function redrawAll() {
    S.pages.forEach(drawHighlights);
    if (T.cm) redrawTextHighlights();
    drawAllFigureRegions();
    if (!$('#list').hidden) renderList();
  }

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

  // ------------------------------------------------------------ figure areas

  // Boxes use fractions of the complete page/image, so they survive zooming, reflow, and another device.
  // A crop records the visual content at creation; notes and audio belong to the same numbered highlight.
  let regionStroke = null, regionTap = null, regionClickUntil = 0;
  const SHAPE_HINT = { box: 'Drag a box around the area, then add a note or recording.',
    blob: 'Draw a loop around the area, then add a note or recording.', trace: 'Tap a figure or page to trace it with vector shapes.' };
  function setShape(shape) {
    S.shape = shape || null;
    $$('[data-shape]').forEach(b => { const on = b.dataset.shape === S.shape; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    if (S.shape) {
      if (T.cm && S.textTool === 'edit') setTextTool('change');
      else if (!T.cm && S.tool === 'select') setTool('change');
      toast(SHAPE_HINT[S.shape], 3000);
    }
    cancelRegion();
  }
  $$('[data-shape]').forEach(b => b.addEventListener('click', () => setShape(S.shape === b.dataset.shape ? null : b.dataset.shape)));

  // A blob's outline and a tracing's shapes, in fractions of the whole page or image.
  const SVGNS = 'http://www.w3.org/2000/svg';
  function pathsD(paths, X = v => v, Y = v => v) {
    return paths.map(p => {
      const n = p.nodes, d = ['M' + X(n[0][0]) + ' ' + Y(n[0][1])];
      const pairs = n.slice(1).map((b, i) => [n[i], b]).concat(p.closed ? [[n[n.length - 1], n[0]]] : []);
      for (const [a, b] of pairs) d.push('C' + X(a[4]) + ' ' + Y(a[5]) + ' ' + X(b[2]) + ' ' + Y(b[3]) + ' ' + X(b[0]) + ' ' + Y(b[1]));
      return d.join(' ') + (p.closed ? 'Z' : '');
    });
  }
  function outlineSvg(r) {
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', r.x + ' ' + r.y + ' ' + r.w + ' ' + r.h);
    svg.setAttribute('preserveAspectRatio', 'none');
    const add = (d, open) => { const p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', d); if (open) p.setAttribute('class', 'open'); svg.appendChild(p); };
    if (r.shape === 'blob') add('M' + r.points.map(p => p[0] + ' ' + p[1]).join(' L') + (r.trail ? '' : 'Z'), !!r.trail);
    else pathsD(r.paths).forEach((d, i) => add(d, !r.paths[i].closed));
    return svg;
  }
  function insidePolygon(p, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > p.y) !== (yj > p.y) && p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function enclosing(xs, ys) {
    const clamp = v => Math.max(0, Math.min(1, v));
    const x0 = clamp(Math.min(...xs)), x1 = clamp(Math.max(...xs)), y0 = clamp(Math.min(...ys)), y1 = clamp(Math.max(...ys));
    const w = Math.max(x1 - x0, 0.0005), h = Math.max(y1 - y0, 0.0005);
    return { x: Math.min(x0, 1 - w), y: Math.min(y0, 1 - h), w, h };
  }
  // Fewer points for the same outline (Ramer-Douglas-Peucker), measured on screen.
  function simplify(pts, tol, sx, sy) {
    if (pts.length < 3) return pts;
    const keep = new Array(pts.length).fill(false);
    keep[0] = keep[pts.length - 1] = true;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let far = -1, best = 0;
      const ax = pts[a][0] * sx, ay = pts[a][1] * sy, bx = pts[b][0] * sx, by = pts[b][1] * sy, len = Math.hypot(bx - ax, by - ay);
      for (let i = a + 1; i < b; i++) {
        const px = pts[i][0] * sx, py = pts[i][1] * sy;
        // A loop ends where it began: then measure from that point, not from a line of no length.
        const d = len < 1e-6 ? Math.hypot(px - ax, py - ay) : Math.abs((by - ay) * px - (bx - ax) * py + bx * ay - by * ax) / len;
        if (d > best) { best = d; far = i; }
      }
      if (best > tol) { keep[far] = true; stack.push([a, far], [far, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  }

  function regionBox(h, trial) {
    const r = h.region, box = document.createElement('div');
    box.className = 'region-box ' + h.tag + (r.shape ? ' ' + r.shape : '') + (trial ? ' trial' : '') + (S.openN === h.n ? ' open' : '');
    box.style.cssText = 'left:' + r.x * 100 + '%;top:' + r.y * 100 + '%;width:' + r.w * 100 + '%;height:' + r.h * 100 + '%';
    if (r.shape === 'blob' || r.shape === 'vector') box.appendChild(outlineSvg(r));
    if (!trial) {
      box.dataset.n = String(h.n);
      const b = document.createElement('span');
      b.className = 'badge ' + h.tag + (h.note ? ' noted' : '') + (h.audio && h.audio.length ? ' voiced' : '');
      b.textContent = h.n; b.dataset.n = String(h.n);
      box.appendChild(b);
    }
    return box;
  }
  function drawFigureRegions(fig) {
    const over = $('.overlay', fig);
    if (!over) return;
    over.innerHTML = '';
    for (const h of S.hl) if (h.region && h.region.image === fig.dataset.ref) over.appendChild(regionBox(h));
  }
  function drawAllFigureRegions() {
    $$('.cm-figure').forEach(drawFigureRegions);
  }
  function regionTarget(el) {
    const surface = el.closest('.figure-surface');
    if (surface) return { surface, over: $('.overlay', surface), source: $('img, canvas', surface), image: surface.closest('.cm-figure').dataset.ref };
    const page = el.closest('.page');
    if (page) return { surface: page, over: $('.overlay', page), source: $('canvas', page), page: Number(page.dataset.page) };
    return null;
  }
  function regionPoint(target, e) {
    const b = target.surface.getBoundingClientRect(), clamp = v => Math.max(0, Math.min(1, v));
    return { x: clamp((e.clientX - b.left) / b.width), y: clamp((e.clientY - b.top) / b.height) };
  }
  function regionBounds(s, e) {
    const p = regionPoint(s.target, e);
    return { x: Math.min(s.start.x, p.x), y: Math.min(s.start.y, p.y), w: Math.abs(p.x - s.start.x), h: Math.abs(p.y - s.start.y),
      ...(s.target.image ? { image: s.target.image } : { page: s.target.page }) };
  }
  function regionHit(target, e) {
    const p = regionPoint(target, e);
    const badge = $$('.region-box .badge', target.over).find(b => {
      const r = b.getBoundingClientRect();
      return e.clientX >= r.left - 4 && e.clientX <= r.right + 4 && e.clientY >= r.top - 4 && e.clientY <= r.bottom + 4;
    });
    if (badge) return S.hl.find(h => String(h.n) === badge.dataset.n);
    return S.hl.slice().reverse().find(h => {
      const r = h.region;
      return r && (target.image ? r.image === target.image : r.page === target.page) &&
        p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h && (r.shape !== 'blob' || insidePolygon(p, r.points));
    });
  }
  function cancelRegion() {
    if (regionStroke) {
      const { target, id } = regionStroke;
      if (target.surface.hasPointerCapture(id)) target.surface.releasePointerCapture(id);
    }
    regionStroke = null; regionTap = null;
    $$('.region-box.trial').forEach(b => b.remove());
  }
  document.addEventListener('pointerdown', e => {
    if (!S.item || !S.regionsEnabled || e.button > 0 || regionStroke) return;
    const target = regionTarget(e.target);
    if (!target || !target.source || !target.source.width) return;
    const tag = T.cm ? S.textTool : S.tool, pen = tag === 'change' || tag === 'discuss';
    const mode = pen ? S.shape || (target.image ? 'box' : null) : null, hit = regionHit(target, e);
    if (!mode && !hit) return;
    // A finger may tap a mark, but still scrolls unless the PDF's Finger draws control is checked.
    regionTap = { target, id: e.pointerId, x: e.clientX, y: e.clientY, mode, tag };
    e.stopPropagation();
    if (!mode || (e.pointerType === 'touch' && (T.cm || !S.finger))) return;
    e.preventDefault();
    if (S.reopen) { toast('Reopen it to mark a figure'); return; }
    if (mode === 'trace') return;                     // a tap opens the tracing editor
    const b = target.surface.getBoundingClientRect();
    if (!b.width || !b.height) return;
    const start = regionPoint(target, e);
    regionStroke = { target, id: e.pointerId, x: e.clientX, y: e.clientY, start, tag, mode, trail: [[start.x, start.y]] };
    try { target.surface.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
  }, true);
  document.addEventListener('pointermove', e => {
    const s = regionStroke;
    if (!s || e.pointerId !== s.id) return;
    e.preventDefault(); e.stopPropagation();
    $$('.region-box.trial', s.target.over).forEach(b => b.remove());
    if (s.mode === 'blob') {
      const p = regionPoint(s.target, e), last = s.trail[s.trail.length - 1], b = s.target.surface.getBoundingClientRect();
      if (Math.hypot((p.x - last[0]) * b.width, (p.y - last[1]) * b.height) >= 2) s.trail.push([p.x, p.y]);
      s.target.over.appendChild(regionBox({ region: trailRegion(s, true), tag: s.tag }, true));
    } else s.target.over.appendChild(regionBox({ region: regionBounds(s, e), tag: s.tag }, true));
  }, true);
  function trailRegion(s, open) {
    const b = s.target.surface.getBoundingClientRect();
    const points = open ? s.trail : simplify(s.trail, 1.2, b.width, b.height);
    return Object.assign({ shape: 'blob', points, trail: open }, enclosing(points.map(p => p[0]), points.map(p => p[1])),
      s.target.image ? { image: s.target.image } : { page: s.target.page });
  }
  document.addEventListener('pointerup', e => {
    const s = regionStroke, t = regionTap;
    if (!t || e.pointerId !== t.id) return;
    e.stopPropagation();
    const r = s && (s.mode === 'blob' ? trailRegion(s, false) : regionBounds(s, e)), b = t.target.surface.getBoundingClientRect();
    cancelRegion();
    regionClickUntil = Date.now() + 600;
    if (s && r.w * b.width >= 6 && r.h * b.height >= 6 && (s.mode !== 'blob' || r.points.length >= 3)) {
      delete r.trail;
      e.preventDefault(); addRegion(r, s.tag, s.target); return;
    }
    if (Math.hypot(e.clientX - t.x, e.clientY - t.y) < 8) {
      const h = regionHit(t.target, e);
      if (h && t.mode === 'trace' && h.region.shape === 'vector') openTrace(t.target, h.tag, h);
      else if (h) openSheet(h.n);
      else if (t.mode === 'trace' && !S.reopen) openTrace(t.target, t.tag, null);
    }
  }, true);
  document.addEventListener('pointercancel', e => {
    if (regionTap && e.pointerId === regionTap.id) cancelRegion();
  }, true);
  document.addEventListener('click', e => {
    if (Date.now() < regionClickUntil && e.target.closest('.figure-surface, .page')) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') cancelRegion(); });

  function regionCrop(region, source) {
    const sw = source.naturalWidth || source.width, sh = source.naturalHeight || source.height;
    if (!sw || !sh) throw new Error('image has not loaded');
    // Some surrounding context helps an agent locate a panel or label; the red outline gives the precise box.
    const pad = 0.035, x = Math.max(0, region.x - pad), y = Math.max(0, region.y - pad);
    const w = Math.min(1, region.x + region.w + pad) - x, h = Math.min(1, region.y + region.h + pad) - y;
    const scale = Math.min(1, 1400 / Math.max(w * sw, h * sh));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * sw * scale)); canvas.height = Math.max(1, Math.round(h * sh * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, x * sw, y * sh, w * sw, h * sh, 0, 0, canvas.width, canvas.height);
    const X = v => (v - x) / w * canvas.width, Y = v => (v - y) / h * canvas.height;
    const outline = () => {
      ctx.beginPath();
      if (region.shape === 'blob') { region.points.forEach((p, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(p[0]), Y(p[1]))); ctx.closePath(); }
      else if (region.shape === 'vector') {
        for (const p of region.paths) {
          const n = p.nodes;
          ctx.moveTo(X(n[0][0]), Y(n[0][1]));
          const pairs = n.slice(1).map((b, i) => [n[i], b]).concat(p.closed ? [[n[n.length - 1], n[0]]] : []);
          for (const [a, b] of pairs) ctx.bezierCurveTo(X(a[4]), Y(a[5]), X(b[2]), Y(b[3]), X(b[0]), Y(b[1]));
          if (p.closed) ctx.closePath();
        }
      } else ctx.rect(X(region.x), Y(region.y), region.w / w * canvas.width, region.h / h * canvas.height);
    };
    ctx.lineJoin = 'round';
    outline(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 4; ctx.stroke();
    outline(); ctx.strokeStyle = '#d1242f'; ctx.lineWidth = 2; ctx.stroke();
    return canvas.toDataURL('image/png').split(',')[1];
  }
  function addRegion(region, tag, target) {
    if (S.reopen) return;
    const t = isoLocal();
    S.maxN = Math.max(S.maxN, ...S.hl.map(h => h.n || 0)) + 1;
    const h = { n: S.maxN, id: newId(), tag, page: region.page || 0, text: '', note: '', rects: [], region, created_at: t, updated_at: t };
    try {
      S.regionImages.set(h.id, regionCrop(region, target.source));
      region.snapshot = h.id + '.png';
    } catch (e) {
      toast('Area marked. A close-up could not be saved for this image; its location will still be saved.', 6000);
    }
    S.hl.push(h);
    redrawAll(); scheduleSave();
    showBar('#' + h.n + ' ' + tag + ': figure area', { type: 'add', id: h.id }, true);
  }
  function regionSnapshot(h) {
    return S.regionImages.has(h.id) ? 'data:image/png;base64,' + S.regionImages.get(h.id)
      : '/api/items/' + S.item.id + '/regions/' + encodeURIComponent(h.region.snapshot);
  }
  // ------------------------------------------------------------ tracing a figure with vector shapes

  // For drawing outlines an agent can turn into a silhouette (a PhyloPic, say). The figure opens full screen. With
  // Draw, a tap adds a corner point and a drag pulls out a curve; tapping the first point closes the shape. With
  // Edit, points and their handles move, and a tap on a curve adds a point there. The Pencil or a mouse edits; one
  // finger pans and two zoom. Shapes are kept in the figure's own pixels while editing, and saved as fractions of it.
  const trEl = $('#trace'), trStage = $('#trStage'), trCanvas = $('#trCanvas'), trSvg = $('#trSvg');
  let TR = { open: false };
  const trClone = paths => paths.map(p => ({ closed: p.closed, nodes: p.nodes.map(n => Object.assign({}, n)) }));
  const trDist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
  function trSmooth(n) {
    const ia = Math.atan2(n.y - n.iy, n.x - n.ix), oa = Math.atan2(n.oy - n.y, n.ox - n.x);
    const d = Math.abs(((ia - oa + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    return trDist(n.x, n.y, n.ix, n.iy) > 0.01 && trDist(n.x, n.y, n.ox, n.oy) > 0.01 && d < 0.035;
  }
  async function traceSource(target) {
    const c = document.createElement('canvas'), ctx = c.getContext('2d');
    if (target.page) {
      const page = await S.pdf.getPage(target.page), one = page.getViewport({ scale: 1 });
      let scale = Math.min(4, 2800 / one.width);
      if (one.width * one.height * scale * scale > 16e6) scale = Math.sqrt(16e6 / (one.width * one.height));
      const vp = page.getViewport({ scale });
      c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      return { canvas: c, size: [one.width, one.height] };
    }
    const src = target.source, sw = src.naturalWidth || src.width, sh = src.naturalHeight || src.height;
    const scale = sw * sh > 16e6 ? Math.sqrt(16e6 / (sw * sh)) : 1;
    c.width = Math.max(1, Math.round(sw * scale)); c.height = Math.max(1, Math.round(sh * scale));
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(src, 0, 0, c.width, c.height);
    return { canvas: c, size: [sw, sh] };
  }
  async function openTrace(target, tag, h) {
    if (S.reopen) { toast('Reopen it to trace a figure'); return; }
    if (!target || !target.source) { toast('That figure is not on screen'); return; }
    let made;
    try { made = await traceSource(target); } catch (e) { toast('Could not open the figure: ' + e.message, 5000); return; }
    const W = made.canvas.width, H = made.canvas.height;
    trCanvas.width = W; trCanvas.height = H;
    trCanvas.getContext('2d').drawImage(made.canvas, 0, 0);
    const paths = h && h.region.shape === 'vector' ? h.region.paths.map(p => ({ closed: p.closed, nodes: p.nodes.map(n => ({
      x: n[0] * W, y: n[1] * H, ix: n[2] * W, iy: n[3] * H, ox: n[4] * W, oy: n[5] * H })) })) : [];
    TR = { open: true, target, tag: tag === 'discuss' ? 'discuss' : 'change', h, size: made.size, W, H, paths, active: null, sel: null,
      mode: paths.length ? 'edit' : 'draw', undo: [], redo: [], fill: false, dirty: false, g: null, pointers: new Map(), hover: null, s: 1, tx: 0, ty: 0 };
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    closeSheet();
    $('#lastbar').hidden = true; $('#selbar').hidden = true;
    trEl.hidden = false;
    trStage.classList.remove('filled');
    $('#trFill').setAttribute('aria-pressed', 'false');
    $('#trCancel').textContent = 'Cancel';
    setTraceMode(TR.mode);
    requestAnimationFrame(fitTrace);
  }
  function closeTrace() {
    TR = { open: false };
    trEl.hidden = true;
    trSvg.innerHTML = '';
    trCanvas.width = trCanvas.height = 1;
  }
  function fitTrace() {
    if (!TR.open) return;
    const r = trStage.getBoundingClientRect();
    TR.s = Math.min(r.width / TR.W, r.height / TR.H) * 0.94;
    TR.tx = (r.width - TR.W * TR.s) / 2; TR.ty = (r.height - TR.H * TR.s) / 2;
    applyTraceView();
  }
  function applyTraceView() {
    trCanvas.style.transform = 'translate(' + TR.tx + 'px,' + TR.ty + 'px) scale(' + TR.s + ')';
    drawTrace();
  }
  function setTraceMode(mode) {
    TR.mode = mode;
    if (mode === 'edit') TR.active = null;
    $$('[data-trmode]').forEach(b => b.classList.toggle('on', b.dataset.trmode === mode));
    drawTrace();
  }
  const trPoint = e => { const r = trStage.getBoundingClientRect(); return { x: (e.clientX - r.left - TR.tx) / TR.s, y: (e.clientY - r.top - TR.ty) / TR.s }; };
  const SX = x => (x * TR.s + TR.tx).toFixed(1), SY = y => (y * TR.s + TR.ty).toFixed(1);
  function segD(a, b) { return 'C' + SX(a.ox) + ' ' + SY(a.oy) + ' ' + SX(b.ix) + ' ' + SY(b.iy) + ' ' + SX(b.x) + ' ' + SY(b.y); }
  function drawTrace() {
    if (!TR.open) return;
    const out = [];
    TR.paths.forEach((p, pi) => {
      if (!p.nodes.length) return;
      const n = p.nodes;
      let d = 'M' + SX(n[0].x) + ' ' + SY(n[0].y);
      for (let i = 1; i < n.length; i++) d += segD(n[i - 1], n[i]);
      if (p.closed && n.length > 1) d += segD(n[n.length - 1], n[0]) + 'Z';
      out.push('<path class="tr-path' + (p.closed ? ' closed' : '') + '" fill-rule="evenodd" d="' + d + '"/>');
    });
    // The rubber band from the last point to the pointer, while drawing with a mouse.
    if (TR.mode === 'draw' && TR.active !== null && TR.hover && !TR.g) {
      const n = TR.paths[TR.active].nodes, a = n[n.length - 1];
      if (a) out.push('<path class="tr-band" d="M' + SX(a.x) + ' ' + SY(a.y) + 'C' + SX(a.ox) + ' ' + SY(a.oy) + ' ' + SX(TR.hover.x) + ' ' + SY(TR.hover.y) + ' ' + SX(TR.hover.x) + ' ' + SY(TR.hover.y) + '"/>');
    }
    if (!trStage.classList.contains('filled')) {
      const sel = TR.sel && TR.paths[TR.sel.p] && TR.paths[TR.sel.p].nodes[TR.sel.n];
      if (sel) {
        const p = TR.paths[TR.sel.p], k = TR.sel.n, len = p.nodes.length;
        const handles = [[sel, 'i'], [sel, 'o']];
        const prev = k > 0 ? p.nodes[k - 1] : p.closed ? p.nodes[len - 1] : null, next = k < len - 1 ? p.nodes[k + 1] : p.closed ? p.nodes[0] : null;
        if (prev && prev !== sel) handles.push([prev, 'o']);
        if (next && next !== sel) handles.push([next, 'i']);
        for (const [n, w] of handles) {
          const hx = n[w + 'x'], hy = n[w + 'y'];
          if (trDist(hx, hy, n.x, n.y) < 0.01) continue;
          out.push('<line class="tr-handle-line" x1="' + SX(n.x) + '" y1="' + SY(n.y) + '" x2="' + SX(hx) + '" y2="' + SY(hy) + '"/>' +
            '<circle class="tr-handle" r="4.5" cx="' + SX(hx) + '" cy="' + SY(hy) + '"/>');
        }
      }
      TR.paths.forEach((p, pi) => p.nodes.forEach((n, ni) => {
        const isSel = TR.sel && TR.sel.p === pi && TR.sel.n === ni, first = pi === TR.active && ni === 0 && p.nodes.length > 1;
        out.push('<circle class="tr-node' + (isSel ? ' sel' : '') + (first ? ' first' : '') + '" r="' + (first ? 7 : isSel ? 6 : 4.5) + '" cx="' + SX(n.x) + '" cy="' + SY(n.y) + '"/>');
      }));
    }
    trSvg.innerHTML = out.join('');
    const sel = TR.sel && TR.paths[TR.sel.p] && TR.paths[TR.sel.p].nodes[TR.sel.n], path = TR.sel ? TR.paths[TR.sel.p] : TR.active !== null ? TR.paths[TR.active] : null;
    $('#trSmooth').disabled = !sel; $('#trDelete').disabled = !sel;
    $('#trSmooth').textContent = sel && trSmooth(sel) ? 'Make corner' : 'Make smooth';
    $('#trClose').disabled = !path || path.nodes.length < 2;
    $('#trClose').textContent = path && path.closed ? 'Open shape' : 'Close shape';
    $('#trUndo').disabled = !TR.undo.length; $('#trRedo').disabled = !TR.redo.length;
    const shapes = TR.paths.filter(p => p.nodes.length > 1).length;
    $('#trHint').textContent = TR.mode === 'draw'
      ? (TR.active !== null ? 'Tap for a corner, drag for a curve. Tap the first point to close the shape, or New shape to start another.' : 'Tap to place the first point. Drag as you place a point to make a curve.')
      : 'Drag points or handles. Tap a curve to add a point. ' + shapes + ' shape' + (shapes === 1 ? '' : 's') + '.';
  }
  function trRemember() {
    TR.undo.push({ paths: trClone(TR.paths), active: TR.active, sel: TR.sel });
    if (TR.undo.length > 200) TR.undo.shift();
    TR.redo = [];
    TR.dirty = true;
    $('#trCancel').textContent = 'Cancel';
  }
  function trRestore(from, to) {
    const st = from.pop();
    if (!st) return;
    to.push({ paths: trClone(TR.paths), active: TR.active, sel: TR.sel });
    TR.paths = st.paths; TR.active = st.active; TR.sel = st.sel;
    TR.dirty = true;
    drawTrace();
  }
  function trHitHandle(p, tol) {
    if (!TR.sel) return null;
    const path = TR.paths[TR.sel.p], k = TR.sel.n, len = path.nodes.length;
    const list = [[k, 'i'], [k, 'o']];
    if (k > 0 || path.closed) list.push([(k - 1 + len) % len, 'o']);
    if (k < len - 1 || path.closed) list.push([(k + 1) % len, 'i']);
    for (const [ni, w] of list) {
      const n = path.nodes[ni];
      if (trDist(n[w + 'x'], n[w + 'y'], n.x, n.y) < 0.01) continue;
      if (trDist(p.x, p.y, n[w + 'x'], n[w + 'y']) < tol) return { p: TR.sel.p, n: ni, w };
    }
    return null;
  }
  function trHitNode(p, tol) {
    let best = null, bd = tol;
    TR.paths.forEach((path, pi) => path.nodes.forEach((n, ni) => {
      const d = trDist(p.x, p.y, n.x, n.y);
      if (d < bd || (d <= bd && pi === TR.active)) { bd = d; best = { p: pi, n: ni }; }
    }));
    return best;
  }
  const bez = (a, b, t) => {
    const u = 1 - t;
    return { x: u * u * u * a.x + 3 * u * u * t * a.ox + 3 * u * t * t * b.ix + t * t * t * b.x, y: u * u * u * a.y + 3 * u * u * t * a.oy + 3 * u * t * t * b.iy + t * t * t * b.y };
  };
  function trHitSegment(p, tol) {
    let best = null, bd = tol;
    TR.paths.forEach((path, pi) => {
      const n = path.nodes, count = path.closed ? n.length : n.length - 1;
      for (let i = 0; i < count; i++) {
        const a = n[i], b = n[(i + 1) % n.length];
        for (let k = 1; k < 48; k++) {
          const q = bez(a, b, k / 48), d = trDist(p.x, p.y, q.x, q.y);
          if (d < bd) { bd = d; best = { p: pi, i, t: k / 48 }; }
        }
      }
    });
    return best;
  }
  // Split a curve where it was tapped, keeping its shape (de Casteljau).
  function trSplit(hit) {
    const path = TR.paths[hit.p], a = path.nodes[hit.i], b = path.nodes[(hit.i + 1) % path.nodes.length], t = hit.t;
    const L = (p, q) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
    if (trDist(a.ox, a.oy, a.x, a.y) < 0.01 && trDist(b.ix, b.iy, b.x, b.y) < 0.01) {
      const m = L(a, b);
      path.nodes.splice(hit.i + 1, 0, { x: m.x, y: m.y, ix: m.x, iy: m.y, ox: m.x, oy: m.y });
      return { p: hit.p, n: hit.i + 1 };
    }
    const p0 = { x: a.x, y: a.y }, p1 = { x: a.ox, y: a.oy }, p2 = { x: b.ix, y: b.iy }, p3 = { x: b.x, y: b.y };
    const q0 = L(p0, p1), q1 = L(p1, p2), q2 = L(p2, p3), r0 = L(q0, q1), r1 = L(q1, q2), m = L(r0, r1);
    a.ox = q0.x; a.oy = q0.y; b.ix = q2.x; b.iy = q2.y;
    const n = { x: m.x, y: m.y, ix: r0.x, iy: r0.y, ox: r1.x, oy: r1.y };
    path.nodes.splice(hit.i + 1, 0, n);
    if (TR.active === hit.p && hit.i + 1 <= path.nodes.length - 1) { /* still drawing the same shape */ }
    return { p: hit.p, n: hit.i + 1 };
  }
  function trMakeSmooth(path, k) {
    const n = path.nodes[k], len = path.nodes.length;
    const prev = k > 0 ? path.nodes[k - 1] : path.closed ? path.nodes[len - 1] : null;
    const next = k < len - 1 ? path.nodes[k + 1] : path.closed ? path.nodes[0] : null;
    let dx = (next || n).x - (prev || n).x, dy = (next || n).y - (prev || n).y;
    const d = Math.hypot(dx, dy) || 1; dx /= d; dy /= d;
    const l1 = prev ? trDist(prev.x, prev.y, n.x, n.y) / 3 : 30 / TR.s, l2 = next ? trDist(next.x, next.y, n.x, n.y) / 3 : 30 / TR.s;
    n.ix = n.x - dx * l1; n.iy = n.y - dy * l1; n.ox = n.x + dx * l2; n.oy = n.y + dy * l2;
  }
  function trDeletePoint() {
    if (!TR.sel) return;
    trRemember();
    const path = TR.paths[TR.sel.p];
    path.nodes.splice(TR.sel.n, 1);
    if (path.closed && path.nodes.length < 3) path.closed = false;
    if (!path.nodes.length) {
      TR.paths.splice(TR.sel.p, 1);
      if (TR.active === TR.sel.p) TR.active = null;
      else if (TR.active !== null && TR.active > TR.sel.p) TR.active--;
      TR.sel = null;
    } else TR.sel = { p: TR.sel.p, n: Math.min(TR.sel.n, path.nodes.length - 1) };
    drawTrace();
  }
  function trFinishShape() {
    if (TR.active !== null && TR.paths[TR.active].nodes.length < 2) {
      TR.paths.splice(TR.active, 1);
      TR.sel = null;
    }
    TR.active = null;
    drawTrace();
  }
  const trTol = e => (e.pointerType === 'touch' ? 22 : 13) / TR.s;
  trStage.addEventListener('pointerdown', e => {
    if (!TR.open) return;
    e.preventDefault();
    try { trStage.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
    TR.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    const touches = [...TR.pointers.values()].filter(q => q.type === 'touch');
    if (touches.length >= 2) {                         // two fingers: pan and zoom
      const [a, b] = touches;
      TR.g = { type: 'pinch', d0: trDist(a.x, a.y, b.x, b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, s0: TR.s, tx0: TR.tx, ty0: TR.ty };
      return;
    }
    if (e.pointerType === 'touch' || e.button === 1 || TR.space) {
      TR.g = { type: 'pan', id: e.pointerId, x: e.clientX, y: e.clientY, tx0: TR.tx, ty0: TR.ty };
      return;
    }
    if (e.button > 0) return;
    const p = trPoint(e), tol = trTol(e), before = { paths: trClone(TR.paths), active: TR.active, sel: TR.sel };
    const handle = trHitHandle(p, tol);
    if (handle) {
      const n = TR.paths[handle.p].nodes[handle.n];
      TR.g = { type: 'handle', id: e.pointerId, ...handle, smooth: trSmooth(n), before };
      return;
    }
    const node = trHitNode(p, tol);
    if (node) {
      const path = TR.paths[node.p];
      if (TR.mode === 'draw' && TR.active === node.p && node.n === 0 && path.nodes.length >= 2 && !path.closed) {
        trRemember();
        path.closed = true;
        TR.active = null;
        TR.sel = node;
        TR.g = { type: 'pull', id: e.pointerId, ...node, x0: e.clientX, y0: e.clientY };
        drawTrace();
        return;
      }
      if (TR.mode === 'draw' && !path.closed && node.p !== TR.active && (node.n === 0 || node.n === path.nodes.length - 1)) {
        if (node.n === 0) path.nodes.reverse().forEach(n => { [n.ix, n.ox] = [n.ox, n.ix]; [n.iy, n.oy] = [n.oy, n.iy]; });
        TR.active = node.p;
        TR.sel = { p: node.p, n: path.nodes.length - 1 };
      } else TR.sel = node;
      const n = path.nodes[TR.sel.n];
      TR.g = { type: 'node', id: e.pointerId, p: TR.sel.p, n: TR.sel.n, start: p, orig: Object.assign({}, n), before };
      drawTrace();
      return;
    }
    const seg = trHitSegment(p, tol);
    if (seg) {
      trRemember();
      TR.sel = trSplit(seg);
      const n = TR.paths[TR.sel.p].nodes[TR.sel.n];
      TR.g = { type: 'node', id: e.pointerId, p: TR.sel.p, n: TR.sel.n, start: p, orig: Object.assign({}, n), moved: true };
      drawTrace();
      return;
    }
    if (TR.mode === 'draw') {
      trRemember();
      if (TR.active === null) { TR.paths.push({ closed: false, nodes: [] }); TR.active = TR.paths.length - 1; }
      const nodes = TR.paths[TR.active].nodes;
      nodes.push({ x: p.x, y: p.y, ix: p.x, iy: p.y, ox: p.x, oy: p.y });
      TR.sel = { p: TR.active, n: nodes.length - 1 };
      TR.g = { type: 'pull', id: e.pointerId, p: TR.active, n: nodes.length - 1, x0: e.clientX, y0: e.clientY };
      drawTrace();
      return;
    }
    TR.sel = null;
    TR.g = { type: 'pan', id: e.pointerId, x: e.clientX, y: e.clientY, tx0: TR.tx, ty0: TR.ty };
    drawTrace();
  });
  trStage.addEventListener('pointermove', e => {
    if (!TR.open) return;
    if (TR.pointers.has(e.pointerId)) TR.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    const g = TR.g;
    if (!g) {
      if (e.pointerType === 'mouse' && TR.mode === 'draw' && TR.active !== null) { TR.hover = trPoint(e); drawTrace(); }
      return;
    }
    e.preventDefault();
    if (g.type === 'pinch') {
      const t = [...TR.pointers.values()].filter(q => q.type === 'touch');
      if (t.length < 2) return;
      const [a, b] = t, r = trStage.getBoundingClientRect();
      const s = Math.max(0.05, Math.min(40, g.s0 * trDist(a.x, a.y, b.x, b.y) / (g.d0 || 1)));
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const ix = (g.cx - r.left - g.tx0) / g.s0, iy = (g.cy - r.top - g.ty0) / g.s0;
      TR.s = s; TR.tx = cx - r.left - ix * s; TR.ty = cy - r.top - iy * s;
      applyTraceView();
      return;
    }
    if (e.pointerId !== g.id) return;
    if (g.type === 'pan') { TR.tx = g.tx0 + e.clientX - g.x; TR.ty = g.ty0 + e.clientY - g.y; applyTraceView(); return; }
    const p = trPoint(e), path = TR.paths[g.p], n = path && path.nodes[g.n];
    if (!n) return;
    if (g.type === 'node') {
      if (!g.moved && g.before && trDist(p.x, p.y, g.start.x, g.start.y) * TR.s < 3) return;
      if (!g.moved) { if (g.before) { TR.undo.push(g.before); TR.redo = []; TR.dirty = true; } g.moved = true; }
      const dx = p.x - g.start.x, dy = p.y - g.start.y, o = g.orig;
      Object.assign(n, { x: o.x + dx, y: o.y + dy, ix: o.ix + dx, iy: o.iy + dy, ox: o.ox + dx, oy: o.oy + dy });
    } else if (g.type === 'handle') {
      if (!g.moved) { TR.undo.push(g.before); TR.redo = []; TR.dirty = true; g.moved = true; }
      const w = g.w, other = w === 'i' ? 'o' : 'i';
      n[w + 'x'] = p.x; n[w + 'y'] = p.y;
      if (g.smooth) {                                  // a smooth point keeps its two handles in line
        const len = trDist(n[other + 'x'], n[other + 'y'], n.x, n.y), d = trDist(p.x, p.y, n.x, n.y) || 1;
        n[other + 'x'] = n.x - (p.x - n.x) / d * len; n[other + 'y'] = n.y - (p.y - n.y) / d * len;
      }
    } else if (g.type === 'pull') {
      if (Math.hypot(e.clientX - g.x0, e.clientY - g.y0) < 4) return;
      n.ox = p.x; n.oy = p.y; n.ix = 2 * n.x - p.x; n.iy = 2 * n.y - p.y;
    }
    drawTrace();
  });
  const trEnd = e => {
    if (!TR.open) return;
    TR.pointers.delete(e.pointerId);
    const g = TR.g;
    if (g && (g.type === 'pinch' ? [...TR.pointers.values()].filter(q => q.type === 'touch').length < 2 : e.pointerId === g.id)) TR.g = null;
    drawTrace();
  };
  trStage.addEventListener('pointerup', trEnd);
  trStage.addEventListener('pointercancel', trEnd);
  trStage.addEventListener('pointerleave', () => { if (TR.open && TR.hover) { TR.hover = null; drawTrace(); } });
  trStage.addEventListener('dblclick', e => { if (TR.open && TR.mode === 'draw') { e.preventDefault(); trFinishShape(); } });
  trStage.addEventListener('wheel', e => {
    if (!TR.open) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {                      // a trackpad pinch, or Ctrl-scroll: zoom at the pointer
      const r = trStage.getBoundingClientRect(), ix = (e.clientX - r.left - TR.tx) / TR.s, iy = (e.clientY - r.top - TR.ty) / TR.s;
      TR.s = Math.max(0.05, Math.min(40, TR.s * Math.exp(-e.deltaY * 0.01)));
      TR.tx = e.clientX - r.left - ix * TR.s; TR.ty = e.clientY - r.top - iy * TR.s;
    } else { TR.tx -= e.deltaX; TR.ty -= e.deltaY; }
    applyTraceView();
  }, { passive: false });
  $$('[data-trmode]').forEach(b => b.addEventListener('click', () => setTraceMode(b.dataset.trmode)));
  $('#trSmooth').addEventListener('click', () => {
    if (!TR.sel) return;
    trRemember();
    const path = TR.paths[TR.sel.p], n = path.nodes[TR.sel.n];
    if (trSmooth(n)) { n.ix = n.ox = n.x; n.iy = n.oy = n.y; } else trMakeSmooth(path, TR.sel.n);
    drawTrace();
  });
  $('#trDelete').addEventListener('click', trDeletePoint);
  $('#trClose').addEventListener('click', () => {
    const k = TR.sel ? TR.sel.p : TR.active;
    if (k === null || k === undefined || !TR.paths[k] || TR.paths[k].nodes.length < 2) return;
    trRemember();
    TR.paths[k].closed = !TR.paths[k].closed;
    if (TR.paths[k].closed && TR.active === k) TR.active = null;
    drawTrace();
  });
  $('#trNew').addEventListener('click', () => { trFinishShape(); TR.sel = null; setTraceMode('draw'); });
  $('#trUndo').addEventListener('click', () => trRestore(TR.undo, TR.redo));
  $('#trRedo').addEventListener('click', () => trRestore(TR.redo, TR.undo));
  $('#trFit').addEventListener('click', fitTrace);
  $('#trFill').addEventListener('click', () => {
    const on = !trStage.classList.contains('filled');
    trStage.classList.toggle('filled', on);
    $('#trFill').setAttribute('aria-pressed', String(on));
    $('#trFill').classList.toggle('on', on);
    drawTrace();
  });
  $('#trCancel').addEventListener('click', () => {
    if (TR.dirty && $('#trCancel').textContent !== 'Tap again to discard') { $('#trCancel').textContent = 'Tap again to discard'; return; }
    closeTrace();
  });
  $('#trDone').addEventListener('click', () => {
    trFinishShape();
    const W = TR.W, H = TR.H;
    const paths = TR.paths.filter(p => p.nodes.length >= 2).map(p => ({ closed: p.closed, nodes: p.nodes.map(n => [n.x / W, n.y / H, n.ix / W, n.iy / H, n.ox / W, n.oy / H]
      .map((v, i) => Math.round(Math.max(i < 2 ? 0 : -1, Math.min(i < 2 ? 1 : 2, v)) * 1e6) / 1e6)) }));
    if (!paths.length) { toast('Draw a shape with at least two points first'); return; }
    const xs = paths.flatMap(p => p.nodes.flatMap(n => [n[0], n[2], n[4]])), ys = paths.flatMap(p => p.nodes.flatMap(n => [n[1], n[3], n[5]]));
    const region = Object.assign({ shape: 'vector', paths, size: TR.size.map(v => Math.round(v * 100) / 100) }, enclosing(xs, ys),
      TR.target.image ? { image: TR.target.image } : { page: TR.target.page });
    const crop = { source: trCanvas }, h = TR.h, tag = TR.tag;
    if (h) {
      const before = JSON.parse(JSON.stringify(h.region));
      h.region = region;
      try { S.regionImages.set(h.id, regionCrop(region, trCanvas)); region.snapshot = h.id + '.png'; } catch (e) { /* the shapes are still saved */ }
      h.updated_at = isoLocal();
      closeTrace();
      redrawAll(); scheduleSave();
      showBar('#' + h.n + ' tracing updated', { type: 'edit', id: h.id, before }, true);
    } else {
      closeTrace();
      addRegion(region, tag, crop);
    }
  });
  document.addEventListener('keydown', e => {
    if (!TR.open) return;
    e.stopPropagation();
    const k = e.key, mod = e.metaKey || e.ctrlKey;
    if (k === ' ') { TR.space = true; e.preventDefault(); return; }
    if (mod && k.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) trRestore(TR.redo, TR.undo); else trRestore(TR.undo, TR.redo); return; }
    if (k === 'Escape') { e.preventDefault(); if (TR.active !== null) trFinishShape(); else if (TR.sel) { TR.sel = null; drawTrace(); } else $('#trCancel').click(); return; }
    if (k === 'Enter') { e.preventDefault(); trFinishShape(); return; }
    if (k === 'Backspace' || k === 'Delete') { e.preventDefault(); trDeletePoint(); return; }
    if (!mod && (k === 'p' || k === 'P')) setTraceMode('draw');
    if (!mod && (k === 'v' || k === 'V' || k === 'a' || k === 'A')) setTraceMode('edit');
  }, true);
  document.addEventListener('keyup', e => { if (TR.open && e.key === ' ') TR.space = false; }, true);
  window.addEventListener('resize', () => { if (TR.open) drawTrace(); });
  // Where a mark's figure is now, to edit its tracing from the panel.
  function targetFor(region) {
    if (region.image) {
      const fig = $$('.cm-figure').find(f => f.dataset.ref === region.image && f.offsetParent !== null);
      return fig && regionTarget($('.figure-surface', fig) || fig);
    }
    const P = S.pages[region.page - 1];
    return P && regionTarget(P.div);
  }
  $('#sheetTrace').addEventListener('click', () => {
    const h = S.hl.find(x => x.n === S.openN);
    if (h && h.region) openTrace(targetFor(h.region), h.tag, h);
  });

  function highlightPayload() {
    const images = {};
    for (const h of S.hl) if (h.region && S.regionImages.has(h.id)) images[h.id] = S.regionImages.get(h.id);
    return { base_version: S.version, max_n: S.maxN, highlights: S.hl, region_images: images };
  }

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
    const h = a && (a.type === 'add' || a.type === 'edit') && S.hl.find(x => x.id === a.id);
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
    } else if (a.type === 'edit') {                 // a tracing as it was before it was edited
      const h = S.hl.find(x => x.id === a.id);
      if (!h || !a.before) return;
      h.region = a.before;
      const t = targetFor(h.region);
      try { if (t && t.source) S.regionImages.set(h.id, regionCrop(h.region, t.source)); } catch (e) { /* the shapes are still restored */ }
      h.updated_at = isoLocal();
      toast('Tracing #' + h.n + ' restored');
    }
    redrawAll(); scheduleSave();
  });

  // text selection (Select tool, or a mouse)
  let selTimer = null;
  document.addEventListener('selectionchange', () => { clearTimeout(selTimer); selTimer = setTimeout(onSelection, 180); });
  function onSelection() {
    if (T.cm) { notePreviewSelection(); return; }     // the editor keeps its own selection: noteTextSelection
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
      if (T.cm) { if (S.lastRange) markPreviewSelection(b.dataset.mark); else markTextSelection(b.dataset.mark); return; }
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

  // ------------------------------------------------------------ zooming the PDF, not the page
  // Pinching (or a trackpad pinch / ctrl+scroll on a laptop) zooms only the pages; the bar at the top and the
  // highlight sheet at the bottom keep their size (Darrin, 14 November 2026). While the fingers move, the pages are
  // scaled with CSS; when they lift, the pages are drawn again, sharp, at the new size, with the point that was under
  // the fingers kept in place.
  S.zoom = 1;
  const ZMIN = 1, ZMAX = 4;
  document.addEventListener('gesturestart', e => e.preventDefault());     // Safari: no zooming of the whole page
  document.addEventListener('gesturechange', e => e.preventDefault());
  let pinch = null;
  const pinchDist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  function startScale(mx, my) {
    const r = pagesEl.getBoundingClientRect();
    pagesEl.style.transformOrigin = (mx - r.left) + 'px ' + (my - r.top) + 'px';
  }
  pagesEl.addEventListener('touchstart', e => {
    if (e.touches.length !== 2 || !S.pdf) return;
    e.preventDefault();
    stroke = null; tap = null; clearPreview();                             // a second finger ends any pen stroke
    const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2, my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    pinch = { d0: pinchDist(e.touches), s: 1, mx, my };
    startScale(mx, my);
  }, { passive: false });
  pagesEl.addEventListener('touchmove', e => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const z = Math.min(ZMAX, Math.max(ZMIN, S.zoom * pinchDist(e.touches) / pinch.d0));
    pinch.s = z / S.zoom;
    pagesEl.style.transform = 'scale(' + pinch.s + ')';
  }, { passive: false });
  function endPinch() {
    if (!pinch) return;
    const p = pinch; pinch = null;
    setZoom(S.zoom * p.s, p.mx, p.my);
  }
  pagesEl.addEventListener('touchend', e => { if (e.touches.length < 2) endPinch(); });
  pagesEl.addEventListener('touchcancel', endPinch);
  let wheelZoom = null, wheelTimer = null;
  pagesEl.addEventListener('wheel', e => {                                // trackpad pinch arrives as ctrl+wheel
    if (!e.ctrlKey || !S.pdf) return;
    e.preventDefault();
    if (!wheelZoom) { wheelZoom = { s: 1, mx: e.clientX, my: e.clientY }; startScale(e.clientX, e.clientY); }
    wheelZoom.s = Math.min(ZMAX / S.zoom, Math.max(ZMIN / S.zoom, wheelZoom.s * Math.exp(-e.deltaY / 200)));
    pagesEl.style.transform = 'scale(' + wheelZoom.s + ')';
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => { const w = wheelZoom; wheelZoom = null; setZoom(S.zoom * w.s, w.mx, w.my); }, 250);
  }, { passive: false });
  async function setZoom(z, mx, my) {
    z = Math.min(ZMAX, Math.max(ZMIN, z));
    pagesEl.style.transform = '';
    if (Math.abs(z - S.zoom) < 0.02 || !S.pages.length) return;
    const P = S.pages.find(p => { const r = p.div.getBoundingClientRect(); return my >= r.top && my <= r.bottom; }) || S.pages[0];
    const r = P.div.getBoundingClientRect();
    S.zoom = z;
    await renderPages(++S.loadToken, { page: P.n, frac: (my - r.top) / r.height, offset: my,
                                        fracX: (mx - r.left) / r.width, offsetX: mx });
  }
  S.setZoom = setZoom;                                                     // for testing from the console

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
    if (tool === 'select') setShape(null);
    if (tool !== 'select') { const sel = window.getSelection(); if (sel) sel.removeAllRanges(); $('#selbar').hidden = true; }
  }
  $('#finger').addEventListener('change', e => {
    S.finger = e.target.checked;
    pagesEl.classList.toggle('finger', S.finger);
  });

  // ------------------------------------------------------------ editing one highlight

  const regionLabel = r => r.shape === 'vector' ? 'Vector tracing (' + r.paths.length + ' shape' + (r.paths.length === 1 ? '' : 's') + ')'
    : r.shape === 'blob' ? 'Outlined figure area' : 'Marked figure area';
  function openSheet(n, focusNote) {
    const h = S.hl.find(x => x.n === n);
    if (!h) return;
    clearTimeout(noteTimer);
    commitNote();                      // the note still being typed belongs to the highlight it was typed for
    S.openN = n;
    $('#sheetNum').textContent = '#' + h.n;
    $('#sheetPage').textContent = placeOf(h);
    const q = $('#sheetQuote');
    q.textContent = h.region ? regionLabel(h.region) : h.text; q.className = h.tag;
    $('#sheetTrace').hidden = !(h.region && h.region.shape === 'vector') || !!S.reopen;
    const picture = $('#sheetRegion');
    picture.hidden = !h.region || !h.region.snapshot;
    if (!picture.hidden) picture.src = regionSnapshot(h);
    else picture.removeAttribute('src');
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
    if (T.cm && !S.reopen && S.textTool === 'edit' && window.matchMedia('(pointer: fine)').matches) T.cm.focus();
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
    const h = a && (a.type === 'add' || a.type === 'edit') && S.hl.find(x => x.id === a.id);
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

  const toggleList = () => {
    const L = $('#list');
    if (!L.hidden) { L.hidden = true; return; }
    L.style.top = $('#bar').getBoundingClientRect().bottom + 'px';
    renderList(); L.hidden = false;
  };
  $('#listBtn').addEventListener('click', toggleList);
  $('#textListBtn').addEventListener('click', toggleList);
  function renderList() {
    const L = $('#list');
    const items = S.hl.slice().sort((a, b) => a.n - b.n);
    const counts = { change: items.filter(h => h.tag === 'change').length, discuss: items.filter(h => h.tag === 'discuss').length };
    L.innerHTML = '<div class="list-head"><b>' + items.length + ' highlight' + (items.length === 1 ? '' : 's') + '</b>' +
      '<span class="muted">' + counts.change + ' change, ' + counts.discuss + ' discuss</span>' +
      '<button id="listClose">Close</button></div>' +
      (items.length ? items.map(h => '<div class="li" data-n="' + h.n + '"><span class="badge ' + h.tag + (h.note ? ' noted' : '') + (h.audio && h.audio.length ? ' voiced' : '') + '">' + h.n + '</span><div>' +
        '<div class="li-text">' + (h.region ? regionLabel(h.region) : esc(h.text.length > 220 ? h.text.slice(0, 220) + '…' : h.text)) + '</div>' +
        (h.note ? '<div class="li-note">' + esc(h.note) + '</div>' : '') +
        (h.audio || []).map((c, k) => '<div class="li-voice">Voice note ' + (k + 1) + ' (' + clockStr(c.seconds) + '): ' + clipStatus(c.file) + '</div>').join('') +
        '<div class="li-meta">' + esc(placeOf(h)) + ' &middot; ' + h.tag + '</div></div></div>').join('')
        : '<p class="muted">No highlights yet.</p>');
    $('#listClose').addEventListener('click', () => { L.hidden = true; });
    $$('.li', L).forEach(el => el.addEventListener('click', () => {
      const h = S.hl.find(x => String(x.n) === el.dataset.n);
      if (!h) return;
      if (h.region) {
        const target = h.region.image ? $$('.cm-figure', PV.on ? previewEl : editorEl).find(f => f.dataset.ref === h.region.image)
          : (S.pages[h.region.page - 1] || {}).div;
        if (target) {
          const box = $$('.region-box', target).find(b => b.dataset.n === String(h.n));
          (box || target).scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      }
      if (T.cm && h.anchor) {
        const y = T.cm.charCoords(fromOf(h.anchor), 'page').top - $('#bar').offsetHeight - 80;
        window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
      }
      const P = h.rects && h.rects.length ? S.pages[h.rects[0].page - 1] : null;
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
    const payload = highlightPayload();
    try {
      const r = await api('/api/items/' + id + '/highlights', { method: 'PUT', body: JSON.stringify(payload) });
      if (S.item && S.item.id === id) {
        S.version = r.highlights.version; S.item = r.item;
        Object.keys(payload.region_images).forEach(hid => S.regionImages.delete(hid));
      }
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
        body: JSON.stringify(highlightPayload()),
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
    if (i && (i.status === 'archived' || i.status === 'trashed')) {
      lines.push('<b>' + (i.status === 'archived' ? 'Archived' : 'In the Trash') + '</b> ' + esc(fmtTime(i.closed_at)) + '. Reopen puts it back in Waiting.');
    }
    if (i && i.note) lines.push('<b>Note:</b> ' + esc(i.note));
    applyReadOnly();
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
        toast(S.item.kind === 'text' ? (S.item.count ? 'Done: ' + marks(S.item) + ' saved' : S.item.edited ? 'Done: your edits are saved' : 'Done: no edits') :
          'Done: ' + S.item.count + ' highlight' + (S.item.count === 1 ? '' : 's') + ' saved', 3000);
        location.hash = '#/';
      }
    } catch (e) { toast('Could not save that: ' + e.message, 5000); }
  });

  // test hook for automated checks
  window.__review = { get TR() { return TR; }, S, T, PV, TX, blockWords, pointAt, sourceBetween, boundaryAt, rangeBetween, addFromRange, rangeText, rangeParts, save, flush };

  route();
})();
