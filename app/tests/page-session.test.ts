import {test} from 'node:test';
import assert from 'node:assert/strict';
import {attachTab} from '../src/page/cdp.ts';
import {PageError} from '../src/page/errors.ts';
import {createSessionManager, epochLabel} from '../src/page/session.ts';

type Listener = (...args: any[]) => void;

/** A stand-in for chrome.debugger: commands answer from `answers`, a missing answer never resolves. */
function fakeDebugger(opts: {attachError?: string; answers?: Record<string, unknown>} = {}) {
  const events: Listener[] = [], detaches: Listener[] = [];
  const calls = {attach: 0, detach: 0};
  const api = {
    attach: async () => { calls.attach++; if (opts.attachError) throw new Error(opts.attachError); },
    detach: async () => { calls.detach++; },
    sendCommand: (_target: unknown, method: string) => {
      const answers = opts.answers ?? {};
      if (method in answers) return Promise.resolve(answers[method]);
      if (method.endsWith('.enable') || method === 'Target.setAutoAttach') return Promise.resolve({});
      if (method === 'Page.getFrameTree') return Promise.resolve({frameTree: {frame: {id: 'main', url: 'https://e.x/', loaderId: 'L1'}}});
      return new Promise(() => {});
    },
    onEvent: {addListener: (l: Listener) => events.push(l), removeListener: (l: Listener) => events.splice(events.indexOf(l), 1)},
    onDetach: {addListener: (l: Listener) => detaches.push(l), removeListener: (l: Listener) => detaches.splice(detaches.indexOf(l), 1)},
  };
  return {api: api as unknown as typeof chrome.debugger, calls, fireDetach: (tabId: number, reason: string) => detaches.forEach(l => l({tabId}, reason))};
}

const code = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { assert.ok(error instanceof PageError, String(error)); return (error as PageError).code; }
  throw new Error('ожидалась ошибка');
};

test('служебная страница', async () => {
  const fake = fakeDebugger({attachError: 'Cannot access a chrome:// URL'});
  assert.equal(await code(attachTab(1, fake.api)), 'PAGE_NOT_SUPPORTED');
});

test('отключение отладчика пользователем', async () => {
  const fake = fakeDebugger({answers: {'Runtime.evaluate': {result: {}}}});
  const cdp = await attachTab(7, fake.api);
  fake.fireDetach(7, 'canceled_by_user');
  assert.match(cdp.detached ?? '', /пользователем/);
  assert.equal(await code(cdp.send('Runtime.evaluate')), 'DETACHED');
});

test('таймаут команды', async () => {
  const cdp = await attachTab(1, fakeDebugger().api);
  assert.equal(await code(cdp.send('DOM.getDocument', {}, undefined, 20)), 'TIMEOUT');
});

test('acquire дважды — одно подключение, отключение после второго release', async () => {
  const fake = fakeDebugger();
  const manager = createSessionManager({debuggerApi: fake.api, storage: null});
  const a = await manager.acquire(3);
  const b = await manager.acquire(3);
  assert.equal(a, b);
  assert.equal(fake.calls.attach, 1);
  await manager.release(a);
  assert.equal(fake.calls.detach, 0);
  await manager.release(b);
  assert.equal(fake.calls.detach, 1);
});

test('после отключения пользователем acquire подключается заново', async () => {
  const fake = fakeDebugger();
  const manager = createSessionManager({debuggerApi: fake.api, storage: null});
  const a = await manager.acquire(4);
  fake.fireDetach(4, 'canceled_by_user');
  const b = await manager.acquire(4);
  assert.notEqual(a, b);
  assert.equal(fake.calls.attach, 2);
});

test('epochLabel', () => {
  assert.equal(epochLabel(0), 'a');
  assert.equal(epochLabel(25), 'z');
  assert.equal(epochLabel(26), 'ba');
  assert.equal(epochLabel(675), 'zz');
  assert.equal(epochLabel(676), 'baa');
});
