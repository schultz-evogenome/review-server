// Browser regression checks for figure boxes. Node 22+ and Chrome; no npm dependencies.
// Run from anywhere: node tools/test-regions.mjs (CHROME and PYTHON may override the executables).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await mkdtemp(join(tmpdir(), 'review-regions-'));
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { const result = await fn(); if (result) return result; await delay(80); }
  throw new Error('Timed out: ' + label);
}
const fixture = String.raw`
import http.server, json, struct, sys, zlib
from pathlib import Path
import review
root = Path(sys.argv[1]) / 'queue'
root.mkdir()
class Quiet:
    ok = False
    def add(self, path): pass
# A real PDF with text above a drawing, and no text inside the drawing.
content = b'BT /F1 18 Tf 40 740 Td (Figure review test) Tj ET\n0.8 0.9 1 rg 60 240 480 360 re f\n0.1 0.3 0.7 RG 4 w 90 270 m 180 420 l 300 360 l 490 540 l S\n'
objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
 b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
 b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
 b'<< /Length %d >>\nstream\n' % len(content) + content + b'endstream']
pdf = b'%PDF-1.4\n'
offsets = [0]
for i, obj in enumerate(objects, 1):
    offsets.append(len(pdf))
    pdf += b'%d 0 obj\n' % i + obj + b'\nendobj\n'
xref = len(pdf)
pdf += b'xref\n0 6\n0000000000 65535 f \n' + b''.join(b'%010d 00000 n \n' % x for x in offsets[1:])
pdf += b'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n' % xref
def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
pixels = b''.join(b'\x00' + b''.join(bytes((40 + x // 4, 70 + y // 3, 170)) for x in range(600)) for y in range(360))
png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>2I5B', 600, 360, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b'')
p = review.make_item(root, 'Figure_v1.pdf', pdf, {'title': 'Figure PDF'})
t = review.make_item(root, 'Notes_v1.md', b'# Figure notes\n\nText to keep.\n\n![A plot](plot.png)\n\n![PDF plot](plot.pdf)\n', {'title': 'Figure Markdown'})
review.add_image(t, 'plot.png', 'plot.png', png)
review.add_image(t, 'plot.pdf', 'plot.pdf', pdf)
store = review.Store([root], None, Quiet(), auto_close=False, state=Path(sys.argv[1]) / 'state.json')
handler = review.make_handler(store, '')
handler.log_message = lambda *args: None
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
print(json.dumps({'base': 'http://127.0.0.1:%d' % server.server_address[1], 'pdf': review.item_id(p), 'text': review.item_id(t)}), flush=True)
server.serve_forever()
`;
let chrome, server, ws, diagnostics;
try {
  server = spawn(process.env.PYTHON || 'python3', ['-u', '-c', fixture, tmp], { cwd: repo, stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  server.stdout.on('data', b => { output += b; });
  const config = await until(() => output.includes('\n') && JSON.parse(output.split('\n')[0]), 'fixture server');
  chrome = spawn(process.env.CHROME || '/usr/bin/google-chrome', ['--headless', '--no-sandbox', '--disable-gpu',
    '--remote-debugging-port=0', '--user-data-dir=' + join(tmp, 'chrome'), '--no-first-run', '--no-default-browser-check',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeLog = '';
  chrome.stderr.on('data', b => { chromeLog = (chromeLog + b).slice(-4000); });
  const port = await until(async () => {
    if (chrome.exitCode !== null) throw new Error('Chrome exited: ' + chromeLog);
    const listening = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(chromeLog);
    if (listening) return listening[1];
    try { return (await readFile(join(tmp, 'chrome', 'DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch { return false; }
  }, 'Chrome').catch(e => { throw new Error(e.message + '\n' + chromeLog); });
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((ok, fail) => { ws.addEventListener('open', ok, { once: true }); ws.addEventListener('error', fail, { once: true }); });
  let next = 0;
  const pending = new Map(), errors = [];
  ws.addEventListener('message', e => {
    const msg = JSON.parse(e.data);
    if (msg.id) {
      const request = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) request.reject(new Error(JSON.stringify(msg.error))); else request.resolve(msg.result);
    } else if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text + ': ' + JSON.stringify(msg.params.exceptionDetails.exception));
  });
  function cdp(method, params = {}) {
    return new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  }
  async function js(expression) {
    const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  diagnostics = async () => {
    if (process.env.REVIEW_SCREENSHOT) {
      const picture = await cdp('Page.captureScreenshot', { format: 'png' });
      await writeFile(process.env.REVIEW_SCREENSHOT, Buffer.from(picture.data, 'base64'));
    }
    return { page: await js(`({hash:location.hash,title:document.title,status:document.querySelector('#status')?.textContent,done:document.querySelector('#doneBtn')?.textContent,boxes:document.querySelectorAll('.region-box').length,events:window.figureEvents})`), errors };
  };
  const click = sel => js(`document.querySelector(${JSON.stringify(sel)}).click()`);
  const detail = async id => (await fetch(config.base + '/api/items/' + id)).json();
  const count = async (id, n) => until(async () => { const d = await detail(id); return d.highlights.highlights.length === n && d; }, n + ' saved marks');
  async function rect(sel) {
    await js(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({block:'center'})`);
    await delay(250); // let the editor/preview scroll synchronization settle
    return js(`(() => {const r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height};})()`);
  }
  async function checkFigureSize(sel) {
    const sizes = await js(`(() => {const e=document.querySelector(${JSON.stringify(sel)}), a=e.getBoundingClientRect(), b=e.querySelector('img,canvas').getBoundingClientRect();return {surface:[a.x,a.y,a.width,a.height],image:[b.x,b.y,b.width,b.height]};})()`);
    assert.ok(sizes.image[2] > 0 && sizes.image[3] > 0, 'figure is visible');
    sizes.surface.forEach((v, i) => assert.ok(Math.abs(v - sizes.image[i]) < 1, 'box surface matches displayed figure: ' + JSON.stringify(sizes)));
  }
  async function drag(sel, a = [.2, .25], b = [.55, .55], pointerType = 'mouse') {
    const r = await rect(sel), point = p => ({ x: r.x + r.w * p[0], y: r.y + r.h * p[1] });
    const start = point(a), end = point(b);
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...start, button: 'left', buttons: 1, clickCount: 1, pointerType });
    for (let i = 1; i <= 8; i++) await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x + (end.x - start.x) * i / 8, y: start.y + (end.y - start.y) * i / 8, buttons: 1, pointerType });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...end, button: 'left', buttons: 0, clickCount: 1, pointerType });
  }
  async function tap(sel, point = [.35, .35]) {
    const r = await rect(sel), x = r.x + r.w * point[0], y = r.y + r.h * point[1];
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }
  await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1100, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: config.base + '/#/item/' + config.pdf });
  await until(() => js(`!!document.querySelector('.textLayer span')`), 'PDF render');
  await click('#tools [data-box]');
  await drag('.page', [.2, .3], [.6, .55], 'pen');
  let data = await count(config.pdf, 1), mark = data.highlights.highlights[0];
  assert.equal(mark.text, '');
  assert.equal(mark.region.page, 1);
  assert.ok(mark.region.snapshot);
  assert.ok(Math.abs(mark.region.w - .4) < .003);
  assert.equal((await fetch(config.base + '/api/items/' + config.pdf + '/regions/' + mark.region.snapshot)).headers.get('content-type'), 'image/png');
  await click('#lastNote');
  await js(`document.querySelector('#sheetNote').value='Make this panel larger'; document.querySelector('#sheetNote').dispatchEvent(new Event('input'))`);
  await click('#recBtn');
  await until(() => js(`document.querySelector('#recBtn').classList.contains('recording')`), 'recording starts');
  await delay(800);
  await click('#recBtn');
  await until(async () => (await detail(config.pdf)).highlights.highlights[0].audio.length === 1, 'recording saved on figure');
  await click('#sheetClose');
  await until(async () => (await detail(config.pdf)).highlights.highlights[0].note === 'Make this panel larger', 'figure note');
  await cdp('Page.reload');
  await until(() => js(`!!document.querySelector('.page .region-box')`), 'box survives reload');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 800, height: 900, deviceScaleFactor: 2, mobile: false });
  await until(() => js(`document.querySelector('.page')?.clientWidth < 800 && !!document.querySelector('.region-box')`), 'resized PDF');
  const scaled = await js(`(() => {const p=document.querySelector('.page').getBoundingClientRect(), b=document.querySelector('.region-box').getBoundingClientRect();return {x:(b.x-p.x)/p.width,w:b.width/p.width};})()`);
  assert.ok(Math.abs(scaled.x - .2) < .003 && Math.abs(scaled.w - .4) < .003);
  await tap('.page', [.3, .4]);
  await until(() => js(`!document.querySelector('#sheet').hidden`), 'tap opens figure note');
  await click('#sheetDelete');
  await count(config.pdf, 0);
  await click('#lastUndo');
  await count(config.pdf, 1);
  await click('#doneBtn');
  await until(async () => (await detail(config.pdf)).item.status === 'done', 'done');
  await until(() => js(`!document.querySelector('#queue').hidden && location.hash === '#/'`), 'return to queue');
  await js(`location.hash='#/item/${config.pdf}'`);
  await until(() => js(`document.querySelector('#doneBtn').textContent === 'Reopen' && !!document.querySelector('.page .region-box')`), 'reopen view');
  await click('#tools [data-box]');
  await drag('.page', [.65, .25], [.85, .4]);
  assert.equal((await detail(config.pdf)).highlights.highlights.length, 1, 'finished review is read-only');
  await click('#doneBtn');
  await until(() => js(`document.querySelector('#doneBtn').textContent === 'Done'`), 'reopened for editing');
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const touchPage = await rect('.page'), tx = touchPage.x + touchPage.w * .8, ty = Math.min(750, touchPage.y + touchPage.h * .6);
  const beforeScroll = await js('window.scrollY');
  await cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tx, y: ty }] });
  for (let i = 1; i <= 5; i++) {
    await cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: tx, y: ty - i * 30 }] });
    await delay(40);
  }
  await cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await delay(250);
  assert.ok(await js('window.scrollY') > beforeScroll + 20, 'a finger scrolls while Box is selected');
  assert.equal((await detail(config.pdf)).highlights.highlights.length, 1, 'finger scrolling adds no mark');
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: false });
  await click('[data-tool="select"]');
  await js(`(() => {const r=document.createRange();r.selectNodeContents(document.querySelector('.textLayer span'));const s=getSelection();s.removeAllRanges();s.addRange(r);})()`);
  await until(() => js(`!document.querySelector('#selbar').hidden`), 'PDF text selection');
  await click('#selbar [data-mark="change"]');
  data = await count(config.pdf, 2);
  assert.ok(data.highlights.highlights[1].text.includes('Figure review test') && !data.highlights.highlights[1].region);

  await cdp('Emulation.setDeviceMetricsOverride', { width: 1200, height: 1000, deviceScaleFactor: 1, mobile: false });
  await js(`location.hash='#/item/${config.text}'`);
  await until(() => js(`!!document.querySelector('#editor .cm-figure img')?.naturalWidth`), 'Markdown image');
  const image = '#editor .cm-figure[data-ref="plot.png"] .figure-surface';
  await checkFigureSize(image);
  await click('[data-ttool="discuss"]');
  await drag(image, [.65, .65], [.25, .25], 'pen'); // reverse direction, without selecting adjacent words
  data = await count(config.text, 1);
  mark = data.highlights.highlights[0];
  assert.equal(mark.region.image, 'plot.png');
  assert.equal(mark.tag, 'discuss');
  assert.ok(!mark.anchor);
  await click('#lastNote');
  await js(`document.querySelector('#sheetNote').value='Change the blue part'; document.querySelector('#sheetNote').dispatchEvent(new Event('input'))`);
  await click('#sheetClose');
  await click('[data-ttool="edit"]');
  await js(String.raw`document.querySelector('.CodeMirror').CodeMirror.replaceRange('Introductory paragraph\n\n',{line:0,ch:0})`);
  await until(() => js(`!!document.querySelector('#editor .region-box')`), 'mark follows image after text edits');
  await click('#previewBtn');
  await until(() => js(`!!document.querySelector('#preview .region-box') && document.querySelector('#preview .cm-figure img').naturalWidth > 0`), 'mark in rendered preview');
  await checkFigureSize('#preview .cm-figure[data-ref="plot.png"] .figure-surface');
  await click('[data-ttool="change"]');
  await drag('#preview .cm-figure[data-ref="plot.png"] .figure-surface', [.65, .2], [.9, .4]);
  await count(config.text, 2);
  // A cancelled stroke must not create a partial box.
  await js(`(() => {const e=document.querySelector('#preview .figure-surface img'), r=e.getBoundingClientRect();
    for(const type of ['pointerdown','pointermove','pointercancel']) e.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:91,pointerType:'pen',clientX:r.x+r.width*.5,clientY:r.y+r.height*.5,button:0}));})()`);
  assert.equal(await js(`document.querySelectorAll('.region-box.trial').length`), 0);
  await click('#previewBtn');
  await until(() => js(`document.querySelector('#editor .cm-figure[data-ref="plot.pdf"] canvas')?.height > 0`), 'embedded PDF figure');
  await checkFigureSize('#editor .cm-figure[data-ref="plot.pdf"] .figure-surface');
  await drag('#editor .cm-figure[data-ref="plot.pdf"] .figure-surface', [.2, .3], [.5, .55]);
  data = await count(config.text, 3);
  assert.equal(data.highlights.highlights[2].region.image, 'plot.pdf');
  await cdp('Page.reload');
  await until(() => js(`document.querySelectorAll('#editor .region-box').length === 3`), 'all image marks survive reload');
  data = await detail(config.text);
  assert.equal(data.highlights.highlights[0].note, 'Change the blue part');
  assert.ok(data.highlights.highlights.every(h => h.region.snapshot && !h.anchor));
  await click('[data-ttool="edit"]');
  await js(`document.querySelector('.CodeMirror').CodeMirror.setSelection({line:0,ch:0},{line:0,ch:12})`);
  await until(() => js(`!document.querySelector('#selbar').hidden`), 'editor text selection');
  await click('#selbar [data-mark="discuss"]');
  data = await count(config.text, 4);
  assert.ok(data.highlights.highlights[3].anchor && !data.highlights.highlights[3].region);
  assert.deepEqual(errors, []);
  if (process.env.REVIEW_SCREENSHOT) {
    await click('#textListBtn');
    await js(`document.querySelector('#list .li[data-n="1"]').click()`);
    await delay(400);
    const picture = await cdp('Page.captureScreenshot', { format: 'png' });
    await writeFile(process.env.REVIEW_SCREENSHOT, Buffer.from(picture.data, 'base64'));
  }
  console.log('PASS: PDF and image boxes, Pencil/mouse, finger scrolling, notes/audio, reload/resize, reverse drag, undo, read-only, text highlighting/edits, preview, embedded PDF, cancellation.');
} catch (e) {
  if (diagnostics) console.error(await diagnostics());
  throw e;
} finally {
  if (ws) ws.close();
  const stop = async p => {
    if (!p || p.exitCode !== null) return;
    p.kill('SIGTERM');
    await Promise.race([new Promise(r => p.once('exit', r)), delay(2000)]);
    if (p.exitCode === null) p.kill('SIGKILL');
  };
  await stop(chrome); await stop(server);
  await rm(tmp, { recursive: true, force: true, maxRetries: 3 });
}
