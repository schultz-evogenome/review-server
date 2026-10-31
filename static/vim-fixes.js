/* Additions to CodeMirror's vim keymap: commands it lacks, and scrolling for a page that scrolls as a whole
   (the keymap expects a box that scrolls inside the page). Bugs in the keymap itself are patched in
   codemirror/keymap/vim.js, marked "review-server:". */
'use strict';
window.reviewVim = (function () {
  const Vim = CodeMirror.Vim, Pos = CodeMirror.Pos, cmp = CodeMirror.cmpPos;
  const firstNonBlank = text => Math.max(0, (text || '').search(/\S/));
  const clampLine = (cm, line) => Math.max(cm.firstLine(), Math.min(cm.lastLine(), line));
  const lineLen = (cm, line) => cm.getLine(line).length;
  const say = (cm, text) => { if (cm.openNotification) cm.openNotification(text, { bottom: true, duration: 4000 }); };
  const reg = () => Vim.getRegisterController();
  let hooks = { leave() {}, save() {} };

  // ------------------------------------------------------------ settings, for :set

  function option(name, aliases, type, value, apply) {
    Vim.defineOption(name, value, type, aliases, apply ? function (v, cm) {
      if (v === undefined) return value;
      value = type === 'number' ? Number(v) : v;
      if (cm) apply(cm, value);
    } : undefined);
  }
  option('ignorecase', ['ic'], 'boolean', false);
  option('smartcase', ['scs'], 'boolean', false);
  option('textwidth', ['tw'], 'number', 0);
  option('shiftwidth', ['sw'], 'number', 2, (cm, v) => cm.setOption('indentUnit', v));
  option('tabstop', ['ts'], 'number', 4, (cm, v) => cm.setOption('tabSize', v));
  option('expandtab', ['et'], 'boolean', true, (cm, v) => cm.setOption('indentWithTabs', !v));
  option('number', ['nu'], 'boolean', false, (cm, v) => cm.setOption('lineNumbers', v));
  option('wrap', [], 'boolean', true, (cm, v) => cm.setOption('lineWrapping', v));
  ['autoindent ai', 'smartindent si', 'spell', 'incsearch is', 'hlsearch hls', 'list', 'wrapscan ws', 'ruler ru', 'magic'].forEach(o => {
    const [n, a] = o.split(' ');
    option(n, a ? [a] : [], 'boolean', true);
  });

  // ------------------------------------------------------------ motions

  // j and k move by the lines on screen, as gj and gk do, since text here wraps. With an operator (dj, yk) they
  // still mean whole lines. An image under a line takes up room that gj alone would get stuck in.
  Vim.defineMotion('screenLine', function (cm, head, args, vim, inputState) {
    if (inputState.operator) return this.moveByLines(cm, head, args, vim, inputState);
    const keep = vim.lastMotion === this.screenLine;
    let cur = head;
    for (let i = 0; i < (args.repeat || 1); i++) {
      if (keep || i) vim.lastMotion = this.moveByDisplayLines;
      const next = this.moveByDisplayLines(cm, cur, { forward: args.forward, repeat: 1 }, vim);
      const stuck = cm.charCoords(next, 'div').top === cm.charCoords(cur, 'div').top;
      if (stuck && args.forward && cur.line < cm.lastLine()) {
        cur = cm.coordsChar({ left: vim.lastHSPos, top: cm.heightAtLine(cur.line + 1, 'div') + 2 }, 'div');
      } else if (stuck && !args.forward && cur.line > cm.firstLine()) {
        const above = cm.charCoords(new Pos(cur.line - 1, lineLen(cm, cur.line - 1)), 'div');
        cur = cm.coordsChar({ left: vim.lastHSPos, top: above.top + 2 }, 'div');
      } else {
        cur = next;
      }
      vim.lastHPos = cur.ch;
    }
    return cur;
  });
  Vim.mapCommand('j', 'motion', 'screenLine', { forward: true, linewise: true });
  Vim.mapCommand('k', 'motion', 'screenLine', { forward: false, linewise: true });

  // + - _ and Enter are linewise, which the keymap leaves out.
  Vim.mapCommand('+', 'motion', 'moveByLines', { forward: true, toFirstChar: true, linewise: true });
  Vim.mapCommand('-', 'motion', 'moveByLines', { forward: false, toFirstChar: true, linewise: true });
  Vim.mapCommand('_', 'motion', 'moveByLines', { forward: true, toFirstChar: true, linewise: true, repeatOffset: -1 });
  Vim.mapCommand('<CR>', 'motion', 'moveByLines', { forward: true, toFirstChar: true, linewise: true }, { context: 'normal' });
  Vim.mapCommand('<CR>', 'motion', 'moveByLines', { forward: true, toFirstChar: true, linewise: true }, { context: 'visual' });

  Vim.defineMotion('lastNonBlank', (cm, head, args) => {
    const line = clampLine(cm, head.line + (args.repeat || 1) - 1), text = cm.getLine(line);
    return new Pos(line, Math.max(0, text.replace(/\s+$/, '').length - 1));
  });
  Vim.mapCommand('g_', 'motion', 'lastNonBlank', { inclusive: true });
  Vim.defineMotion('middleOfText', (cm, head) => new Pos(head.line, Math.floor(lineLen(cm, head.line) / 2)));
  Vim.mapCommand('gM', 'motion', 'middleOfText', {});
  Vim.defineMotion('middleOfScreenLine', (cm, head) => {
    const box = cm.getWrapperElement().getBoundingClientRect();
    return cm.coordsChar({ left: box.left + box.width / 2, top: cm.charCoords(head, 'window').top + 1 }, 'window');
  });
  Vim.mapCommand('gm', 'motion', 'middleOfScreenLine', {});

  // Space and Backspace go on to the next or last line.
  Vim.defineMotion('spaceOrBack', (cm, head, args, vim, inputState) => {
    let { line, ch } = head;
    for (let i = 0; i < (args.repeat || 1); i++) {
      if (args.forward) {
        if (ch + 1 < lineLen(cm, line) || inputState.operator) ch = Math.min(ch + 1, lineLen(cm, line));
        else if (line < cm.lastLine()) { line++; ch = 0; }
      } else if (ch > 0) ch--;
      else if (line > cm.firstLine()) { line--; ch = Math.max(0, lineLen(cm, line) - 1); }
    }
    return new Pos(line, ch);
  });
  Vim.mapCommand('<Space>', 'motion', 'spaceOrBack', { forward: true });
  Vim.mapCommand('<BS>', 'motion', 'spaceOrBack', { forward: false }, { context: 'normal' });
  Vim.map('<C-h>', '<BS>', 'normal');
  Vim.map('<C-n>', 'j', 'normal');
  Vim.map('<C-p>', 'k', 'normal');
  Vim.map('<C-j>', 'j', 'normal');
  Vim.map('<C-m>', '+', 'normal');

  // ------------------------------------------------------------ the page scrolls, not a box in it

  const lineHeight = cm => cm.defaultTextHeight();
  const barBottom = () => {
    const bar = document.querySelector('#bar');
    return bar ? Math.max(0, bar.getBoundingClientRect().bottom) : 0;
  };
  function moveByPixels(cm, head, px, forward) {
    const at = cm.charCoords(head, 'local'), sign = forward ? 1 : -1;
    window.scrollBy(0, sign * px);
    return cm.coordsChar({ left: at.left, top: at.top + sign * px + lineHeight(cm) / 2 }, 'local');
  }
  Vim.defineMotion('moveByScroll', (cm, head, args) => {
    const px = args.repeatIsExplicit && args.repeat ? args.repeat * lineHeight(cm) : window.innerHeight / 2;
    return moveByPixels(cm, head, px, args.forward);
  });
  Vim.defineMotion('moveByPage', (cm, head, args) =>
    moveByPixels(cm, head, (args.repeat || 1) * (window.innerHeight - barBottom() - 2 * lineHeight(cm)), args.forward));
  const startOfLine = (cm, line) => new Pos(line, firstNonBlank(cm.getLine(line)));
  Vim.defineMotion('moveToTopLine', (cm, _head, args) =>
    startOfLine(cm, clampLine(cm, cm.lineAtHeight(barBottom() + 2, 'window') + (args.repeat || 1) - 1)));
  Vim.defineMotion('moveToMiddleLine', cm =>
    startOfLine(cm, clampLine(cm, cm.lineAtHeight((barBottom() + window.innerHeight) / 2, 'window'))));
  Vim.defineMotion('moveToBottomLine', (cm, _head, args) =>
    startOfLine(cm, clampLine(cm, cm.lineAtHeight(window.innerHeight - 2, 'window') - (args.repeat || 1) + 1)));
  Vim.defineAction('scrollToCursor', (cm, args) => {
    const y = cm.charCoords(new Pos(cm.getCursor().line, 0), 'page').top;
    const to = args.position === 'center' ? y - window.innerHeight / 2 :
      args.position === 'bottom' ? y - window.innerHeight + 2 * lineHeight(cm) : y - barBottom() - 8;
    window.scrollTo(0, Math.max(0, to));
  });
  Vim.defineAction('scroll', (cm, args, vim) => {
    if (vim.visualMode) return;
    const lh = lineHeight(cm);
    window.scrollBy(0, (args.forward ? 1 : -1) * (args.repeat || 1) * lh);
    const cur = cm.charCoords(cm.getCursor(), 'window');
    const top = barBottom() + lh, bottom = window.innerHeight - lh;
    if (cur.top < top) cm.setCursor(cm.coordsChar({ left: cur.left, top: top + 1 }, 'window'));
    else if (cur.bottom > bottom) cm.setCursor(cm.coordsChar({ left: cur.left, top: bottom - lh }, 'window'));
  });

  // ------------------------------------------------------------ operators

  const rot13 = s => s.replace(/[a-zA-Z]/g, c => {
    const base = c <= 'Z' ? 65 : 97;
    return String.fromCharCode((c.charCodeAt(0) - base + 13) % 26 + base);
  });
  Vim.defineOperator('rot13', (cm, args, ranges) => {
    cm.replaceSelections(cm.getSelections().map(rot13));
    const a = ranges[0].anchor, b = ranges[0].head;
    return cmp(a, b) < 0 ? a : b;
  });
  Vim._mapCommand({ keys: 'g?', type: 'operator', operator: 'rot13', isEdit: true });
  ['g??', 'g?g?'].forEach(keys => Vim._mapCommand({ keys, type: 'operatorMotion', operator: 'rot13', motion: 'expandToLine', motionArgs: { linewise: true }, isEdit: true }));

  // gq and gw: rewrap paragraphs to 'textwidth', or to 79 columns if that is 0, as Vim does.
  function wrapText(text, width) {
    const tail = /\n$/.test(text) ? '\n' : '';
    const out = [];
    let words = [], indent = '';
    const flush = () => {
      let line = '';
      for (const w of words) {
        if (line && indent.length + line.length + 1 + w.length > width) { out.push(indent + line); line = w; }
        else line = line ? line + ' ' + w : w;
      }
      if (line) out.push(indent + line);
      words = [];
    };
    for (const l of text.replace(/\n$/, '').split('\n')) {
      if (!l.trim()) { flush(); out.push(''); continue; }
      if (!words.length) indent = /^\s*/.exec(l)[0];
      words.push(...l.trim().split(/\s+/));
    }
    flush();
    return out.join('\n') + tail;
  }
  function reflow(cm, ranges, oldAnchor, stay) {
    const a = ranges[0].anchor, b = ranges[0].head, start = cmp(a, b) < 0 ? a : b, end = cmp(a, b) < 0 ? b : a;
    const before = cm.lineCount();
    cm.replaceSelection(wrapText(cm.getSelection(), Vim.getOption('textwidth') || 79));
    if (stay) return oldAnchor;
    const last = clampLine(cm, (end.ch === 0 ? end.line - 1 : end.line) + cm.lineCount() - before);
    return startOfLine(cm, Math.max(start.line, last));
  }
  Vim.defineOperator('reflow', (cm, args, ranges, oldAnchor) => reflow(cm, ranges, oldAnchor, false));
  Vim.defineOperator('reflowStay', (cm, args, ranges, oldAnchor) => reflow(cm, ranges, oldAnchor, true));
  [['gq', 'reflow'], ['gw', 'reflowStay']].forEach(([keys, operator]) => {
    Vim._mapCommand({ keys, type: 'operator', operator, operatorArgs: { linewise: true }, isEdit: true });
    [keys + keys.charAt(1), keys + keys].forEach(k => Vim._mapCommand({ keys: k, type: 'operatorMotion', operator, operatorArgs: { linewise: true }, motion: 'expandToLine', motionArgs: { linewise: true }, isEdit: true }));
  });

  // In visual mode S and R replace whole lines; the keymap's S left the text in place.
  Vim.mapCommand('S', 'operator', 'change', { linewise: true, fullLine: true }, { context: 'visual', exitVisualBlock: true });
  Vim._mapCommand({ keys: 'gp', type: 'action', action: 'paste', isEdit: true, actionArgs: { after: true, isEdit: true, cursorAfter: true } });
  Vim._mapCommand({ keys: 'gP', type: 'action', action: 'paste', isEdit: true, actionArgs: { after: false, isEdit: true, cursorAfter: true } });
  Vim.map('&', ':s', 'normal');
  Vim.map('g&', ':%s', 'normal');
  Vim.map('ZZ', ':wq', 'normal');
  Vim.map('ZQ', ':q', 'normal');

  // ------------------------------------------------------------ undo

  // cw, o, s and the like make two steps in the editor's history, the change and the typing; Vim undoes both as one.
  // And the cursor goes to where the change was.
  function stepHistory(cm, step, repeat) {
    let first = null;
    const note = (_c, ch) => {
      if (first && cmp(ch.from, first) >= 0) return;
      // Undoing an added line starts at the end of the line above; the cursor belongs at that line's start.
      first = ch.from.ch && ch.from.ch >= lineLen(cm, ch.from.line) && (ch.to.line > ch.from.line || ch.text.length > 1) ? new Pos(ch.from.line, 0) : ch.from;
    };
    const pairs = cm.state.undoPairs || new Set();
    cm.on('beforeChange', note);
    cm.operation(() => {
      for (let i = 0; i < (repeat || 1); i++) {
        step();
        for (const gen of pairs) { if (cm.isClean(gen)) { step(); break; } }
      }
    });
    cm.off('beforeChange', note);
    if (first) cm.setCursor(clampLine(cm, first.line), Math.min(first.ch, Math.max(0, lineLen(cm, clampLine(cm, first.line)) - 1)));
  }
  Vim.defineAction('undo', (cm, args) => stepHistory(cm, () => cm.undo(), args.repeat));
  Vim.defineAction('redo', (cm, args) => stepHistory(cm, () => cm.redo(), args.repeat));

  // U: undo all the latest changes on one line.
  Vim.defineAction('lineUndo', cm => {
    const saved = cm.state.lineUndo;
    if (!saved || saved.line > cm.lastLine()) return;
    const now = cm.getLine(saved.line);
    cm.replaceRange(saved.text, new Pos(saved.line, 0), new Pos(saved.line, now.length), 'lineUndo');
    saved.text = now;
    cm.setCursor(saved.line, 0);
  });
  Vim.mapCommand('U', 'action', 'lineUndo', {}, { context: 'normal' });

  // ------------------------------------------------------------ keys in insert mode

  let waiting = null;     // what the next key is for: {kind, cm, ...}
  const inInsert = (keys, fn) => {
    const name = 'insertKey' + keys.replace(/\W/g, '');
    Vim.defineAction(name, fn);
    Vim.mapCommand(keys, 'action', name, {}, { context: 'insert' });
  };
  inInsert('<C-r>', cm => { waiting = { kind: 'register', cm }; });
  inInsert('<C-v>', cm => { waiting = { kind: 'literal', cm, hex: null }; });
  inInsert('<C-q>', cm => { waiting = { kind: 'literal', cm, hex: null }; });
  inInsert('<C-k>', cm => { waiting = { kind: 'digraph', cm, first: null }; });
  const fromLine = (cm, offset) => {
    const u = cm.getCursor(), line = u.line + offset;
    const text = line >= cm.firstLine() && line <= cm.lastLine() ? cm.getLine(line) : '';
    if (text.charAt(u.ch)) cm.replaceRange(text.charAt(u.ch), u);
  };
  inInsert('<C-e>', cm => fromLine(cm, 1));
  inInsert('<C-y>', cm => fromLine(cm, -1));
  // Stop at where this insert began, the first time, as Vim's backspace=start does.
  inInsert('<C-u>', cm => {
    const u = cm.getCursor(), s = cm.state.insertStart, blank = firstNonBlank(cm.getLine(u.line));
    const to = s && s.line === u.line && s.ch < u.ch ? s.ch : blank < u.ch ? blank : 0;
    cm.replaceRange('', new Pos(u.line, to), u);
    if (s) cm.state.insertStart = new Pos(u.line, to);
  });
  // One normal command, then back to inserting.
  inInsert('<C-o>', cm => {
    const u = cm.getCursor(), atEnd = u.ch >= lineLen(cm, u.line) && u.ch > 0;
    Vim.exitInsertMode(cm);
    let key = '';
    const note = e => { if (e.key.length === 1) key = e.key; };
    const back = () => {
      if (cm.state.vim.exMode || cm.state.vim.visualMode) return;
      CodeMirror.off(cm, 'vim-command-done', back);
      document.removeEventListener('keydown', note, true);
      if (cm.state.vim.insertMode) return;
      const c = cm.getCursor(), len = lineLen(cm, c.line);
      Vim.handleKey(cm, (atEnd || key === '$') && c.ch >= len - 1 && len ? 'a' : 'i', 'mapping');
    };
    document.addEventListener('keydown', note, true);
    CodeMirror.on(cm, 'vim-command-done', back);
  });
  // These Ctrl keys are shortcuts on a Mac (Ctrl-K deletes to the end of the line), so they would change the text.
  ['<C-a>', '<C-b>', '<C-f>', '<C-g>', '<C-l>', '<C-n>', '<C-p>', '<C-s>', '<C-x>', '<C-z>'].forEach(k => inInsert(k, () => {}));
  ['<C-j>', '<C-m>'].forEach(k => inInsert(k, cm => CodeMirror.commands.newlineAndIndent(cm)));
  inInsert('<C-i>', cm => cm.replaceSelection('\t'));
  // As Ctrl-U: not past where this insert began, the first time.
  inInsert('<C-w>', cm => {
    const u = cm.getCursor(), s = cm.state.insertStart;
    const before = cm.getLine(u.line).slice(0, u.ch), run = /(\w+|[^\w\s]+)\s*$|\s+$/.exec(before);
    let to = run ? run.index : 0;
    if (!u.ch && u.line > cm.firstLine()) { cm.replaceRange('', new Pos(u.line - 1, lineLen(cm, u.line - 1)), u); return; }
    if (s && s.line === u.line && s.ch < u.ch && to < s.ch) to = s.ch;
    cm.replaceRange('', new Pos(u.line, to), u);
    if (s && s.line === u.line && to < s.ch) cm.state.insertStart = new Pos(u.line, to);
  });
  Vim.defineAction('noCommand', () => {});
  Vim._mapCommand({ keys: '<C-w><character>', type: 'action', action: 'noCommand', context: 'normal' });   // windows: there is only one
  ['<C-g>', '<C-k>', '<C-l>', '<C-q>', '<C-s>', '<C-t>', '<C-z>', '<C-\\>', '<C-_>'].forEach(k => {
    Vim.mapCommand(k, 'action', 'noCommand', {}, { context: 'normal' });
    Vim.mapCommand(k, 'action', 'noCommand', {}, { context: 'visual' });
  });

  const MARKS = { ':': '̈', "'": '́', '!': '̀', '`': '̀', '>': '̂', '^': '̂', '?': '̃', '~': '̃', ',': '̧' };
  // Backspace in replace mode (R) puts back what was replaced.
  let current = null;
  document.addEventListener('keydown', e => {
    const cm = current;
    if (e.key !== 'Backspace' || waiting || !cm || !cm.state.vim || !cm.state.vim.insertMode || !cm.state.overwrite) return;
    const done = (cm.state.replacedChars || []).pop();
    e.preventDefault(); e.stopPropagation();
    if (done) {
      cm.replaceRange(done.was, done.at, new Pos(done.at.line, done.at.ch + 1), 'replaceBack');
      cm.setCursor(done.at);
    } else {
      const u = cm.getCursor();
      if (u.ch > 0) cm.setCursor(u.line, u.ch - 1);
    }
  }, true);
  document.addEventListener('keydown', e => {
    if (!waiting || ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
    const w = waiting, k = e.key;
    e.preventDefault(); e.stopPropagation();
    if (k === 'Escape') { waiting = null; return; }
    if (w.kind === 'register') {
      waiting = null;
      const r = k.length === 1 ? reg().getRegister(k) : null;
      if (r) w.cm.replaceSelection(r.toString());
    } else if (w.kind === 'literal') {
      if (w.hex !== null) {
        const isHex = /^[0-9a-fA-F]$/.test(k);
        if (isHex) w.hex += k;
        if (w.hex.length === 4 || !isHex) {
          waiting = null;
          if (w.hex) w.cm.replaceSelection(String.fromCharCode(parseInt(w.hex, 16)));
        }
      } else if (k === 'u') w.hex = '';
      else { waiting = null; w.cm.replaceSelection(k === 'Tab' ? '\t' : k.length === 1 ? k : ''); }
    } else if (w.kind === 'digraph') {
      if (w.first === null) w.first = k;
      else {
        waiting = null;
        const mark = MARKS[k];
        w.cm.replaceSelection(mark ? (w.first + mark).normalize('NFC') : w.first + k);
      }
    }
  }, true);

  // ------------------------------------------------------------ the system clipboard, for "+ and "*

  function clipboardRegister() {
    let text = '';
    return {
      keyBuffer: [''], insertModeChanges: [], searchQueries: [], linewise: false, blockwise: false,
      setText(t, line) {
        text = t || ''; this.linewise = !!line;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text + (line && !/\n$/.test(text) ? '\n' : '')).catch(() => {});
        }
      },
      pushText(t, line) { this.setText(text + (t || ''), line); },
      pushInsertModeChanges() {},
      pushSearchQuery() {},
      clear() { text = ''; this.linewise = false; },
      toString() { return text; },
    };
  }
  ['+', '*'].forEach(name => { try { Vim.defineRegister(name, clipboardRegister()); } catch (e) { /* already there */ } });

  // ------------------------------------------------------------ : commands

  const rangeOf = (cm, p) => {
    const from = p.line === undefined ? cm.getCursor().line : p.line, to = p.lineEnd === undefined ? from : p.lineEnd;
    return [clampLine(cm, Math.min(from, to)), clampLine(cm, Math.max(from, to))];
  };
  const textOf = (cm, from, to) => cm.getRange(new Pos(from, 0), new Pos(to, lineLen(cm, to)));
  function removeLines(cm, from, to) {
    if (to < cm.lastLine()) cm.replaceRange('', new Pos(from, 0), new Pos(to + 1, 0));
    else if (from > cm.firstLine()) cm.replaceRange('', new Pos(from - 1, lineLen(cm, from - 1)), new Pos(to, lineLen(cm, to)));
    else cm.replaceRange('', new Pos(from, 0), new Pos(to, lineLen(cm, to)));
  }
  // ":d x 3": an optional register and an optional count.
  function regAndCount(p) {
    const m = /^\s*([a-zA-Z"\-+*_])?\s*(\d+)?\s*$/.exec(p.argString || '') || [];
    return { name: m[1], count: m[2] ? Number(m[2]) : 0 };
  }
  const withCount = (cm, p, range, count) => {
    if (!count) return range;
    const start = p.lineEnd !== undefined ? range[1] : range[0];
    return [start, clampLine(cm, start + count - 1)];
  };
  const landOn = (cm, line) => { line = clampLine(cm, line); cm.setCursor(line, firstNonBlank(cm.getLine(line))); };
  Vim.defineEx('delete', 'd', (cm, p) => {
    const { name, count } = regAndCount(p), [from, to] = withCount(cm, p, rangeOf(cm, p), count);
    reg().pushText(name, 'delete', textOf(cm, from, to), true);
    removeLines(cm, from, to);
    landOn(cm, from);
  });
  Vim.defineEx('yank', 'y', (cm, p) => {
    const { name, count } = regAndCount(p), [from, to] = withCount(cm, p, rangeOf(cm, p), count);
    reg().pushText(name, 'yank', textOf(cm, from, to), true);
  });
  // The target line of :m and :t, written as 3, ., $, or 'a: the 1-based line to put text after; 0 is the top.
  function targetLine(cm, arg) {
    const m = /^\s*(\.|\$|'[a-z]|\d+)?\s*([+-]\d*)?\s*$/.exec(arg || '');
    if (!m) return null;
    const a = m[1];
    let line;
    if (a === undefined || a === '.') line = cm.getCursor().line + 1;
    else if (a === '$') line = cm.lineCount();
    else if (a[0] === "'") {
      const mark = cm.state.vim.marks[a[1]], f = mark && mark.find();
      if (!f) return null;
      line = f.line + 1;
    } else line = Number(a);
    if (m[2]) line += m[2].length > 1 ? Number(m[2]) : (m[2] === '+' ? 1 : -1);
    return line;
  }
  function insertAfter(cm, after, text) {
    if (after <= 0) cm.replaceRange(text + '\n', new Pos(cm.firstLine(), 0));
    else {
      const line = Math.min(after - 1, cm.lastLine());
      cm.replaceRange('\n' + text, new Pos(line, lineLen(cm, line)));
    }
  }
  // Not named "move": the keymap uses that name for a bare :12.
  Vim.defineEx('moveLines', 'm', (cm, p) => {
    const [from, to] = rangeOf(cm, p), after = targetLine(cm, p.argString);
    if (after === null || (after > from && after <= to)) { say(cm, 'Lines cannot move into themselves'); return; }
    const text = textOf(cm, from, to), n = to - from + 1;
    cm.operation(() => {
      if (after > to) {
        insertAfter(cm, after, text);
        removeLines(cm, from, to);
        landOn(cm, after - 1);
      } else {
        removeLines(cm, from, to);
        insertAfter(cm, after, text);
        landOn(cm, after + n - 1);
      }
    });
  });
  const copyLines = (cm, p) => {
    const [from, to] = rangeOf(cm, p), after = targetLine(cm, p.argString);
    if (after === null) { say(cm, 'Invalid address'); return; }
    insertAfter(cm, after, textOf(cm, from, to));
    landOn(cm, after + to - from);
  };
  Vim.defineEx('copy', 'co', copyLines);
  Vim.defineEx('t', 't', copyLines);
  Vim.defineEx('join', 'j', (cm, p) => {
    const [from, end] = rangeOf(cm, p), to = from === end ? clampLine(cm, from + 1) : end;
    for (let i = from; i < to; i++) { cm.setCursor(from, 0); Vim.handleKey(cm, 'J', 'mapping'); }
    landOn(cm, from);
  });
  const shifter = how => (cm, p) => {
    const [from, to] = rangeOf(cm, p), times = 1 + ((p.argString || '').match(how === 'add' ? />/g : /</g) || []).length;
    cm.operation(() => {
      for (let l = from; l <= to; l++) {
        for (let t = 0; t < times; t++) if (cm.getLine(l).trim()) cm.indentLine(l, how);
      }
    });
    landOn(cm, to);
  };
  Vim.defineEx('>', '>', shifter('add'));
  Vim.defineEx('<', '<', shifter('subtract'));
  Vim.defineEx('&', '&', cm => Vim.handleEx(cm, 's'));
  Vim.defineEx('normal', 'norm', (cm, p) => {
    const keys = (p.argString || '').replace(/^!/, '').replace(/^\s/, '');
    const hasRange = p.line !== undefined;
    const [from, to] = rangeOf(cm, p);
    cm.operation(() => {
      let end = to;
      for (let l = from; l <= end && l <= cm.lastLine(); l++) {
        const count = cm.lineCount();
        if (hasRange) cm.setCursor(l, 0);
        for (const k of keys) {
          if (cm.state.vim.insertMode) cm.replaceSelection(k);
          else Vim.handleKey(cm, k === ' ' ? '<Space>' : k, 'mapping');
        }
        if (cm.state.vim.insertMode) Vim.exitInsertMode(cm);
        const change = cm.lineCount() - count;
        end += change;
        if (change < 0) l += change;
      }
    });
  });
  Vim.defineEx('put', 'pu', (cm, p) => {
    const m = /^\s*(!)?\s*(\S)?/.exec(p.argString || ''), r = reg().getRegister(m[2]);
    const text = r.toString().replace(/\n$/, '');
    if (!text) return;
    const at = p.line === undefined ? cm.getCursor().line : p.line, above = !!m[1];
    insertAfter(cm, at + (above ? 0 : 1), text);
    landOn(cm, at + (above ? 0 : 1) + text.split('\n').length - 1);
  });
  const setMark = (cm, p) => { Vim.handleKey(cm, 'm', 'mapping'); Vim.handleKey(cm, (p.argString || '').trim().charAt(0) || 'a', 'mapping'); };
  Vim.defineEx('mark', 'ma', setMark);
  Vim.defineEx('k', 'k', setMark);
  Vim.defineEx('edit', 'e', cm => say(cm, 'This page edits one file, and every change is already saved. u undoes; Revert goes back to the file as queued.'));
  Vim.defineEx('help', 'h', cm => say(cm, 'There is no help here; this is the vim keymap of CodeMirror.'));

  return {
    // Once, when the editor's code has loaded: what :w and :q do on this page.
    install(h) {
      hooks = h;
      CodeMirror.commands.save = () => hooks.save();
      ['quit q', 'wq wq', 'xit x', 'qall qa', 'wqall wqa', 'xall xa'].forEach(o => {
        const [name, short] = o.split(' ');
        Vim.defineEx(name, short, () => hooks.leave());
      });
    },
    // For each editor.
    attach(cm) {
      current = cm;
      cm.state.undoPairs = new Set();
      cm.state.commandGen = cm.changeGeneration();
      cm.on('vim-command-done', () => { if (!cm.state.vim.insertMode) cm.state.commandGen = cm.changeGeneration(); });
      cm.on('beforeChange', (_c, ch) => {
        if (ch.origin === 'setValue') cm.state.lineUndo = null;
        // Where this insert began: its first typed character, since A and the like move the cursor after saying so.
        if (cm.state.vim && cm.state.vim.insertMode && ch.origin === '+input' && !cm.state.insertBegan) {
          cm.state.insertBegan = true;
          cm.state.insertStart = ch.from;
        }
        if (cm.state.overwrite && cm.state.vim && cm.state.vim.insertMode && ch.origin === '+input' && ch.text.join('').length === 1 && ch.text[0]) {
          const text = cm.getLine(ch.from.line);
          (cm.state.replacedChars = cm.state.replacedChars || []).push({ at: ch.from, was: text.charAt(ch.from.ch) });
        }
        if (ch.origin !== 'lineUndo' && ch.origin !== 'undo' && ch.origin !== 'redo' && ch.from.line === ch.to.line && ch.text.length === 1) {
          if (!cm.state.lineUndo || cm.state.lineUndo.line !== ch.from.line) cm.state.lineUndo = { line: ch.from.line, text: cm.getLine(ch.from.line) };
        }
      });
      // A tap or click moves the cursor, so the next j or k takes its column from there.
      cm.on('cursorActivity', () => {
        const vim = cm.state.vim;
        if (vim && !(cm.curOp && cm.curOp.isVimOp)) vim.lastMotion = null;
      });
      cm.on('vim-mode-change', e => {
        if (e.mode === 'insert') {
          cm.state.insertStart = cm.getCursor();
          cm.state.insertBegan = false;
          cm.state.insertTyped = false;
          cm.state.replacedChars = [];
          if (!cm.isClean(cm.state.commandGen)) cm.state.undoPairs.add(cm.changeGeneration(true));
          return;
        }
        if (e.mode !== 'normal') return;
        // Leaving insert mode without typing removes the indent that o or Enter added, as Vim does.
        const u = cm.getCursor(), text = cm.getLine(u.line);
        if (text && !text.trim() && cm.state.insertTyped === false) {
          cm.replaceRange('', new Pos(u.line, 0), new Pos(u.line, text.length));
        }
        cm.state.commandGen = cm.changeGeneration();
      });
      cm.on('change', (_c, ch) => {
        if (cm.state.vim && cm.state.vim.insertMode && ch.origin === '+input' && ch.text.join('').trim()) cm.state.insertTyped = true;
      });
    },
  };
})();
