// A headless Chrome with the unpacked extension, driven over --remote-debugging-pipe. No dependencies.
// Branded Chrome ignores --load-extension, so the extension is loaded with Extensions.loadUnpacked.
import {spawn} from 'node:child_process';
import {mkdtempSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

export function chromePath() {
  const candidates = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
  return candidates.find(p => existsSync(p)) ?? null;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function launch(extDir) {
  const profile = mkdtempSync(path.join(tmpdir(), 'assistant-e2e-'));
  const chrome = spawn(chromePath(), [
    '--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', 'about:blank',
  ], {stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe']});
  let stderr = '';
  chrome.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
  const out = chrome.stdio[3], inp = chrome.stdio[4];
  let nextId = 1, buffer = '';
  const pending = new Map(), listeners = new Set();
  inp.on('data', chunk => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\0')) !== -1) {
      const msg = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      if (msg.id && pending.has(msg.id)) {
        const {resolve, reject} = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data ?? ''}`)); else resolve(msg.result);
      } else for (const l of listeners) l(msg);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, {resolve, reject});
    out.write(JSON.stringify({id, method, params, sessionId}) + '\0');
  });

  async function openPage(url, {width = 1000, height = 760} = {}) {
    const {targetId} = await send('Target.createTarget', {url});
    const {sessionId} = await send('Target.attachToTarget', {targetId, flatten: true});
    const errors = [];
    listeners.add(m => {
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map(a => a.value ?? a.description).join(' '));
    });
    await send('Runtime.enable', {}, sessionId);
    await send('Page.enable', {}, sessionId);
    await send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile: false}, sessionId);
    const page = {
      targetId, sessionId, errors,
      async activate() { await send('Target.activateTarget', {targetId}); },
      async eval(expression) {
        const r = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true}, sessionId);
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result.value;
      },
      async waitFor(expression, ms = 10000) {
        const start = Date.now();
        let last;
        for (;;) {
          try { const v = await page.eval(expression); if (v) return v; } catch (e) { last = e; }
          if (Date.now() - start > ms) throw new Error(`timeout: ${expression}${last ? ` (${last.message})` : ''}`);
          await sleep(100);
        }
      },
      async screenshot() {
        const {data} = await send('Page.captureScreenshot', {format: 'png'}, sessionId);
        return Buffer.from(data, 'base64');
      },
      async close() { await send('Target.closeTarget', {targetId}).catch(() => {}); },
    };
    return page;
  }

  const {id: extId} = await send('Extensions.loadUnpacked', {path: path.resolve(extDir)});
  return {
    extId, base: `chrome-extension://${extId}`, send, openPage, sleep,
    on(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    stderr: () => stderr,
    async close() {
      chrome.kill();
      await sleep(300);
      rmSync(profile, {recursive: true, force: true});
    },
  };
}
