import puppeteer from 'puppeteer-core';
import fs from 'fs';
const D = JSON.parse(fs.readFileSync('cases.json')), vimRes = JSON.parse(fs.readFileSync('vim.json'));
const BASE = 'http://127.0.0.1:' + process.argv[2], OUT = process.argv[3] || 'cm.json';
const only = process.argv[4] ? JSON.parse(fs.readFileSync(process.argv[4])) : null;
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const prof = fs.mkdtempSync(process.cwd() + '/profile-');
const b = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: prof, args: ['--no-first-run'] });
const p = await b.newPage(); await p.setViewport({ width: 1600, height: 1600 });
const pageErrors = []; let cur = ''; p.on('pageerror', e => pageErrors.push([cur, e.message]));
const it = (await (await fetch(BASE + '/api/items')).json()).items.find(s => s.file === 'Plain.txt');
await p.goto(BASE + '/#/item/' + it.id);
await p.waitForFunction(() => window.__review && window.__review.T.cm);
await p.evaluate(() => { try { localStorage.setItem('review.vim', '1'); } catch (e) {} });
await p.reload(); await p.waitForFunction(() => window.__review.T.cm);
await p.evaluate(() => { window.__review.T.conflict = {}; window.alert = window.confirm = window.prompt = () => {}; });
const text = D.text.replace(/\n$/, '');
const NAMED = { Esc: 'Escape', CR: 'Enter', BS: 'Backspace', Tab: 'Tab', Space: 'Space', Left: 'ArrowLeft', Right: 'ArrowRight', Up: 'ArrowUp', Down: 'ArrowDown' };
async function send(s) {
  const re = /<(C-(.)|[A-Za-z]+)>/g; let i = 0;
  const lit = async t => { for (const ch of t) { await p.keyboard.type(ch); if (ch === ':' || ch === '/' || ch === '?') await new Promise(r => setTimeout(r, 12)); } };
  for (let m; (m = re.exec(s)); ) {
    await lit(s.slice(i, m.index)); i = m.index + m[0].length;
    if (m[2]) { await p.keyboard.down('Control'); await p.keyboard.press(m[2]); await p.keyboard.up('Control'); }
    else if (m[1] === 'lt') await p.keyboard.type('<');
    else if (NAMED[m[1]]) { await p.keyboard.press(NAMED[m[1]]); if (m[1] === 'CR') await new Promise(r => setTimeout(r, 6)); }
    else await lit(m[0]);
  }
  await lit(s.slice(i));
}
const reset = () => p.evaluate(t => {
  const c = window.__review.T.cm;
  for (const [k, v] of [['ignorecase', false], ['smartcase', false], ['textwidth', 0], ['shiftwidth', 2], ['tabstop', 4], ['number', false], ['wrap', true]]) CodeMirror.Vim.setOption(k, v, c);
  CodeMirror.Vim.resetVimGlobalState_ && CodeMirror.Vim.resetVimGlobalState_();
  c.setOption('keyMap', 'default'); c.setValue(t); c.clearHistory(); c.setOption('keyMap', 'vim');
  c.setCursor(0, 0); c.focus();
}, text);
const res = {}; const list = only || D.cases.map(x => x[1]);
const idx = new Map(D.cases.map((x, i) => [x[1], i]));
let n = 0;
for (const c of list) {
  if (c.startsWith('ZZ')) continue;
  try {
    cur = c; await reset();
    await send(c);
    await p.keyboard.press('Escape'); await p.keyboard.press('Escape');
    res[c] = await p.evaluate(() => { const m = window.__review.T.cm, u = m.getCursor(); return { text: m.getValue('\n'), pos: (u.line + 1) + ',' + (u.ch + 1), dialog: !!document.querySelector('.CodeMirror-dialog') }; });
  } catch (e) { res[c] = { error: e.message }; }
  if (await p.evaluate(() => !location.hash.includes('/item/') || !window.__review.T.cm)) {
    res[c] = Object.assign(res[c] || {}, { left: true });
    await p.goto(BASE + '/#/item/' + it.id); await p.reload(); await p.waitForFunction(() => window.__review.T.cm);
    await p.evaluate(() => { window.__review.T.conflict = {}; });
  }
  if (++n % 500 === 0) { console.log(n, 'of', list.length); fs.writeFileSync(OUT, JSON.stringify(res)); }
}
fs.writeFileSync(OUT, JSON.stringify({ res, pageErrors }));
await b.close(); fs.rmSync(prof, { recursive: true, force: true });
console.log('done', n, 'pageErrors', pageErrors.length);
