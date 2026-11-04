import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildOutline, type ONode} from '../src/page/outline.ts';
import {RefRegistry} from '../src/page/refs.ts';
import {header, pageBudget, render, renderLine} from '../src/page/render.ts';
import {diffLines, renderDiff} from '../src/page/diff.ts';
import {PageError} from '../src/page/errors.ts';
import type {Capture} from '../src/page/capture.ts';

const load = (name: string): Capture => JSON.parse(readFileSync(new URL(`./fixtures/cdp/${name}.json`, import.meta.url), 'utf8'));
const node = (over: Partial<ONode>): ONode => ({role: 'button', name: 'Ок', states: [], children: [], kind: 'element', frameId: 'F', loaderId: 'L1', backendNodeId: 5, interactive: true, ...over});
const codeOf = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as PageError).code; } return 'нет ошибки'; };

test('pageBudget', () => {
  assert.equal(pageBudget(4096), 3277);
  assert.equal(pageBudget(8192), 6554);
  assert.equal(pageBudget(32768), 26214);
  assert.equal(pageBudget(200000), 30000);
  assert.equal(pageBudget(1000), 2000);
});

test('та же нода — та же метка, другой документ — новая; чужие и устаревшие метки — ошибки', () => {
  const refs = new RefRegistry('b');
  const a = refs.assign(node({}));
  assert.equal(a, 'b1');
  assert.equal(refs.assign(node({})), 'b1');
  assert.equal(refs.assign(node({loaderId: 'L2'})), 'b2');
  assert.equal(refs.get('b1').backendNodeId, 5);
  assert.equal(codeOf(() => refs.get('a1')), 'REF_UNKNOWN');
  assert.equal(codeOf(() => refs.get('b99')), 'REF_UNKNOWN');
  refs.invalidateFrame('F', 'L2');
  assert.equal(codeOf(() => refs.get('b1')), 'REF_STALE');
  assert.equal(refs.get('b2').loaderId, 'L2');
});

test('renderLine', () => {
  const refs = new RefRegistry('a');
  const n = node({name: 'Сохранить', states: ['disabled']});
  n.ref = refs.assign(n);
  assert.equal(renderLine(n), '[a1] button "Сохранить" (disabled)');
  assert.equal(renderLine(node({role: 'textbox', name: 'Пароль', value: '••••', masked: true})), 'textbox "Пароль" = "••••" (скрыто)');
  assert.equal(renderLine(node({name: 'Сказал "да"'})), 'button "Сказал \\"да\\""');
  assert.equal(renderLine(node({kind: 'text', role: 'text', name: 'Привет', interactive: false})), 'text "Привет"');
  assert.equal(renderLine(node({role: 'textbox', name: 'x', value: 'я'.repeat(300)})).length < 230, true);
});

test('long-list: окно около экрана, уведомление «Ниже ещё», метки только у показанного', () => {
  const capture = load('long-list');
  const refs = new RefRegistry('a');
  const {roots} = buildOutline(capture);
  const result = render(roots, refs, {mode: 'interactive', window: 'near', budget: 3000, viewport: capture.viewport});
  assert.ok(result.body.length <= 3000, `длина ${result.body.length}`);
  assert.ok(result.notices.some(n => n.startsWith('Ниже ещё')), result.notices.join('\n'));
  assert.ok(result.shown.length > 5);
  for (const ref of result.shown) assert.ok(result.body.includes(`[${ref}]`));
  assert.ok(!result.body.includes('Строка 300"'));
});

test('бюджет режет дальние от экрана строки и сообщает об этом', () => {
  const capture = load('long-list');
  const {roots} = buildOutline(capture);
  const result = render(roots, new RefRegistry('a'), {mode: 'all', window: 'all', budget: 1000, viewport: capture.viewport});
  assert.ok(result.body.length <= 1000, `длина ${result.body.length}`);
  assert.ok(result.notices.some(n => n.includes('урезано')), result.notices.join('\n'));
  assert.ok(result.body.includes('Длинный список'), 'верх страницы (видимый) должен остаться');
});

test('interactive: без текста, с заголовками', () => {
  const capture = load('basic');
  const result = render(buildOutline(capture).roots, new RefRegistry('a'), {mode: 'interactive', window: 'all', budget: 5000, viewport: capture.viewport});
  assert.ok(result.body.includes('heading "Тестовая страница"'), result.body);
  assert.ok(result.body.includes('button "Изменить статус"'), result.body);
  assert.ok(!result.body.includes('Первый абзац'), result.body);
});

test('header', () => {
  const capture = load('basic');
  assert.match(header(capture), /^Тестовая страница · http:\/\/localhost:1\/basic\.html · видно 0–\d+ из \d+ px$/);
});

test('diffLines и renderDiff', () => {
  const d = diffLines(['a', '  b', 'c'], ['a', 'c', 'd']);
  assert.deepEqual(d, {added: ['d'], removed: ['b']});
  assert.equal(renderDiff(d), '+ d\n- b');
  const big = diffLines([], Array.from({length: 40}, (_, i) => `x${i}`));
  assert.match(renderDiff(big), /сильно изменилась \(40 строк\)/);
  assert.equal(renderDiff({added: [], removed: []}), '');
});

test('diffLines не считает изменением одну только смену фокуса', () => {
  assert.deepEqual(diffLines(['[a1] link "x"', '[a2] button "y" (disabled)'], ['[a1] link "x" (focused)', '[a2] button "y" (disabled, focused)']), {added: [], removed: []});
});
