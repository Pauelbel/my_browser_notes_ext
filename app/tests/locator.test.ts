import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {inspectLocator, verifyCdpLocator} from '../src/page/locator.ts';
import {detectLocatorIntent, extractLocatorAnswer, wrapLocatorAnswer} from '../src/agent/locator-intent.ts';
import {pageText} from '../src/page/tools.ts';

test('тип локатора определяется из запроса пользователя, включая русские формулировки', () => {
  assert.equal(detectLocatorIntent('напиши xpath для кнопки'), 'xpath');
  assert.equal(detectLocatorIntent('дай CSS selector'), 'css');
  assert.equal(detectLocatorIntent('нужен ID элемента'), 'id');
  assert.equal(detectLocatorIntent('покажи data-testid'), 'testid');
  assert.equal(detectLocatorIntent('найди самый стабильный локатор'), 'best');
  assert.equal(detectLocatorIntent('подсвети кнопку'), null);
});

test('машинная граница извлекает только канонический ответ локатора', () => {
  const answer = 'XPath:\n```xpath\n//*[@id=\'save\']\n```';
  assert.equal(extractLocatorAnswer(`мусор\n${wrapLocatorAnswer(answer)}\nещё мусор`), answer);
  assert.equal(extractLocatorAnswer(pageText('Локатор', wrapLocatorAnswer(answer), [])), answer);
});

test('inspectLocator: XPath учитывает вложенный текст и проверяется в DOM', () => {
  const dom = new JSDOM('<main><button aria-label="Подписаться на канал"><span>Подписаться</span></button></main>');
  const button = dom.window.document.querySelector('button')!;
  const info = inspectLocator.call(button);
  assert.equal(info.css, 'button[aria-label="Подписаться на канал"]');
  assert.equal(info.xpath, "//button[@aria-label='Подписаться на канал']");
  assert.ok(info.candidates.some(candidate => candidate.kind === 'xpath' && candidate.value === info.xpath));
  assert.equal(dom.window.document.evaluate(info.xpath!, dom.window.document, null, dom.window.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE).snapshotItem(0), button);
});

test('inspectLocator: нестабильный id уступает data-testid в стабильных CSS/XPath', () => {
  const dom = new JSDOM('<main><button id="react-123456" data-testid="save">Сохранить</button></main>');
  const info = inspectLocator.call(dom.window.document.querySelector('button')!);
  assert.equal(info.css, 'button[data-testid="save"]');
  assert.equal(info.xpath, "//button[@data-testid='save']");
  assert.equal(info.candidates.find(candidate => candidate.kind === 'id')?.stability, 'low');
});

test('inspectLocator: без атрибутов использует normalize-space(.) вместо text()', () => {
  const dom = new JSDOM('<main><button><span>Подписаться</span></button></main>');
  const button = dom.window.document.querySelector('button')!;
  const info = inspectLocator.call(button);
  assert.equal(info.xpath, "//button[normalize-space(.)='Подписаться']");
});

test('inspectLocator: одинаковая aria-label уточняется через ближайшего уникального предка', () => {
  const dom = new JSDOM('<main><section id="active"><button aria-label="Сохранить">A</button></section><section id="hidden"><button aria-label="Сохранить">B</button></section></main>');
  const button = dom.window.document.querySelector('#active button')!;
  const info = inspectLocator.call(button);
  assert.equal(info.css, '#active button[aria-label="Сохранить"]');
  assert.equal(info.xpath, "//*[@id='active']//button[@aria-label='Сохранить']");
  assert.equal(dom.window.document.querySelectorAll(info.css).length, 1);
  assert.equal(dom.window.document.evaluate(info.xpath!, dom.window.document, null, dom.window.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE).snapshotLength, 1);
});

test('inspectLocator: для Shadow DOM не обещает обычный XPath', () => {
  const dom = new JSDOM('<x-box></x-box>');
  const shadow = dom.window.document.querySelector('x-box')!.attachShadow({mode: 'open'});
  shadow.innerHTML = '<button data-testid="save">Сохранить</button>';
  const info = inspectLocator.call(shadow.querySelector('button')!);
  assert.equal(info.scope, 'shadow-root');
  assert.equal(info.xpath, null);
  assert.equal(info.css, 'button[data-testid="save"]');
});

test('verifyCdpLocator: принимает только одно совпадение с тем же backendNodeId и освобождает поиск', async () => {
  const calls: string[] = [];
  const send = async <T>(method: string): Promise<T> => {
    calls.push(method);
    if (method === 'DOM.performSearch') return {searchId: 's', resultCount: 1} as T;
    if (method === 'DOM.getSearchResults') return {nodeIds: [7]} as T;
    if (method === 'DOM.describeNode') return {node: {backendNodeId: 42}} as T;
    return {} as T;
  };
  assert.equal(await verifyCdpLocator(send, '//button', 42), true);
  assert.equal(calls[0], 'DOM.getDocument');
  assert.equal(calls.at(-1), 'DOM.discardSearchResults');
});

test('verifyCdpLocator: неоднозначный поиск не считается проверенным', async () => {
  const calls: string[] = [];
  const send = async <T>(method: string): Promise<T> => {
    calls.push(method);
    if (method === 'DOM.performSearch') return {searchId: 's', resultCount: 2} as T;
    return {} as T;
  };
  assert.equal(await verifyCdpLocator(send, '//button', 42), false);
  assert.deepEqual(calls, ['DOM.getDocument', 'DOM.performSearch', 'DOM.discardSearchResults']);
});
