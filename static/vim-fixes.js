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

  // j and k move by the lines on screen, since text here wraps. With an operator (dj, yk) they still mean whole lines.
  // This goes one screen row at a time from measured positions: the keymap's gj treats a row shorter than the column
  // as if it were not there, and an image under a line takes up room it can get stuck in.
  const rowTop = (cm, pos) => cm.charCoords(pos, 'div').top;
  function oneRow(cm, cur, goal, forward) {
    const top = rowTop(cm, cur);
    let line = cur.line, y;
    if (Math.abs(top - rowTop(cm, new Pos(line, forward ? lineLen(cm, line) : 0))) < 2) {
      if (forward ? line >= cm.lastLine() : line <= cm.firstLine()) return cur;
      line += forward ? 1 : -1;
      y = rowTop(cm, new Pos(line, forward ? 0 : lineLen(cm, line))) + 2;
    } else {
      y = forward ? cm.charCoords(cur, 'div').bottom + 2 : top - 2;
    }
    const to = cm.coordsChar({ left: goal, top: y }, 'div');
    // A goal past the end of the row gives the start of the next row: stay on this one, on its last character.
    let ch = to.ch;
    while (ch > 0 && rowTop(cm, new Pos(to.line, ch)) > y) ch--;
    return new Pos(to.line, ch);
  }
  Vim.defineMotion('screenLine', function (cm, head, args, vim, inputState) {
    if (inputState.operator && args.linewise) return this.moveByLines(cm, head, args, vim, inputState);
    // Keep the column between j and k, and after $ stay at the ends of the rows.
    if (vim.lastMotion === this.moveToEol) vim.screenEnd = true;
    else if (vim.lastMotion !== this.screenLine) vim.screenEnd = false;
    if (vim.lastMotion !== this.screenLine || vim.lastMotion === null) vim.screenGoal = cm.charCoords(head, 'div').left;
    const goal = vim.screenEnd ? 1e6 : vim.screenGoal;
    let cur = head;
    for (let i = 0; i < (args.repeat || 1); i++) cur = oneRow(cm, cur, goal, args.forward);
    if (cur === head) return null;       // nowhere to go, which ends a macro
    vim.lastHPos = vim.screenEnd ? Infinity : cur.ch;
    vim.lastHSPos = goal;
    return cur;
  });
  Vim.mapCommand('gj', 'motion', 'screenLine', { forward: true });
  Vim.mapCommand('gk', 'motion', 'screenLine', { forward: false });
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
  // The part of the window the cursor should stay in: below the toolbar, even while the toolbar is slid away.
  const visibleTop = cm => {
    const bar = document.querySelector('#bar');
    return (bar ? bar.offsetHeight : 0) + lineHeight(cm);
  };
  const visibleBottom = cm => window.innerHeight - 2 * lineHeight(cm);
  function keepCursorInView(cm) {
    const r = cm.cursorCoords(null, 'window'), top = visibleTop(cm), bottom = visibleBottom(cm);
    // On the first row, show the top of the page, with any note above the text.
    if (Math.abs(rowTop(cm, cm.getCursor()) - rowTop(cm, new Pos(cm.firstLine(), 0))) < 2) window.scrollTo(0, 0);
    else if (r.top < top) window.scrollBy(0, r.top - top);
    else if (r.bottom > bottom) window.scrollBy(0, r.bottom - bottom);
  }
  function moveByPixels(cm, head, px, forward) {
    const at = cm.charCoords(head, 'local'), lh = lineHeight(cm), sign = forward ? 1 : -1;
    const y = at.top + sign * px + lh / 2;
    let to = cm.coordsChar({ left: at.left, top: y }, 'local');
    // Landing inside an image gives the line above it: go on to the text past the image.
    if (forward && cm.charCoords(to, 'local').bottom < y - lh && to.line < cm.lastLine()) {
      to = new Pos(to.line + 1, 0);
    } else if (!forward && to.line === head.line && Math.abs(cm.charCoords(to, 'local').top - at.top) < 2 && head.line > cm.firstLine()) {
      to = new Pos(head.line - 1, lineLen(cm, head.line - 1));
    }
    window.scrollBy(0, cm.charCoords(to, 'local').top - at.top);
    return to;
  }
  Vim.defineMotion('moveByScroll', (cm, head, args) => {
    const px = args.repeatIsExplicit && args.repeat ? args.repeat * lineHeight(cm) : window.innerHeight / 2;
    return moveByPixels(cm, head, px, args.forward);
  });
  Vim.defineMotion('moveByPage', (cm, head, args) =>
    moveByPixels(cm, head, (args.repeat || 1) * (window.innerHeight - barBottom() - 2 * lineHeight(cm)), args.forward));
  const startOfLine = (cm, line) => new Pos(line, firstNonBlank(cm.getLine(line)));
  // H, M, and L: the screen rows in view, at the first non-blank if that row starts its line. The view stays put.
  const rowAt = (cm, y) => {
    const box = cm.getWrapperElement().getBoundingClientRect(), to = cm.coordsChar({ left: box.left, top: y }, 'window');
    return to.ch === 0 ? startOfLine(cm, to.line) : to;
  };
  Vim.defineMotion('moveToTopLine', (cm, _head, args) => rowAt(cm, visibleTop(cm) + (args.repeat || 1) * lineHeight(cm)));
  Vim.defineMotion('moveToMiddleLine', cm => rowAt(cm, (visibleTop(cm) + visibleBottom(cm)) / 2));
  Vim.defineMotion('moveToBottomLine', (cm, _head, args) => rowAt(cm, visibleBottom(cm) - (args.repeat || 1) * lineHeight(cm) - 1));
  Vim.defineAction('scrollToCursor', (cm, args) => {
    const y = cm.cursorCoords(null, 'page').top;
    const to = args.position === 'center' ? y - window.innerHeight / 2 :
      args.position === 'bottom' ? y - visibleBottom(cm) + lineHeight(cm) : y - visibleTop(cm);
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
  // Comments and quotes keep their leader on each line, and list items their indent. None of them merge with the text
  // around them, so a LaTeX comment cannot swallow live text. Spacing inside a line stays as it was.
  function wrapText(text, width) {
    const tail = /\n$/.test(text) ? '\n' : '';
    const out = [];
    let para = null;
    const flush = () => {
      if (!para) return;
      const tokens = para.text.match(/\S+\s*/g) || [];
      let line = para.first;
      let empty = true;
      for (const t of tokens) {
        if (!empty && (line + t).trimEnd().length > width) { out.push(line.trimEnd()); line = para.next; empty = true; }
        line += t;
        empty = false;
      }
      out.push(line.trimEnd());
      para = null;
    };
    for (const l of text.replace(/\n$/, '').split('\n')) {
      if (!l.trim()) { flush(); out.push(l); continue; }
      const m = /^(\s*)(%+\s*|>+\s*|[-*+]\s+|\d+[.)]\s+)?/.exec(l), lead = m[0], mark = m[2] || '', body = l.slice(lead.length);
      const repeats = /^[%>]/.test(mark);
      if (mark && !repeats) {        // a new list item
        flush();
        para = { first: lead, next: ' '.repeat(lead.length), leader: null, text: body };
      } else if (para && para.leader === (repeats ? lead : null) && (repeats || !mark)) {
        para.text = para.text.trimEnd() + ' ' + body;
      } else {
        flush();
        para = { first: lead, next: lead, leader: repeats ? lead : null, text: body };
      }
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
  Vim.mapCommand('X', 'operator', 'delete', { linewise: true, notInBlock: true }, { context: 'visual' });
  Vim._mapCommand({ keys: 'gp', type: 'action', action: 'paste', isEdit: true, actionArgs: { after: true, isEdit: true, cursorAfter: true } });
  Vim._mapCommand({ keys: 'gP', type: 'action', action: 'paste', isEdit: true, actionArgs: { after: false, isEdit: true, cursorAfter: true } });
  Vim.map('&', ':s', 'normal');
  Vim.map('g&', ':%s', 'normal');
  Vim.map('ZZ', ':wq', 'normal');
  Vim.map('ZQ', ':q', 'normal');

  // ------------------------------------------------------------ undo

  // cw, o, s and the like make two steps in the editor's history, the change and the typing; Vim undoes both as one.
  // And the cursor goes to where the change was.
  function stepHistory(cm, step, repeat, map) {
    let first = null;
    const note = (_c, ch) => {
      if (first && cmp(ch.from, first) >= 0) return;
      // Undoing an added line starts at the end of the line above; the cursor belongs at that line's start.
      first = ch.from.ch && ch.from.ch >= lineLen(cm, ch.from.line) && (ch.to.line > ch.from.line || ch.text.length > 1) ? new Pos(ch.from.line, 0) : ch.from;
    };
    const pairs = cm.state.undoPairs || new Set(), spans = cm.state[map] || new Map();
    const gen = () => cm.changeGeneration();
    // Go to the other end of an insert, if we are at one end of it, stepping over pauses and Backspaces.
    const acrossInsert = () => {
      if (!spans.has(gen())) return false;
      const target = spans.get(gen());
      for (let n = 0; n < 20000 && gen() !== target; n++) {
        const before = gen();
        step();
        if (gen() === before) break;
      }
      return true;
    };
    cm.on('beforeChange', note);
    cm.operation(() => {
      for (let i = 0; i < (repeat || 1); i++) {
        if (map === 'undoSpans') {
          if (!acrossInsert()) step();
          if (pairs.has(gen())) step();
        } else {
          if (pairs.has(gen())) { acrossInsert() || step(); continue; }
          if (!acrossInsert()) step();
          if (pairs.has(gen())) acrossInsert() || step();
        }
      }
    });
    cm.off('beforeChange', note);
    if (first) cm.setCursor(clampLine(cm, first.line), Math.min(first.ch, Math.max(0, lineLen(cm, clampLine(cm, first.line)) - 1)));
  }
  Vim.defineAction('undo', (cm, args) => stepHistory(cm, () => cm.undo(), args.repeat, 'undoSpans'));
  Vim.defineAction('redo', (cm, args) => stepHistory(cm, () => cm.redo(), args.repeat, 'redoSpans'));

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
    if (!atEnd) cm.setCursor(u);        // leaving insert mode steps left, but Ctrl-O does not
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
    const box = e.target && e.target.closest && e.target.closest('.CodeMirror-dialog') ? e.target : null;
    // Ctrl-R in the : and / prompts: the next key names a register, or Ctrl-W means the word under the cursor.
    if (box && !waiting && e.ctrlKey && e.key === 'r') {
      e.preventDefault(); e.stopPropagation();
      waiting = { kind: 'prompt', input: box };
      return;
    }
    if (!waiting || ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
    const w = waiting, k = e.key;
    e.preventDefault(); e.stopPropagation();
    if (k === 'Escape') { waiting = null; return; }
    if (w.kind === 'prompt') {
      waiting = null;
      let text = '';
      if (e.ctrlKey && k === 'w' && current) {
        const word = current.findWordAt(current.getCursor());
        text = current.getRange(word.anchor, word.head);
      } else if (k.length === 1 && reg().getRegister(k)) {
        text = reg().getRegister(k).toString().replace(/\n$/, '');
      }
      const i = w.input, from = i.selectionStart;
      i.value = i.value.slice(0, from) + text + i.value.slice(i.selectionEnd);
      i.selectionStart = i.selectionEnd = from + text.length;
      return;
    }
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

  // ------------------------------------------------------------ holding a key

  // Holding a movement key. Browsers are unreliable here: on a Mac, Chrome can send one repeat and then none. So the
  // page does all the repeating itself, ignores the browser's repeats, and stops only when the key is let go. Only
  // keys that move: if a key release were ever lost, these would just stop at the end of the file, where a repeating
  // x would keep deleting.
  const HOLD_KEYS = 'hjklwbeWBE{}';
  const HOLD_WAIT = 280, HOLD_EVERY = 30;
  let holdTimer = null, holdKey = null;
  function stopHold() { clearTimeout(holdTimer); clearInterval(holdTimer); holdTimer = null; holdKey = null; }
  document.addEventListener('keydown', e => {
    if (e.repeat && e.key === holdKey) { e.preventDefault(); e.stopPropagation(); return; }
    stopHold();
    if (!current || current.getOption('keyMap') !== 'vim' || e.ctrlKey || e.metaKey || e.altKey || !HOLD_KEYS.includes(e.key)) return;
    if (!current.getWrapperElement().contains(e.target) || e.target.closest('.CodeMirror-dialog')) return;
    const cm = current, vim = cm.state.vim;    // this runs before the editor sees the key
    if (!vim || vim.insertMode || vim.inputState.operator || vim.inputState.keyBuffer.length) return;
    const key = e.key;
    holdKey = key;
    holdTimer = setTimeout(() => {
      holdTimer = setInterval(() => {
        if (current !== cm || vim.insertMode) { stopHold(); return; }
        Vim.handleKey(cm, key, 'user');
      }, HOLD_EVERY);
    }, HOLD_WAIT);
  }, true);
  document.addEventListener('keyup', e => { if (e.key === holdKey || e.key === 'Shift') stopHold(); }, true);
  document.addEventListener('pointerdown', stopHold, true);
  window.addEventListener('blur', stopHold);
  document.addEventListener('visibilitychange', stopHold);

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

  // Lines that do not exist are an error, as in Vim, not the nearest line.
  const ex = (name, short, fn) => Vim.defineEx(name, short, (cm, p) => {
    const bad = l => l !== undefined && (l < cm.firstLine() || l > cm.lastLine());
    if (bad(p.line) || bad(p.lineEnd)) { say(cm, 'Invalid range'); return; }
    fn(cm, p);
  });
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
  ex('delete', 'd', (cm, p) => {
    const { name, count } = regAndCount(p), [from, to] = withCount(cm, p, rangeOf(cm, p), count);
    reg().pushText(name, 'delete', textOf(cm, from, to) + '\n', true);
    removeLines(cm, from, to);
    landOn(cm, from);
  });
  ex('yank', 'y', (cm, p) => {
    const { name, count } = regAndCount(p), [from, to] = withCount(cm, p, rangeOf(cm, p), count);
    reg().pushText(name, 'yank', textOf(cm, from, to) + '\n', true);
  });
  // The target line of :m and :t, written as 3, ., $, or 'a: the 1-based line to put text after; 0 is the top.
  function targetLine(cm, arg) {
    const m = /^\s*(\.|\$|'[a-z<>]|\d+)?\s*([+-]\d*)?\s*$/.exec(arg || '');
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
    return line < 0 || line > cm.lineCount() ? null : line;
  }
  function insertAfter(cm, after, text) {
    if (after <= 0) cm.replaceRange(text + '\n', new Pos(cm.firstLine(), 0));
    else {
      const line = Math.min(after - 1, cm.lastLine());
      cm.replaceRange('\n' + text, new Pos(line, lineLen(cm, line)));
    }
  }
  // Not named "move": the keymap uses that name for a bare :12.
  ex('moveLines', 'm', (cm, p) => {
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
  ex('copy', 'co', copyLines);
  ex('t', 't', copyLines);
  ex('join', 'j', (cm, p) => {
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
  ex('>', '>', shifter('add'));
  ex('<', '<', shifter('subtract'));
  Vim.defineEx('&', '&', cm => Vim.handleEx(cm, 's'));
  ex('normal', 'norm', (cm, p) => {
    const keys = (p.argString || '').replace(/^!/, '').replace(/^\s/, '');
    if (/[:/?]/.test(keys)) { say(cm, ':normal cannot use :, /, or ? here'); return; }
    const state = Vim.getVimGlobalState_().macroModeState;
    const runKeys = () => {
      state.failed = false;
      for (const k of keys) {
        if (state.failed) break;           // as in Vim, a failed move ends this line's commands
        if (cm.state.vim.insertMode) cm.replaceSelection(k);
        else Vim.handleKey(cm, k === ' ' ? '<Space>' : k, 'mapping');
      }
      if (cm.state.vim.insertMode) Vim.exitInsertMode(cm);
      state.failed = false;
    };
    cm.operation(() => {
      if (p.line === undefined) { runKeys(); return; }
      // As in Vim, by line number and as many times as the range had lines, however the commands add or remove lines.
      const [from, to] = rangeOf(cm, p);
      for (let l = from; l <= to; l++) {
        cm.setCursor(Math.min(l, cm.lastLine()), 0);
        runKeys();
      }
    });
  });
  ex('put', 'pu', (cm, p) => {
    const m = /^\s*(!)?\s*(\S)?/.exec(p.argString || ''), r = reg().getRegister(m[2]);
    const text = r.toString().replace(/\n$/, '');
    if (!text) return;
    const at = p.line === undefined ? cm.getCursor().line : p.line, above = !!m[1];
    insertAfter(cm, at + (above ? 0 : 1), text);
    landOn(cm, at + (above ? 0 : 1) + text.split('\n').length - 1);
  });
  const setMark = (cm, p) => {
    const was = cm.getCursor();
    if (p.line !== undefined) cm.setCursor(clampLine(cm, p.line), 0);
    Vim.handleKey(cm, 'm', 'mapping');
    Vim.handleKey(cm, (p.argString || '').trim().charAt(0) || 'a', 'mapping');
    cm.setCursor(was);
  };
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
    detach() { stopHold(); current = null; },
    keepCursorInView,
    // For each editor.
    attach(cm) {
      current = cm;
      cm.state.undoPairs = new Set();
      cm.state.undoSpans = new Map();
      cm.state.redoSpans = new Map();
      cm.state.commandGen = cm.changeGeneration();
      cm.on('vim-command-done', () => { if (!cm.state.vim.insertMode) cm.state.commandGen = cm.changeGeneration(); });
      cm.on('beforeChange', (_c, ch) => {
        // Read-only stops keys, but not : commands, which change the text directly.
        if (cm.getOption('readOnly') && ch.origin !== 'setValue' && ch.cancel) { ch.cancel(); return; }
        if (ch.origin === 'setValue') cm.state.lineUndo = null;
        // Deleting whole lines deletes their marks, as in Vim.
        const vimState = cm.state.vim;
        if (vimState && vimState.marks && ch.to.line > ch.from.line && !ch.text.join('')) {
          for (const k of Object.keys(vimState.marks)) {
            if (k === '<' || k === '>' || k === '[' || k === ']' || k === '^') continue;
            const at = vimState.marks[k].find && vimState.marks[k].find();
            if (!at) continue;
            // dd takes a line and the break after it; on the last line, the break before it instead.
            const fromEnd = ch.from.ch && ch.from.ch >= lineLen(cm, ch.from.line);
            const gone = fromEnd ? at.line > ch.from.line && at.line <= ch.to.line
              : ch.from.ch === 0 && at.line >= ch.from.line && at.line < ch.to.line;
            if (gone) { vimState.marks[k].clear(); delete vimState.marks[k]; }
          }
        }
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
        keepCursorInView(cm);
      });
      // This page does its own scrolling to the cursor; the editor's stops short at the toolbar.
      cm.on('scrollCursorIntoView', (_c, e) => e.preventDefault());
      window.addEventListener('resize', () => {
        if (current !== cm) return;
        if (cm.state.vim) cm.state.vim.lastMotion = null;
        keepCursorInView(cm);
      });
      // An arrow key or a click while inserting starts a new undo step, as in Vim.
      const breakInsert = () => {
        if (cm.state.insertGen === undefined) return;
        const end = cm.changeGeneration(true), start = cm.state.insertGen;
        if (end !== start) { cm.state.undoSpans.set(end, start); cm.state.redoSpans.set(start, end); }
        cm.state.insertGen = end;
      };
      cm.on('keydown', (_c, e) => {
        if (/^(Arrow|Home$|End$|Page)/.test(e.key)) breakInsert();
      });
      cm.on('mousedown', breakInsert);
      cm.on('vim-mode-change', e => {
        if (e.mode === 'insert' || e.mode === 'replace') {
          if (cm.state.insertGen !== undefined) return;
          const u = cm.getCursor();
          cm.state.insertStart = u;
          cm.state.insertBegan = false;
          cm.state.insertTyped = false;
          cm.state.replacedChars = [];
          // An o, cc, or Enter leaves only an indent on its line, to be removed if nothing is typed.
          cm.state.openedLine = !cm.isClean(cm.state.commandGen) && !cm.getLine(u.line).trim() ? u.line : -1;
          if (!cm.isClean(cm.state.commandGen)) cm.state.undoPairs.add(cm.changeGeneration(true));
          cm.state.insertGen = cm.changeGeneration(true);
          return;
        }
        if (e.mode !== 'normal' || cm.state.insertGen === undefined) return;
        const u = cm.getCursor(), text = cm.getLine(u.line);
        if (text && !text.trim() && cm.state.insertTyped === false && cm.state.openedLine === u.line) {
          cm.replaceRange('', new Pos(u.line, 0), new Pos(u.line, text.length));
        }
        // All of this insert is one step for u and Ctrl-R, across pauses and Backspaces.
        const end = cm.changeGeneration(true), start = cm.state.insertGen;
        if (end !== start) { cm.state.undoSpans.set(end, start); cm.state.redoSpans.set(start, end); }
        cm.state.insertGen = undefined;
        cm.state.commandGen = cm.changeGeneration();
      });
      cm.on('change', (_c, ch) => {
        if (cm.state.vim && cm.state.vim.insertMode && ch.origin === '+input') {
          // Enter while inserting opens a line of its own. Its automatic indent is not typing, but a typed space is.
          if (ch.text.length > 1) {
            cm.state.openedLine = ch.from.line + ch.text.length - 1;
            cm.state.insertTyped = false;
          } else if (ch.text[0].trim() || ch.text[0].length === 1) {
            cm.state.insertTyped = true;
          }
        }
      });
    },
  };
})();
