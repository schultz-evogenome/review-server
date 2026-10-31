/* The key test page: the real editor and vim keys, recording what the keyboard sends and where the cursor goes,
   because simulated keys cannot show how a real keyboard and browser behave. */
'use strict';
(function () {
  const para = n => 'Paragraph ' + n + '. ' + Array.from({ length: 70 }, (_, i) => 'word' + (i + 1)).join(' ') + '.';
  const lines = ['# A sample document', ''];
  for (let n = 1; n <= 40; n++) {
    lines.push(para(n), '');
    if (n % 5 === 0) lines.push('## Section ' + n / 5, '', 'A short line.', 'Another short line.', '');
  }
  const cm = CodeMirror(document.querySelector('#editor'), {
    value: lines.join('\n'), mode: 'markdown', theme: 'goyo', keyMap: 'vim', lineWrapping: true, viewportMargin: Infinity,
    cursorScrollMargin: 120, matchBrackets: true, showCursorWhenSelecting: true,
  });
  window.reviewVim.install({ save() {}, leave() {} });
  window.reviewVim.attach(cm);

  const start = performance.now(), events = [];
  const note = (type, data) => events.push([Math.round(performance.now() - start), type, data]);
  const session = String(Date.now());
  const mods = e => (e.shiftKey ? 'S' : '') + (e.ctrlKey ? 'C' : '') + (e.altKey ? 'A' : '') + (e.metaKey ? 'M' : '');
  // On the window, so these see every key before anything else can act on it.
  window.addEventListener('keydown', e => note('down', { k: e.key, c: e.code, r: e.repeat ? 1 : 0, m: mods(e), in: e.target.tagName }), true);
  window.addEventListener('keyup', e => note('up', { k: e.key, c: e.code, m: mods(e) }), true);
  window.addEventListener('blur', () => note('blur', {}));
  window.addEventListener('focus', () => note('focus', {}));
  document.addEventListener('compositionstart', () => note('composition', {}), true);
  cm.on('cursorActivity', () => {
    const u = cm.getCursor();
    note('cursor', { l: u.line, ch: u.ch, y: Math.round(cm.cursorCoords(u, 'local').top), scroll: Math.round(window.scrollY) });
  });
  const mode = document.querySelector('#vimMode');
  mode.textContent = 'normal';
  cm.on('vim-mode-change', e => { mode.textContent = e.mode; note('mode', { mode: e.mode }); });

  const status = document.querySelector('#ktStatus'), box = document.querySelector('#ktNote');
  let sent = -1, lastNote = '';
  async function send() {
    if (events.length === sent && box.value === lastNote) return;
    const count = events.length;
    try {
      const r = await fetch('/api/keylog?session=' + session, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Review': '1' },
        body: JSON.stringify({ browser: navigator.userAgent, platform: navigator.platform, width: innerWidth, height: innerHeight, note: box.value, lineHeight: cm.defaultTextHeight(), events }),
      });
      if (!r.ok) throw new Error(String(r.status));
      sent = count; lastNote = box.value;
      status.textContent = count + ' events recorded and saved';
    } catch (e) {
      status.textContent = 'Could not save yet: ' + e.message;
    }
  }
  setInterval(send, 2000);
  window.addEventListener('pagehide', send);
  window.__keytest = { cm, events };
})();
