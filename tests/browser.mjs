// Dependency-free Chromium UI checks via the Chrome DevTools Protocol (Node 22+).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm, writeFile, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, extname } from 'node:path';
import { once } from 'node:events';

const root = resolve(import.meta.dirname, '..');
let profile;
let screenshots;
let server;
let origin;
let alternateOrigin;
let chrome;
let cdp;
let updateVersion = false;
let serverOffline = false;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

class CDP {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.sequence = 0;
    this.pending = new Map();
    this.errors = [];
    this.downloads = [];
    this.loads = new Map();
    this.socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.method?.startsWith('Browser.download')) this.downloads.push(message);
      if (message.method === 'Page.loadEventFired') this.loads.set(message.sessionId, (this.loads.get(message.sessionId) || 0) + 1);
      if (message.method === 'Runtime.exceptionThrown') this.errors.push(message.params.exceptionDetails);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
  }
  async ready() { if (this.socket.readyState !== 1) await once(this.socket, 'open'); }
  send(method, params = {}, sessionId) {
    const id = ++this.sequence;
    return new Promise((resolveCommand, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
      this.pending.set(id, { resolve: resolveCommand, reject, timeout });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
}
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
async function until(fn, label) {
  for (let i = 0; i < 70; i++) { if (await fn()) return; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}
const injection = unsupported => `
  (() => {
    const NativeDate = Date;
    const priorClock = JSON.parse(sessionStorage.getItem('reading-test-clock') || 'null');
    const epoch = priorClock?.epoch ?? Date.now();
    let elapsed = priorClock?.elapsed ?? 0; let clockShift = priorClock?.clockShift ?? 0;
    window.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [epoch + elapsed + clockShift])); }
      static now() { return epoch + elapsed + clockShift; }
    };
    Object.defineProperty(performance, 'now', { value: () => elapsed });
    const saveClock = () => sessionStorage.setItem('reading-test-clock', JSON.stringify({epoch,elapsed,clockShift}));
    window.testClock = { advance: ms => { elapsed += ms; saveClock(); }, shift: ms => { clockShift += ms; saveClock(); } };
    window.cueCalls = [];
    window.audioCalls = { contexts: 0, tones: 0, resumes: 0, cancellations: 0 };
    const NativeAudio = window.AudioContext;
    if (NativeAudio) window.AudioContext = class extends NativeAudio {
      constructor(...args) { super(...args); audioCalls.contexts++; }
      createOscillator() {
        audioCalls.tones++; const oscillator = super.createOscillator(); const originalStop = oscillator.stop;
        oscillator.stop = function(when) { if (when === undefined) audioCalls.cancellations++; return originalStop.call(this,when); };
        return oscillator;
      }
      resume() { audioCalls.resumes++; return super.resume(); }
    };
    Object.defineProperty(navigator, 'vibrate', { value: ${unsupported ? 'undefined' : "pattern => { if (pattern !== 0) cueCalls.push(pattern); return true; }"} });
    let visible = true;
    Object.defineProperty(document, 'visibilityState', { get: () => visible ? 'visible' : 'hidden' });
    window.testVisible = value => { visible = value; document.dispatchEvent(new Event('visibilitychange')); };
  })();`;
async function page(contextId, unsupported = false, url = origin) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId: contextId });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = async (method, params) => {
    const previousLoads = cdp.loads.get(sessionId) || 0;
    const result = await cdp.send(method, params, sessionId);
    if (method === 'Page.reload') await until(() => (cdp.loads.get(sessionId) || 0) > previousLoads, 'page reload completes');
    return result;
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: injection(unsupported) });
  const evaluate = async expression => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (exceptionDetails) throw new Error(exceptionDetails.text + ' ' + JSON.stringify(exceptionDetails.exception));
    return result.value;
  };
  const click = async selector => {
    const box = await evaluate(`(async () => {
      const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find(node => node.getClientRects().length);
      if (!e) throw Error('Missing visible control');
      e.scrollIntoView({block:'center',behavior:'instant'});
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const r = e.getBoundingClientRect(); const x = r.x+r.width/2; const y = r.y+r.height/2;
      const hit = document.elementFromPoint(x,y);
      if (hit !== e && !e.contains(hit)) throw Error('Control covered: '+hit?.outerHTML.slice(0,160));
      return {x,y};
    })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...box });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...box });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...box });
  };
  const has = selector => evaluate(`!!document.querySelector(${JSON.stringify(selector)})`);
  const wait = selector => until(() => evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].some(e => e.getClientRects().length)`), selector);
  const text = () => evaluate('document.body.innerText');
  const set = (selector, value) => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  const press = async key => {
    const windowsVirtualKeyCode = { Tab: 9, Enter: 13, Escape: 27 }[key];
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode, ...(key === 'Enter' ? { text: '\r' } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode });
  };
  const data = () => evaluate(`JSON.parse(localStorage.getItem('reading-endurance-v1'))`);
  const advance = async ms => { await evaluate(`testClock.advance(${ms})`); await delay(320); };
  const navigate = async () => { await send('Page.navigate', { url }); await wait('#main h1'); };
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await navigate();
  return { targetId, sessionId, send, evaluate, click, has, wait, text, set, press, data, advance, navigate };
}
const context = async () => (await cdp.send('Target.createBrowserContext')).browserContextId;
const close = p => cdp.send('Target.closeTarget', { targetId: p.targetId });
async function tabTo(p, selector) {
  for (let i = 0; i < 30; i++) {
    if (await p.evaluate(`document.activeElement.matches(${JSON.stringify(selector)})`)) return;
    await p.press('Tab');
  }
  throw new Error(`Control not reachable by Tab: ${selector}`);
}
const test = async (name, fn) => { await fn(); console.log(`PASS ${name}`); };
let p;
try {
  profile = await mkdtemp(join(tmpdir(), 'reading-endurance-browser-'));
  screenshots = process.env.SCREENSHOT_DIR || join(profile, 'screenshots');
  await mkdir(screenshots, { recursive: true });
  server = createServer(async (request, response) => {
    if (serverOffline) { request.socket.destroy(); return; }
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      const file = resolve(root, `.${path.endsWith('/') ? path + 'index.html' : path}`);
      if (!file.startsWith(root + '/')) throw new Error('outside root');
      let contents = await readFile(file);
      if (path === '/sw.js' && updateVersion) contents = Buffer.from(contents.toString().replace('}v10`', '}v11`'));
      if (path === '/style.css' && updateVersion) contents = Buffer.from(`${contents}\n:root { --reading-test-shell: upgraded; }\n`);
      response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      response.end(contents);
    } catch { response.writeHead(404); response.end('Not found'); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  alternateOrigin = origin.replace('127.0.0.1', 'reading-endurance.test');
  chrome = spawn(process.env.CHROME_BIN || 'google-chrome', [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
    '--host-resolver-rules=MAP reading-endurance.test 127.0.0.1', '--no-proxy-server',
    `--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  const endpoint = await new Promise((resolveEndpoint, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Chrome did not start: ${stderr}`)), 15000);
    chrome.stderr.on('data', chunk => {
      stderr += chunk;
      const found = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (found) { clearTimeout(timeout); resolveEndpoint(found[1]); }
    });
    chrome.once('error', error => { clearTimeout(timeout); reject(error); });
    chrome.once('exit', code => { clearTimeout(timeout); reject(new Error(`Chrome exited ${code}: ${stderr}`)); });
  });
  cdp = new CDP(endpoint);
  await cdp.ready();
  console.log(`Browser: ${(await cdp.send('Browser.getVersion')).product}`);
  for (const [name, executable, message] of [
    ['missing Chrome executable', join(profile, 'missing-chrome'), /ENOENT/],
    ['Chrome exits before DevTools startup', process.execPath, /Chrome exited/]
  ]) {
    await test(`startup cleanup: ${name}`, async () => {
      const temporaryRoot = await mkdtemp(join(profile, 'startup-failure-'));
      const child = spawn(process.execPath, [import.meta.filename], {
        env: { ...process.env, TMPDIR: temporaryRoot, TMP: temporaryRoot, TEMP: temporaryRoot, CHROME_BIN: executable },
        stdio: ['ignore', 'ignore', 'pipe'], timeout: 20000
      });
      let errorOutput = '';
      child.stderr.on('data', chunk => { errorOutput += chunk; });
      const [code, signal] = await once(child, 'close');
      assert.equal(signal, null, 'Failed startup must exit without timing out');
      assert.notEqual(code, 0, 'The child must encounter the intended startup failure');
      assert.match(errorOutput, message);
      assert.deepEqual(await readdir(temporaryRoot), [], 'Failed startup must remove its temporary browser profile');
    });
  }
  const contextId = await context();
  p = await page(contextId);
  await test('setup and preview from a gesture do not start a read', async () => {
    await p.wait('#setup-form');
    await p.click('[data-action=preview]');
    assert.equal(await p.evaluate('cueCalls.length'), 1);
    assert.equal((await p.data())?.active ?? null, null);
    await p.click('#setup-form [type=submit]');
    await p.wait('#start-form');
    assert.equal((await p.data()).settings.initialTarget, 10);
  });
  await test('portrait layout and keyboard focus', async () => {
    assert.equal(await p.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    const shot = await p.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(screenshots, 'read-portrait.png'), Buffer.from(shot.data, 'base64'));
    await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    assert.notEqual(await p.evaluate('document.activeElement.tagName'), 'BODY');
    const accessibility = await p.send('Accessibility.getFullAXTree');
    const buttons = accessibility.nodes.filter(n => n.role?.value === 'button' && !n.ignored);
    assert.ok(buttons.length >= 4);
    assert.ok(buttons.every(n => n.name?.value), 'Every visible button has an accessible name');
    await p.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    assert.equal(await p.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    const desktop = await p.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await writeFile(join(screenshots, 'read-desktop.png'), Buffer.from(desktop.data, 'base64'));
    await p.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, deviceScaleFactor: 1, mobile: true });
    assert.equal(await p.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    await p.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  });
  await test('navigation labels remain clickable at 320px with 200% text', async () => {
    await p.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, deviceScaleFactor: 1, mobile: true });
    await p.send('Page.setFontSizes', { fontSizes: { standard: 32 } });
    try {
      assert.equal(await p.evaluate('getComputedStyle(document.body).fontSize'), '32px');
      for (const view of ['progress', 'settings', 'read']) {
        const point = await p.evaluate(`(() => {
          const button = document.querySelector('[data-view=${view}]');
          button.scrollIntoView({block:'center',behavior:'instant'});
          const text = button.firstChild;
          const range = document.createRange();
          range.setStart(text, text.length - 1); range.setEnd(text, text.length);
          const rect = range.getBoundingClientRect();
          return {x:rect.x + rect.width / 2, y:rect.y + rect.height / 2};
        })()`);
        await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
        await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
        assert.equal(await p.evaluate('document.querySelector("nav [aria-current]").dataset.view'), view,
          `Clicking the ${view} label must select its own view`);
      }
      const shot = await p.send('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(screenshots, 'navigation-large-text.png'), Buffer.from(shot.data, 'base64'));
    } finally {
      await p.send('Page.setFontSizes', { fontSizes: { standard: 16 } });
      await p.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    }
  });
  await test('enlarged text reflows setup, reading controls, feedback and progress', async () => {
    const large = await page(await context());
    await large.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, deviceScaleFactor: 1, mobile: true });
    const fits = async () => {
      const overflow = await large.evaluate(`(() => {
        const width = document.documentElement.clientWidth;
        const failures = [];
        if (document.documentElement.scrollWidth > width + 1) failures.push('page');
        for (const e of document.querySelectorAll('.brand span, #main h1, #main h2, #timer, .metric strong, .metric span, #main button')) {
          if (!e.getClientRects().length) continue;
          const range = document.createRange(); range.selectNodeContents(e);
          const r = range.getBoundingClientRect();
          const bounds = e.closest('.metric')?.getBoundingClientRect();
          if (r.left < -1 || r.right > width + 1 || (bounds && (r.left < bounds.left || r.right > bounds.right))) failures.push(e.textContent.trim());
        }
        if (document.querySelector('.skip').getBoundingClientRect().bottom > 0) failures.push('unfocused skip link');
        return failures;
      })()`);
      assert.deepEqual(overflow, [], 'Text and controls must fit the viewport and their metric cards');
    };
    try {
      for (const font of [24, 32]) {
        await large.send('Page.setFontSizes', { fontSizes: { standard: font } });
        await fits();
      }
      await large.evaluate('document.querySelector(".skip").focus()');
      assert.equal(await large.evaluate('document.querySelector(".skip").getBoundingClientRect().top >= 0'), true);
      await large.evaluate('document.querySelector("#main").focus()');
      await large.set('#setup-cue', 'off');
      await large.click('#setup-form [type=submit]'); await large.wait('#start-form'); await fits();
      await large.click('#start-form [type=submit]'); await large.wait('#timer'); await fits();
      await large.advance(121000);
      await large.click('[data-action=pause]'); await large.wait('[data-action=resume]'); await fits();
      await large.click('[data-action=resume]'); await large.wait('[data-action=pause]'); await fits();
      await large.click('[data-action=finish]'); await large.wait('#feedback-form'); await fits();
      await large.click('input[value=comfortable]'); await large.click('#feedback-form .primary'); await large.wait('#start-form');
      await large.click('[data-view=progress]'); await fits();
      const shot = await large.send('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(screenshots, 'progress-large-text.png'), Buffer.from(shot.data, 'base64'));
      await large.click('[data-view=settings]'); await fits();
    } finally { await close(large); }
  });
  await test('pause and resume retain visible controls and keyboard focus in a short viewport', async () => {
    const small = await page(await context());
    try {
      await small.set('#setup-cue', 'off'); await small.click('#setup-form [type=submit]'); await small.wait('#start-form');
      await small.click('#start-form [type=submit]'); await small.wait('#timer'); await small.advance(30000);
      await small.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 300, deviceScaleFactor: 1, mobile: true });
      await small.evaluate('document.querySelector("[data-action=pause]").scrollIntoView({block:"center"})');
      const scroll = await small.evaluate('scrollY');
      assert.ok(scroll > 0, 'The controls must initially require scrolling');
      await small.click('[data-action=pause]'); await small.wait('[data-action=resume]');
      assert.ok(Math.abs(await small.evaluate('scrollY') - scroll) <= 1, 'Pause must preserve the reading viewport');
      assert.equal(await small.evaluate('document.activeElement.dataset.action'), 'resume');
      assert.equal(await small.evaluate('document.querySelector("[data-action=resume]").getBoundingClientRect().bottom <= visualViewport.height'), true);
      await small.advance(60000);
      await small.send('Page.bringToFront');
      await small.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
      await small.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await small.wait('[data-action=pause]');
      assert.ok(Math.abs(await small.evaluate('scrollY') - scroll) <= 1, 'Resume must preserve the reading viewport');
      assert.equal(await small.evaluate('document.activeElement.dataset.action'), 'pause');
      await small.advance(15000); await small.click('[data-action=finish]'); await small.wait('#feedback-form');
      assert.equal(await small.evaluate('scrollY'), 0, 'Finish still navigates to the feedback screen');
      assert.equal((await small.data()).active.activeMs, 45000, 'Paused time must remain excluded');
    } finally { await close(small); }
  });
  await test('timer warnings retain keyboard controls and announce uncertainty once', async () => {
    for (const [failure, action, width, height] of [
      [false, 'finish', 320, 300], [false, 'pause', 844, 390], [false, 'skip', 390, 844],
      [true, 'finish', 320, 300], [true, 'pause', 1280, 900]
    ]) {
      const reader = await page(await context());
      try {
        await reader.set('#setup-cue', 'off'); await reader.click('#setup-form [type=submit]');
        await reader.click('#start-form [type=submit]'); await reader.wait('#timer'); await reader.advance(1000);
        await reader.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 1000 });
        await reader.send('Page.bringToFront');
        const selector = action === 'skip' ? '.skip' : `[data-action=${action}]`;
        await tabTo(reader, selector);
        await reader.evaluate(`window.statusMessages = [];
          new MutationObserver(() => { const text = document.querySelector('#notice').textContent; if (text) statusMessages.push(text); })
            .observe(document.querySelector('#notice'), { childList: true });`);
        if (failure) {
          await reader.evaluate(`window.originalSet = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) {
            if (key === 'reading-endurance-v1') throw new Error('quota'); return originalSet.call(this, key, value);
          };`);
          await reader.advance(5000);
        } else {
          await reader.evaluate('testClock.shift(60000)'); await reader.advance(1000);
          assert.equal((await reader.data()).active.uncertain, true);
        }
        const expected = failure ? '[data-action=finish]' : selector;
        assert.equal(await reader.evaluate(`document.activeElement.matches(${JSON.stringify(expected)})`), true,
          `${failure ? 'Checkpoint failure' : 'Clock uncertainty'} must retain an available control when ${action} was focused`);
        assert.equal(await reader.evaluate('document.activeElement.matches(":focus-visible")'), true);
        const bounds = await reader.evaluate(`(() => { const r = document.activeElement.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: visualViewport.height, scroll: scrollY }; })()`);
        assert.ok(bounds.top >= 0 && bounds.bottom <= bounds.height,
          `The restored ${action} control must be visible after ${failure ? 'storage failure' : 'clock uncertainty'}: ${JSON.stringify(bounds)}`);
        assert.equal(await reader.evaluate('document.querySelector("#timer").getAttribute("aria-live")'), 'off');
        if (!failure) {
          assert.match(await reader.evaluate('document.querySelector("#notice").textContent'), /duration.*confirm|confirm.*duration/i);
          const { nodes } = await reader.send('Accessibility.getFullAXTree');
          assert.ok(nodes.some(n => !n.ignored && n.role?.value === 'status' && n.properties?.some(property => property.name === 'live' && property.value.value === 'polite')));
          await reader.advance(1000);
          assert.equal(await reader.evaluate('statusMessages.length'), 1, 'Further timer ticks must not repeat the uncertainty message');
        } else {
          assert.equal(await reader.evaluate('document.querySelector("[data-action=resume]").disabled'), true);
        }
        if (action === 'skip') continue;
        const shot = await reader.send('Page.captureScreenshot', { format: 'png' });
        await writeFile(join(screenshots, `reading-${failure ? 'storage' : 'clock'}-${action}.png`), Buffer.from(shot.data, 'base64'));
        await reader.press('Enter');
        if (!failure && action === 'pause') {
          await reader.wait('[data-action=resume]');
          assert.equal(await reader.evaluate('document.activeElement.dataset.action'), 'resume');
          await tabTo(reader, '[data-action=finish]'); await reader.press('Enter');
        }
        await reader.wait('#feedback-form');
        assert.equal(await reader.evaluate('document.activeElement.id'), 'main');
        if (failure) {
          await reader.evaluate('Storage.prototype.setItem = originalSet');
          await reader.click('#feedback-form [name=skip]');
          assert.equal((await reader.data()).sessions[0].activeMs, 6000);
          assert.equal((await reader.data()).sessions[0].interruptions, 1);
        }
      } finally { await close(reader); }
    }
  });
  await test('reported safe areas protect reading content, the skip link and dialogs', async () => {
    const inset = await page(await context());
    const setArea = async (width, height, insets) => {
      await inset.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
      await inset.send('Emulation.setSafeAreaInsetsOverride', { insets });
    };
    const inside = async (selector, insets, vertical = true) => {
      const rect = await inset.evaluate(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`);
      const viewport = await inset.evaluate('({width:document.documentElement.clientWidth,height:visualViewport.height})');
      assert.ok(rect.left >= insets.left && rect.right <= viewport.width - insets.right + 1, `${selector} must stay inside horizontal safe bounds`);
      if (vertical) assert.ok(rect.top >= insets.top && rect.bottom <= viewport.height - insets.bottom + 1, `${selector} must stay inside vertical safe bounds`);
    };
    const portrait = { top: 40, right: 0, bottom: 24, left: 0 };
    const landscape = { top: 0, right: 0, bottom: 24, left: 48 };
    try {
      await setArea(390, 844, portrait);
      await inside('.brand', portrait);
      await inset.evaluate('document.querySelector(".skip").focus()'); await inside('.skip', portrait);
      await inset.evaluate('document.querySelector("#main").focus()');
      await inset.set('#setup-cue', 'off'); await inset.click('#setup-form [type=submit]'); await inset.wait('#start-form');
      await setArea(640, 360, landscape); await inset.evaluate('scrollTo(0,0)');
      await inside('#main h1', landscape);
      await inset.click('#start-form [type=submit]'); await inset.wait('#timer');
      await inside('.reading-controls', landscape, false);
      const rotated = { ...landscape, right: 48, left: 0 };
      await setArea(640, 360, rotated); await inside('.reading-controls', rotated, false);
      await inset.advance(30000); await inset.click('[data-action=finish]'); await inset.wait('#feedback-form');
      await inset.click('#feedback-form [name=skip]'); await inset.wait('#start-form');
      await inset.click('[data-view=settings]'); await inset.click('[data-action=clear]'); await inset.wait('#confirm-form');
      await inside('dialog[open]', rotated);
      await setArea(320, 300, portrait);
      await inside('dialog[open]', portrait);
      await inset.click('[data-action=close-dialog]');
      assert.equal((await inset.data()).sessions.length, 1, 'Cancelling must retain the saved read');
    } finally { await close(inset); }
  });
  await test('an unused invalid Train field cannot block Two-minute start', async () => {
    await p.click('input[name=mode][value=train]'); await p.set('#session-target', '');
    await p.click('input[name=mode][value=start]');
    assert.equal(await p.evaluate('document.querySelector("#start-form").checkValidity()'), true);
  });
  await test('two-minute start continues, cues once, freezes at Finish and saves neutrally', async () => {
    await p.click('#start-form [type=submit]'); await p.wait('#timer');
    assert.equal(await p.evaluate('document.querySelector("#navigation").hidden'), true);
    await p.advance(119000); await p.advance(1000);
    assert.equal(await p.evaluate('cueCalls.length'), 2); // one preview + one live request
    assert.equal((await p.data()).active.state, 'running');
    await p.advance(5000);
    assert.equal(await p.evaluate('cueCalls.length'), 2);
    await p.click('[data-action=finish]'); await p.wait('#feedback-form');
    const frozen = (await p.data()).active.activeMs;
    await p.advance(120000);
    assert.equal((await p.data()).active.activeMs, frozen);
    await p.click('#feedback-form [name=skip]'); await p.wait('#start-form');
    assert.equal((await p.data()).sessions.length, 1);
    assert.equal((await p.data()).sessions[0].outcome, null);
    assert.equal((await p.data()).sessions[0].activeMs, 125000);
  });
  await test('Train reaches target without stopping; two successes update recommendation', async () => {
    for (let i = 0; i < 2; i++) {
      await p.click('input[name=mode][value=train]'); await p.set('#session-target', '2');
      assert.equal(await p.evaluate('document.querySelector("#target-cue").disabled'), true);
      await p.click('#start-form [type=submit]'); await p.wait('#timer');
      await p.advance(119000); await p.advance(1000);
      assert.equal((await p.data()).active.state, 'running');
      assert.equal((await p.data()).active.targetSignal.attempted, false);
      await p.click('[data-action=finish]'); await p.wait('#feedback-form');
      await p.click('input[value=comfortable]'); await p.click('#feedback-form .primary'); await p.wait('#start-form');
    }
    assert.match(await p.text(), /Recommended: 4 minutes/);
    const records = (await p.data()).sessions;
    assert.equal(records[1].prescribedTarget, 10);
    assert.equal(records[1].targetMinutes, 2);
  });
  await test('edit and delete replay recommendations, progress has honest labeled history', async () => {
    await p.click('[data-view=progress]');
    assert.equal(await p.evaluate('document.querySelector(".metric strong").textContent'), '4 min');
    assert.match(await p.text(), /0 of 3 completed reads/);
    assert.doesNotMatch(await p.text(), /0%/);
    await p.click('.history [data-action=edit]');
    await p.click('#edit-form input[value=challenging]'); await p.click('#edit-form .primary');
    assert.equal(await p.evaluate('document.querySelector(".metric strong").textContent'), '2 min');
    await p.click('.history [data-action=delete]'); await p.click('#confirm-form [type=submit]');
    assert.equal((await p.data()).sessions.length, 2);
    const shot = await p.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await writeFile(join(screenshots, 'progress-portrait.png'), Buffer.from(shot.data, 'base64'));
  });
  await test('history action names and deletion identify the selected read', async () => {
    const history = await page(await context());
    try {
      await history.set('#setup-cue', 'off'); await history.click('#setup-form [type=submit]');
      for (const [mode, activeMs] of [['start', 60000], ['free', 180000]]) {
        await history.click(`[name=mode][value=${mode}]`); await history.click('#start-form [type=submit]');
        await history.advance(activeMs); await history.click('[data-action=finish]');
        await history.click('#feedback-form [name=skip]'); await history.wait('#start-form');
      }
      const saved = await history.data();
      await history.click('[data-view=progress]');
      const rows = await history.evaluate(`[...document.querySelectorAll('.history li')].map(row => ({
        id: row.querySelector('[data-action=delete]').dataset.id,
        title: row.querySelector('.record-title strong').textContent,
        timestamp: row.querySelector('.record-title span').textContent
      }))`);
      const { nodes } = await history.send('Accessibility.getFullAXTree');
      const names = nodes.filter(n => !n.ignored && n.role?.value === 'button').map(n => n.name?.value);
      for (const row of rows) {
        for (const action of ['Edit feedback', 'Delete']) {
          assert.ok(names.some(name => name.startsWith(action) && name.includes(row.title) && name.includes(row.timestamp)),
            `${action} must identify the duration, mode and date shown for ${row.title}`);
        }
      }
      const selected = rows[1];
      const deleteSelector = `[data-action=delete][data-id="${selected.id}"]`;
      await history.send('Page.bringToFront'); await tabTo(history, deleteSelector); await history.press('Enter');
      assert.equal(await history.evaluate('document.activeElement.dataset.action'), 'close-dialog', 'Deletion must still initially focus Cancel');
      const modal = await history.send('Accessibility.getFullAXTree');
      const contextText = modal.nodes.filter(n => !n.ignored && n.role?.value === 'StaticText').map(n => n.name?.value).join(' ');
      assert.ok(contextText.includes(selected.title) && contextText.includes(selected.timestamp), 'The active modal must expose the selected read without relying on inert history');
      for (const [width, height] of [[320, 640], [844, 390], [1280, 900], [390, 844]]) {
        await history.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 1000 });
        assert.equal(await history.evaluate(`(() => { const d = document.querySelector('#dialog'); const r = d.getBoundingClientRect(); return d.scrollWidth <= d.clientWidth && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })()`), true);
      }
      const shot = await history.send('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(screenshots, 'delete-read-context.png'), Buffer.from(shot.data, 'base64'));
      await history.press('Escape');
      assert.equal(await history.evaluate('document.activeElement.dataset.id'), selected.id);
      assert.deepEqual(await history.data(), saved, 'Cancellation must preserve all records');
      await history.press('Enter'); await history.press('Tab'); await history.press('Enter');
      await until(async () => (await history.data()).sessions.length === 1, 'selected record deletion');
      assert.equal((await history.data()).sessions[0].id, saved.sessions[1].id, 'Confirmation must delete the identified read only');
    } finally { await close(history); }
  });
  await test('pause arithmetic, large landscape controls and finishing while paused', async () => {
    await p.click('[data-view=read]'); await p.click('input[name=mode][value=free]');
    await p.click('#start-form [type=submit]'); await p.wait('#timer'); await p.advance(30000);
    await p.evaluate('caches.open("unrelated-fixture").then(cache => cache.put("/foreign", new Response("keep")))');
    await p.click('[data-action=pause]'); await p.advance(120000);
    assert.equal((await p.data()).active.activeMs, 30000);
    assert.equal((await p.data()).active.interruptions, 1);
    await p.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true });
    assert.equal(await p.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    assert.equal(await p.evaluate('document.querySelector("[data-action=finish]").getBoundingClientRect().height >= 48'), true);
    const shot = await p.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(screenshots, 'paused-landscape.png'), Buffer.from(shot.data, 'base64'));
    await p.click('[data-action=finish]'); await p.wait('#feedback-form');
    await p.click('input[value=external]'); await p.click('#feedback-form .primary'); await p.wait('#start-form');
    assert.equal((await p.data()).sessions.at(-1).activeMs, 30000);
    await p.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  });
  await test('multi-tab exclusion and explicit reload recovery never counts crash downtime', async () => {
    await p.click('#start-form [type=submit]'); await p.wait('#timer'); await p.advance(60000);
    const other = await page(contextId);
    assert.match(await other.text(), /Open in another tab/);
    await close(other);
    // Shift only the next document, after the outgoing page can checkpoint its last active minute.
    const { identifier } = await p.send('Page.addScriptToEvaluateOnNewDocument', { source: 'testClock.shift(10800000)' });
    try {
      await p.send('Page.reload'); await p.wait('#recovery-form');
    } finally { await p.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }); }
    assert.equal(await p.evaluate('Date.now() - JSON.parse(localStorage.getItem("reading-endurance-v1")).active.checkpointAt'), 10800000,
      'Recovery must exercise a checkpoint three hours older than the new document');
    assert.equal((await p.data()).active.activeMs, 60000);
    assert.equal(await p.evaluate('document.querySelector("#recovery-form input").value'), '1', 'Closed time must not inflate the recovery default');
    await p.set('#recovery-form input', '1.5'); await p.click('#recovery-form [type=submit]');
    await p.wait('[data-action=resume]');
    assert.equal((await p.data()).active.activeMs, 90000);
    assert.equal((await p.data()).active.uncertain, true);
    await p.click('[data-action=resume]'); await p.advance(29000); await p.advance(1000);
    assert.equal(await p.evaluate('cueCalls.length'), 0);
    await p.click('[data-action=finish]'); await p.wait('#feedback-form');
    await p.click('#feedback-form [name=skip]'); await p.wait('#start-form');
    const recovered = (await p.data()).sessions.at(-1);
    assert.equal(recovered.activeMs, 120000);
    assert.equal(recovered.uncertain, true);
    assert.equal(recovered.interruptions, 1);
  });
  await test('hidden deadline does not emit a late cue on return', async () => {
    await p.click('#start-form [type=submit]'); await p.wait('#timer'); await p.advance(119000);
    await p.evaluate('testVisible(false)'); await p.advance(1000); await p.evaluate('testVisible(true)');
    assert.equal(await p.evaluate('cueCalls.length'), 0);
    assert.equal((await p.data()).active.confidence.passed, true);
    assert.equal((await p.data()).active.confidence.attempted, false);
    await p.click('[data-action=finish]'); await p.wait('#feedback-form');
    await p.click('#feedback-form [name=skip]'); await p.wait('#start-form');
  });
  await test('storage failure pauses safely and duplicate save retains one pending read', async () => {
    await p.click('#start-form [type=submit]'); await p.wait('#timer'); await p.advance(10000);
    await p.evaluate('window.originalSet = Storage.prototype.setItem; Storage.prototype.setItem = function() { throw new Error("quota"); };');
    await p.click('[data-action=pause]');
    assert.match(await p.text(), /Changes are not saved/);
    await p.evaluate('Storage.prototype.setItem = originalSet'); await p.click('[data-action=retry-storage]');
    await p.click('[data-action=finish]'); await p.wait('#feedback-form');
    const before = (await p.data()).sessions.length;
    await p.evaluate('Storage.prototype.setItem = function() { throw new Error("quota"); };');
    await p.click('#feedback-form [name=skip]');
    assert.equal((await p.data()).sessions.length, before);
    assert.equal(await p.has('#feedback-form'), true);
    await p.evaluate('Storage.prototype.setItem = originalSet');
    await p.evaluate('const saveButton = document.querySelector("#feedback-form [name=skip]"); saveButton.click(); saveButton.click();');
    await p.wait('#start-form'); assert.equal((await p.data()).sessions.length, before + 1);
  });
  await test('modal storage failures expose recovery and retain unsaved feedback', async () => {
    const editorContext = await context();
    const editor = await page(editorContext);
    const failWrites = () => editor.evaluate(`window.originalSet = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) {
      if (key === 'reading-endurance-v1') throw new Error('quota');
      return originalSet.call(this, key, value);
    };`);
    const restoreWrites = () => editor.evaluate('Storage.prototype.setItem = originalSet');
    const accessibleRecovery = async () => {
      const { nodes } = await editor.send('Accessibility.getFullAXTree');
      assert.ok(nodes.some(n => !n.ignored && n.role?.value === 'alert'), 'The modal failure must expose an alert');
      assert.ok(nodes.some(n => !n.ignored && n.role?.value === 'button' && n.name?.value === 'Retry storage'), 'Recovery must be accessible while the modal is open');
    };
    try {
      await editor.set('#setup-cue', 'off'); await editor.click('#setup-form [type=submit]');
      await editor.click('#start-form [type=submit]'); await editor.advance(120000);
      await editor.click('[data-action=finish]'); await editor.click('#feedback-form [name=skip]');
      await editor.click('[data-view=progress]'); await editor.click('[data-action=edit]');
      await editor.click('#edit-form [value=lost]'); await editor.set('#edit-form [name=estimate]', '1.5');
      const saved = await editor.data();
      await failWrites(); await editor.click('#edit-form .primary');
      assert.equal(await editor.evaluate('document.querySelector("#dialog").open'), true);
      assert.deepEqual(await editor.data(), saved, 'A failed edit must leave the saved record unchanged');
      await accessibleRecovery();
      const failureHelp = await editor.evaluate('document.querySelector("#dialog-storage-error").textContent');
      assert.match(failureHelp, /keep this page open/i, 'Failure help must preserve the unsaved form');
      assert.match(failureHelp, /retry storage.*submit.*again/i, 'Recovery must explain that form submission needs a separate retry');
      assert.match(failureHelp, /exports?.*not include.*unsaved form/i, 'Failure help must disclose the export boundary');
      const downloadDirectory = join(profile, 'failed-edit-download');
      await mkdir(downloadDirectory);
      await cdp.send('Browser.setDownloadBehavior', {
        behavior: 'allow', downloadPath: downloadDirectory, browserContextId: editorContext, eventsEnabled: true
      });
      await editor.click('#dialog [data-action=export]');
      const downloaded = join(downloadDirectory, 'reading-endurance-v1.json');
      await until(async () => { try { await readFile(downloaded); return true; } catch { return false; } }, 'failed-edit export download');
      assert.deepEqual(JSON.parse(await readFile(downloaded, 'utf8')), saved, 'Export must contain the existing model, not the unsaved edit');
      assert.equal(await editor.evaluate('document.querySelector("#edit-form [name=outcome]:checked").value'), 'lost');
      assert.equal(await editor.evaluate('document.querySelector("#edit-form [name=estimate]").value'), '1.5');
      await editor.send('Page.bringToFront');
      for (const [width, height] of [[320, 640], [844, 390], [1280, 900], [390, 844]]) {
        await editor.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 1000 });
        await editor.press('Tab'); await tabTo(editor, '#dialog [data-action=retry-storage]');
        assert.equal(await editor.evaluate(`(() => {
          const box = document.querySelector('#dialog'); const rect = document.activeElement.getBoundingClientRect();
          return box.scrollWidth <= box.clientWidth && rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth;
        })()`), true, `Modal recovery must be visible without horizontal overflow at ${width}×${height}`);
      }
      assert.equal(await editor.evaluate('document.activeElement.matches(":focus-visible")'), true);
      const shot = await editor.send('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(screenshots, 'dialog-storage-error.png'), Buffer.from(shot.data, 'base64'));
      await restoreWrites(); await editor.press('Enter');
      assert.equal(await editor.evaluate('document.querySelector("#edit-form [name=estimate]").value'), '1.5');
      assert.equal(await editor.evaluate('document.querySelector("#edit-form [name=outcome]:checked").value'), 'lost');
      assert.equal(await editor.evaluate('document.activeElement.dataset.action'), 'close-dialog', 'Retry must leave focus on an available dialog control');
      const { nodes } = await editor.send('Accessibility.getFullAXTree');
      assert.ok(nodes.some(n => !n.ignored && n.role?.value === 'status'), 'Retry status must be exposed inside the dialog');
      await tabTo(editor, '#edit-form .primary'); await editor.press('Enter'); await editor.wait('.history');
      assert.equal((await editor.data()).sessions.length, 1);
      assert.equal((await editor.data()).sessions[0].engagedMinutes, 1.5);
      await editor.click('[data-view=settings]'); await editor.click('[data-action=clear]');
      await failWrites(); await editor.click('#confirm-form [type=submit]');
      await accessibleRecovery();
      await editor.press('Escape');
      assert.equal(await editor.evaluate('document.activeElement.dataset.action'), 'clear');
      assert.equal((await editor.data()).sessions.length, 1, 'Failed clearing and cancellation must retain data');
      const afterCancel = await editor.send('Accessibility.getFullAXTree');
      assert.ok(afterCancel.nodes.some(n => !n.ignored && n.role?.value === 'alert'), 'The error must remain accessible after dismissing the modal');
    } finally { await close(editor); }
  });
  await test('skipping invalid feedback is allowed; external reasons and manual target changes hold', async () => {
    await p.click('[data-view=settings]'); await p.set('#target-form input', '20'); await p.click('#target-form [type=submit]');
    assert.equal((await p.data()).targetChanges.at(-1).target, 20);
    await p.click('[data-view=read]'); await p.click('input[name=mode][value=train]');
    assert.equal(await p.evaluate('document.querySelector("#session-target").value'), '20');
    assert.equal(await p.evaluate('document.querySelector("#target-cue").checked'), false);
    await p.click('#start-form [type=submit]'); await p.wait('#timer'); await p.advance(120000);
    await p.click('[data-action=finish]'); await p.wait('#feedback-form');
    await p.click('input[value=lost]'); await p.set('input[name=estimate]', '999');
    await p.click('#feedback-form [name=skip]'); await p.wait('#start-form');
    assert.equal((await p.data()).sessions.at(-1).outcome, null);
    assert.match(await p.text(), /Recommended: 20 minutes/);
    await p.click('#start-form [type=submit]'); await p.wait('#timer'); await p.advance(60000);
    await p.click('[data-action=finish]'); await p.wait('#feedback-form');
    await p.click('input[value=external]'); await p.click('#feedback-form .primary'); await p.wait('#start-form');
    assert.match(await p.text(), /Recommended: 20 minutes/);
  });
  await test('Lost the thread estimate has a visible boundary, stays constrained, and updates the target', async () => {
    await p.click('#start-form [type=submit]'); await p.wait('#timer'); await p.advance(600000);
    await p.click('[data-action=finish]'); await p.wait('#feedback-form');
    await p.click('input[value=lost]');
    assert.equal(await p.evaluate('document.querySelector("input[name=estimate]").value'), '');
    const colors = await p.evaluate(`(() => {
      const input = document.querySelector('input[name=estimate]');
      let outside = input.parentElement;
      while (getComputedStyle(outside).backgroundColor === 'rgba(0, 0, 0, 0)') outside = outside.parentElement;
      return [getComputedStyle(input).borderTopColor, getComputedStyle(outside).backgroundColor];
    })()`);
    assert.ok(colors.every(color => color.startsWith('rgb(')), 'Contrast check requires opaque sRGB colors');
    const luminance = color => {
      const [r, g, b] = color.match(/[\d.]+/g).slice(0, 3).map(value => {
        const channel = Number(value) / 255;
        return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
      });
      return .2126 * r + .7152 * g + .0722 * b;
    };
    const [border, background] = colors.map(luminance);
    const ratio = (Math.max(border, background) + .05) / (Math.min(border, background) + .05);
    assert.ok(ratio >= 3, `Estimate border contrast is ${ratio.toFixed(3)}:1; WCAG 1.4.11 requires at least 3:1`);
    const shot = await p.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await writeFile(join(screenshots, 'feedback-estimate.png'), Buffer.from(shot.data, 'base64'));
    await p.set('input[name=estimate]', '11');
    await p.click('#feedback-form .primary'); assert.equal(await p.has('#feedback-form'), true);
    await p.set('input[name=estimate]', '7.9'); await p.click('#feedback-form .primary'); await p.wait('#start-form');
    assert.match(await p.text(), /Recommended: 7 minutes/);
    assert.equal((await p.data()).sessions.at(-1).engagedMinutes, 7.9);
  });
  await test('Lost the thread with a blank estimate saves null and reduces the chosen target by two', async () => {
    const reader = await page(await context());
    try {
      await reader.set('#setup-cue', 'off'); await reader.click('#setup-form [type=submit]');
      await reader.click('input[name=mode][value=train]'); await reader.click('#start-form [type=submit]');
      await reader.wait('#timer'); await reader.advance(600000);
      await reader.click('[data-action=finish]'); await reader.wait('#feedback-form');
      await reader.click('input[value=lost]');
      assert.equal(await reader.evaluate('document.querySelector("input[name=estimate]").value'), '');
      await reader.click('#feedback-form .primary'); await reader.wait('#start-form');
      const saved = await reader.data();
      assert.equal(saved.sessions.length, 1);
      assert.equal(saved.sessions[0].targetMinutes, 10);
      assert.equal(saved.sessions[0].activeMs, 600000);
      assert.equal(saved.sessions[0].outcome, 'lost');
      assert.equal(saved.sessions[0].engagedMinutes, null, 'An omitted estimate must stay distinct from zero');
      assert.match(await reader.text(), /Recommended: 8 minutes/);
    } finally { await close(reader); }
  });
  await test('clock changes require duration confirmation; stale callbacks never cue', async () => {
    await p.click('#start-form [type=submit]'); await p.wait('#timer');
    await p.advance(119000); await p.evaluate('testClock.shift(3600000)'); await p.advance(1000);
    assert.equal((await p.data()).active.uncertain, true);
    assert.equal((await p.data()).active.confidence.attempted, false);
    assert.equal((await p.data()).active.activeMs, 120000);
    await p.click('[data-action=finish]'); await p.wait('#feedback-form');
    await p.set('input[name=corrected]', ''); await p.click('#feedback-form [name=skip]');
    assert.equal(await p.has('#feedback-form'), true);
    await p.set('input[name=corrected]', '3'); await p.click('input[value=lost]'); await p.set('input[name=estimate]', '2.9');
    assert.equal(await p.evaluate('document.querySelector("#feedback-form").checkValidity()'), true);
    await p.set('input[name=corrected]', '1.8'); await p.click('#feedback-form [name=skip]'); await p.wait('#start-form');
    assert.equal((await p.data()).sessions.at(-1).activeMs, 108000);
    assert.equal((await p.data()).sessions.at(-1).interruptions, 1);
  });
  await test('versioned import replaces the complete model and preserves data on invalid input or cancel', async () => {
    await p.click('[data-view=settings]');
    const original = await p.data();
    const importFile = async contents => p.evaluate(`(() => {
      const input = document.querySelector('#import-file'); const transfer = new DataTransfer();
      transfer.items.add(new File([${JSON.stringify(contents)}], 'reading.json', {type:'application/json'}));
      input.files = transfer.files; input.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    await importFile('{bad'); await until(() => p.evaluate('document.querySelector("#notice").textContent.includes("JSON")'), 'invalid import message');
    assert.deepEqual(await p.data(), original);
    const wall = await p.evaluate('Date.now()');
    const imported = { ...structuredClone(original), nextOrder: 3,
      settings: { setup: true, initialTarget: 30, cue: 'off' },
      sessions: [{ ...original.sessions[0], id: 'imported-read', kind: 'session', order: 1,
        mode: 'free', startedAt: wall - 600000, finishedAt: wall - 420000, activeMs: 180000,
        interruptions: 0, uncertain: false, prescribedTarget: null, targetMinutes: null,
        cue: 'off', confidenceEnabled: false, targetCue: false, outcome: 'challenging', engagedMinutes: null,
        confidence: { passed: true, attempted: false, suppressed: false },
        targetSignal: { passed: false, attempted: false, suppressed: false } }],
      targetChanges: [{ kind: 'target', id: 'imported-target', at: wall - 300000, order: 2, target: 22 }],
      active: { id: 'imported-pending', owner: 'backup-tab', mode: 'train', state: 'paused',
        startedAt: wall - 90000, checkpointAt: wall, finishedAt: null, activeMs: 90000,
        interruptions: 1, uncertain: false, prescribedTarget: 22, targetMinutes: 20,
        cue: 'off', confidenceEnabled: false, targetCue: false,
        confidence: { passed: false, attempted: false, suppressed: false },
        targetSignal: { passed: false, attempted: false, suppressed: false } } };
    await importFile(JSON.stringify(imported)); await p.wait('#confirm-form');
    await p.click('[data-action=close-dialog]'); assert.deepEqual(await p.data(), original);
    await importFile(JSON.stringify(imported)); await p.wait('#confirm-form');
    await p.click('#confirm-form [type=submit]');
    assert.deepEqual(await p.data(), imported, 'Import must replace settings, history, manual changes, and pending state together');
    await p.wait('#recovery-form');
    await p.send('Page.reload'); await p.wait('#recovery-form');
    assert.deepEqual(await p.data(), imported, 'The complete imported model must survive reload before recovery');
    assert.equal(await p.evaluate('document.querySelector("#recovery-form input").value'), '1.5');
    await p.click('#recovery-form [type=submit]'); await p.wait('[data-action=finish]');
    await p.click('[data-action=finish]'); await p.click('#feedback-form [name=skip]'); await p.wait('#start-form');
    await p.click('[data-view=settings]');
    const downloadDirectory = join(profile, 'downloads'); await mkdir(downloadDirectory);
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDirectory, browserContextId: contextId, eventsEnabled: true });
    await p.click('[data-action=export]');
    const download = join(downloadDirectory, 'reading-endurance-v1.json');
    try {
      await until(async () => { try { await readFile(download); return true; } catch { return false; } }, 'JSON export download');
    } catch (error) {
      console.error('Download diagnostics:', await readdir(downloadDirectory), cdp.downloads);
      throw error;
    }
    assert.deepEqual(JSON.parse(await readFile(download, 'utf8')), await p.data());
    await p.click('[data-view=read]');
  });
  await test('offline reload retains feedback; updates wait and deliver a complete changed shell', async () => {
    await until(() => p.evaluate('navigator.serviceWorker.getRegistration().then(r => !!r?.active)'), 'service worker activation');
    await p.send('Page.reload'); await p.wait('#start-form');
    await p.click('#start-form [type=submit]'); await p.wait('#timer'); await p.advance(30000);
    updateVersion = true;
    await p.evaluate('navigator.serviceWorker.getRegistration().then(r => r.update())');
    await until(() => p.evaluate('navigator.serviceWorker.getRegistration().then(r => !!r?.waiting)'), 'waiting update');
    assert.equal(await p.has('#timer'), true);
    assert.equal(await p.evaluate('getComputedStyle(document.documentElement).getPropertyValue("--reading-test-shell").trim()'), '',
      'A waiting update must not replace the active shell stylesheet');
    await p.click('[data-action=finish]'); await p.wait('#feedback-form');
    const frozen = (await p.data()).active.activeMs;
    await p.send('Network.enable'); await p.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await p.send('Page.reload'); await p.wait('#feedback-form');
    assert.equal((await p.data()).active.activeMs, frozen);
    await p.click('#feedback-form [name=skip]'); await p.wait('#start-form');
    await p.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    assert.equal(await p.evaluate('navigator.serviceWorker.getRegistration().then(r => !!r.waiting)'), true);
    await close(p);
    p = await page(contextId);
    await p.wait('#start-form');
    await until(() => p.evaluate('navigator.serviceWorker.getRegistration().then(r => !r.waiting && r.active?.state === "activated")'), 'update activates after close');
    const cacheKeys = await p.evaluate('caches.keys()');
    assert.ok(cacheKeys.some(k => k.endsWith(':v11')));
    assert.ok(!cacheKeys.some(k => k.endsWith(':v10')));
    assert.ok(cacheKeys.includes('unrelated-fixture'), 'Unrelated caches are retained');
    const updatedCache = cacheKeys.find(key => key.endsWith(':v11'));
    const cachedUrls = await p.evaluate(`caches.open(${JSON.stringify(updatedCache)}).then(cache => cache.keys()).then(requests => requests.map(request => request.url).sort())`);
    // These are required by the runtime entrypoints, independently of the worker's shell list.
    const requiredUrls = ['./', './index.html', './style.css', './app.js', './core.js',
      './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png']
      .map(path => new URL(path, origin + '/').href).sort();
    assert.deepEqual(cachedUrls, requiredUrls, 'The activated update must cache the complete app shell');
    const saved = await p.data();
    await p.send('Network.enable');
    await p.send('Network.setCacheDisabled', { cacheDisabled: true });
    serverOffline = true;
    try {
      await p.send('Page.reload'); await p.wait('#start-form');
      assert.equal(await p.evaluate('!!navigator.serviceWorker.controller'), true);
      assert.equal(await p.evaluate('getComputedStyle(document.documentElement).getPropertyValue("--reading-test-shell").trim()'), 'upgraded',
        'The activated worker must deliver the changed stylesheet without network or HTTP-cache fallback');
      assert.deepEqual(await p.data(), saved, 'Offline startup after activation must retain local reading data');
    } finally {
      serverOffline = false;
      await p.send('Network.setCacheDisabled', { cacheDisabled: false });
    }
  });
  await test('unsupported vibration defaults to Off with no audio substitution', async () => {
    const unsupported = await page(await context(), true);
    await unsupported.wait('#setup-form');
    assert.equal(await unsupported.evaluate('document.querySelector("#setup-cue").value'), 'off');
    assert.match(await unsupported.text(), /Vibration is unavailable/);
    await unsupported.click('#setup-form [type=submit]'); await unsupported.wait('#start-form');
    await unsupported.click('#start-form [type=submit]'); await unsupported.wait('#timer');
    await unsupported.advance(119000); await unsupported.advance(1000);
    assert.equal((await unsupported.data()).active.confidence.passed, true);
    assert.equal((await unsupported.data()).active.confidence.attempted, false);
    assert.equal(await unsupported.evaluate('audioCalls.contexts'), 0);
    await close(unsupported);
  });
  await test('explicit sound selection uses gesture activation and never queues a late tone', async () => {
    const sound = await page(await context(), true);
    await sound.wait('#setup-form'); await sound.set('#setup-cue', 'sound');
    await sound.click('[data-action=preview]');
    assert.equal(await sound.evaluate('audioCalls.tones'), 1);
    await sound.click('#setup-form [type=submit]'); await sound.wait('#start-form');
    await sound.click('#start-form [type=submit]'); await sound.wait('#timer');
    await sound.advance(119000); await sound.advance(1000);
    assert.equal(await sound.evaluate('audioCalls.tones'), 2);
    await sound.click('[data-action=pause]'); await sound.advance(60000);
    await sound.click('[data-action=finish]'); await sound.wait('#feedback-form');
    await sound.click('#feedback-form [name=skip]'); await sound.wait('#start-form');
    await sound.click('input[name=mode][value=train]'); await sound.set('#session-target', '2');
    await sound.click('#confidence'); await sound.click('#target-cue');
    await sound.click('#start-form [type=submit]'); await sound.wait('#timer'); await sound.advance(119000);
    await sound.evaluate('testClock.advance(1000)');
    await until(() => sound.evaluate('audioCalls.tones === 4'), 'two tones for target without confidence collision');
    const cancellations = await sound.evaluate('audioCalls.cancellations');
    await sound.click('[data-action=finish]'); await sound.wait('#feedback-form');
    assert.ok(await sound.evaluate(`audioCalls.cancellations > ${cancellations}`), 'Finish stops queued target audio before a later resume');
    await sound.click('#feedback-form [name=skip]'); await sound.wait('#start-form');
    await sound.click('#start-form [type=submit]'); await sound.wait('#timer'); await sound.advance(119000);
    await sound.evaluate('testVisible(false)'); await sound.advance(1000); await sound.evaluate('testVisible(true)');
    assert.equal(await sound.evaluate('audioCalls.tones'), 4);
    await close(sound);
  });
  await test('a failed deadline checkpoint suppresses delivery and preserves an honest attempt flag', async () => {
    const failed = await page(await context());
    await failed.wait('#setup-form'); await failed.click('#setup-form [type=submit]'); await failed.wait('#start-form');
    await failed.click('#start-form [type=submit]'); await failed.wait('#timer'); await failed.advance(119000);
    await failed.evaluate(`window.originalSet = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key,value) { if (key === 'reading-endurance-v1') throw Error('quota'); return originalSet.call(this,key,value); };`);
    await failed.advance(1000);
    assert.equal(await failed.evaluate('cueCalls.length'), 0);
    assert.match(await failed.text(), /Changes are not saved/);
    await failed.evaluate('Storage.prototype.setItem = originalSet'); await failed.click('[data-action=retry-storage]');
    assert.equal((await failed.data()).active.state, 'paused');
    assert.equal((await failed.data()).active.confidence.passed, true);
    assert.equal((await failed.data()).active.confidence.attempted, false);
    await failed.click('[data-action=resume]'); await failed.advance(1000);
    assert.equal(await failed.evaluate('cueCalls.length'), 0);
    await close(failed);
  });
  await test('corrupt local data is preserved until explicit reset', async () => {
    const broken = await page(await context());
    await broken.wait('#setup-form');
    await broken.evaluate('localStorage.setItem("reading-endurance-v1", "{broken")');
    await broken.send('Page.reload');
    await until(async () => (await broken.text()).includes('Local data needs attention'), 'corrupt storage UI');
    assert.equal(await broken.evaluate('localStorage.getItem("reading-endurance-v1")'), '{broken');
    await broken.click('[data-action=clear]'); await broken.click('#confirm-form [type=submit]');
    await broken.wait('#setup-form');
    assert.equal((await broken.data()).sessions.length, 0);
    await close(broken);
  });
  await test('back/forward restoration cannot clear data owned by another tab', async () => {
    const isolated = await context();
    const reader = await page(isolated);
    await reader.wait('#setup-form'); await reader.click('#setup-form [type=submit]'); await reader.wait('#start-form');
    await reader.click('#start-form [type=submit]'); await reader.wait('#timer'); await reader.advance(30000);
    await reader.click('[data-action=finish]'); await reader.wait('#feedback-form');
    await reader.click('#feedback-form [name=skip]'); await reader.wait('#start-form');
    await reader.click('[data-view=settings]'); await reader.click('[data-action=clear]');
    await reader.evaluate('window.restoredDocument = true');
    const history = await reader.send('Page.getNavigationHistory');
    const entryId = history.entries[history.currentIndex].id;
    await reader.send('Page.navigate', { url: alternateOrigin + '/style.css' });
    await until(() => reader.evaluate('location.pathname === "/style.css"'), 'navigate away');
    const writer = await page(isolated); await writer.wait('#start-form');
    await writer.click('#start-form [type=submit]'); await writer.wait('#timer');
    const expected = await writer.data();
    await reader.send('Page.navigateToHistoryEntry', { entryId });
    await reader.send('Page.bringToFront');
    await until(async () => (await reader.text()).includes('Open in another tab'), 'restored lock explanation');
    assert.equal(await reader.evaluate('window.restoredDocument'), true, 'Must restore the original document from the back/forward cache');
    // Exercise a retained confirmation, including a submit queued before ownership was lost.
    await reader.evaluate('document.querySelector("#confirm-form [type=submit]")?.click()');
    assert.deepEqual(await writer.data(), expected, 'A restored non-owner must not overwrite the writer\'s history or active read');
    assert.equal(await reader.evaluate('document.querySelector("#dialog").open'), false, 'Stale dialogs must not obstruct the lock explanation');
    await close(reader); await close(writer);
  });
  await test('insecure startup explains unavailable APIs without writing data', async () => {
    const unsupported = await page(await context(), true, alternateOrigin);
    assert.equal(await unsupported.evaluate('isSecureContext'), false);
    assert.equal(await unsupported.evaluate('typeof crypto.randomUUID'), 'undefined');
    assert.equal(await unsupported.evaluate('typeof navigator.locks'), 'undefined');
    assert.match(await unsupported.text(), /A supported browser is needed/);
    assert.match(await unsupported.text(), /HTTPS or localhost/);
    await unsupported.click('[data-action=retry-lock]');
    assert.match(await unsupported.text(), /A supported browser is needed/);
    assert.equal(await unsupported.data(), null, 'Unsupported startup and retry must not create local data');
    await close(unsupported);
  });
  assert.deepEqual(cdp.errors, [], 'No uncaught browser exceptions');
  console.log(`Screenshots: ${screenshots}`);
} catch (error) {
  console.error('Browser check failed:', error);
  throw error;
} finally {
  cdp?.socket.close();
  if (chrome?.pid && chrome.exitCode === null && chrome.signalCode === null) {
    const exited = once(chrome, 'exit');
    chrome.kill('SIGTERM');
    await exited;
  }
  if (server?.listening) await new Promise(resolveClose => server.close(resolveClose));
  if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
