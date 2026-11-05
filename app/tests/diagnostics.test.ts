import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Diagnostics, summarizeConsole, summarizeNetwork} from '../src/page/diagnostics.ts';

function fakeCdp() {
  const handlers = new Set<(m: string, p: any, s?: string) => void>();
  return {
    cdp: {on: (h: any) => { handlers.add(h); return () => handlers.delete(h); }, send: async () => ({}), detached: null} as any,
    emit: (method: string, params: object, sessionId?: string) => handlers.forEach(h => h(method, params, sessionId)),
  };
}
const consoleCall = (type: string, text: string) => ({type, args: [{type: 'string', value: text}], stackTrace: {callFrames: [{url: 'http://x/app.js', lineNumber: 41}]}});

test('одинаковые сообщения группируются, лимит записей', () => {
  const {cdp, emit} = fakeCdp();
  const d = new Diagnostics(cdp, 300);
  for (let i = 0; i < 1000; i++) emit('Runtime.consoleAPICalled', consoleCall('error', 'Не удалось загрузить настройки'));
  const text = summarizeConsole({...d.console(), since: d.since}, 'all');
  assert.match(text, /×300/);
  assert.match(text, /700/);
  assert.equal((text.match(/Не удалось загрузить настройки/g) ?? []).length, 1);
  assert.match(text, /app\.js:42/);
});

test('сводка говорит, с какого момента собрано', () => {
  const {cdp} = fakeCdp();
  const d = new Diagnostics(cdp);
  const text = summarizeConsole({...d.console(), since: d.since}, 'all');
  assert.match(text, /видна с \d\d:\d\d:\d\d/);
  assert.match(text, /reload: true/);
  assert.match(text, /ошибок нет/i);
});

test('консоль: error, warning, исключения и Log; обычный log не попадает', () => {
  const {cdp, emit} = fakeCdp();
  const d = new Diagnostics(cdp);
  emit('Runtime.consoleAPICalled', consoleCall('log', 'просто лог'));
  emit('Runtime.consoleAPICalled', consoleCall('warning', 'устарело'));
  emit('Runtime.exceptionThrown', {exceptionDetails: {text: 'Uncaught', exception: {description: 'TypeError: x is undefined'}, url: 'http://x/a.js', lineNumber: 9}});
  emit('Log.entryAdded', {entry: {level: 'error', source: 'network', text: 'Failed to load resource: 404', url: 'http://x/nope.png'}});
  emit('Log.entryAdded', {entry: {level: 'info', source: 'other', text: 'инфо'}});
  const entries = d.console().entries;
  assert.deepEqual(entries.map(e => e.text), ['устарело', 'TypeError: x is undefined', 'Failed to load resource: 404']);
  assert.ok(!summarizeConsole({...d.console(), since: d.since}, 'error').includes('устарело'));
});

test('сеть: 404 и ошибка сети, отменённые не считаются, группировка по адресу без query', () => {
  const {cdp, emit} = fakeCdp();
  const d = new Diagnostics(cdp);
  for (const [id, url] of [['1', 'http://x/api/items?page=1'], ['2', 'http://x/api/items?page=2'], ['3', 'http://127.0.0.1:9/x'], ['4', 'http://x/slow']]) {
    emit('Network.requestWillBeSent', {requestId: id, request: {method: 'GET', url}, type: 'Fetch'});
  }
  emit('Network.responseReceived', {requestId: '1', response: {status: 404, url: 'http://x/api/items?page=1'}, type: 'Fetch'});
  emit('Network.responseReceived', {requestId: '2', response: {status: 404, url: 'http://x/api/items?page=2'}, type: 'Fetch'});
  emit('Network.loadingFailed', {requestId: '3', errorText: 'net::ERR_CONNECTION_REFUSED', type: 'Fetch'});
  emit('Network.loadingFailed', {requestId: '4', errorText: 'net::ERR_ABORTED', canceled: true, type: 'Fetch'});
  const text = summarizeNetwork({...d.network(), since: d.since});
  assert.match(text, /GET 404 ×2 · http:\/\/x\/api\/items/);
  assert.match(text, /ERR_CONNECTION_REFUSED/);
  assert.ok(!text.includes('/slow'));
});

test('запросы самой проверки не попадают в журнал сети', () => {
  const {cdp, emit} = fakeCdp();
  const d = new Diagnostics(cdp);
  d.mute(['http://x/missing']);
  emit('Network.requestWillBeSent', {requestId: 'h', request: {method: 'HEAD', url: 'http://x/p?1'}, type: 'Fetch'});
  emit('Network.responseReceived', {requestId: 'h', response: {status: 405, url: 'http://x/p?1'}});
  emit('Network.requestWillBeSent', {requestId: 'g', request: {method: 'GET', url: 'http://x/missing'}, type: 'Fetch'});
  emit('Network.responseReceived', {requestId: 'g', response: {status: 404, url: 'http://x/missing'}});
  emit('Log.entryAdded', {entry: {level: 'error', source: 'network', text: 'Failed to load resource: 404', url: 'http://x/missing'}});
  assert.deepEqual(d.network().entries, []);
  assert.deepEqual(d.console().entries, []);
});

test('у записей есть страница; служебная таблица запросов не растёт; длинный текст режется сразу', () => {
  const {cdp, emit} = fakeCdp();
  const d = new Diagnostics(cdp);
  emit('Page.frameNavigated', {frame: {id: 'M', url: 'http://x/a'}});
  emit('Runtime.consoleAPICalled', consoleCall('error', 'я'.repeat(100000)));
  emit('Page.frameNavigated', {frame: {id: 'M', url: 'http://x/b'}});
  emit('Runtime.consoleAPICalled', consoleCall('error', 'вторая'));
  const [first, second] = d.console().entries;
  assert.equal(first.page, 'http://x/a');
  assert.equal(second.page, 'http://x/b');
  assert.ok(first.text.length <= 300);
  for (let i = 0; i < 3000; i++) {
    emit('Network.requestWillBeSent', {requestId: String(i), request: {method: 'GET', url: `http://x/${i}`}});
    if (i % 2) emit('Network.loadingFinished', {requestId: String(i)});
  }
  assert.ok(d.pendingRequests() <= 1000, `в таблице ${d.pendingRequests()}`);
  assert.match(summarizeConsole({...d.console(), since: d.since}, 'all'), /http:\/\/x\/b/);
});

test('сообщения до подключения отмечены; без предупреждений — «Предупреждений нет»', () => {
  const {cdp, emit} = fakeCdp();
  const d = new Diagnostics(cdp);
  emit('Runtime.consoleAPICalled', {...consoleCall('error', 'старая'), timestamp: Date.now() - 60000});
  assert.equal(d.console().entries[0].before, true);
  assert.match(summarizeConsole({...d.console(), since: d.since}, 'all'), /до подключения/);
  assert.match(summarizeConsole({...d.console(), since: d.since}, 'warning'), /Предупреждений нет/);
});
