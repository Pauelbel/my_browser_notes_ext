import {test} from 'node:test';
import assert from 'node:assert/strict';
import {elideOldPages, ELIDED} from '../src/agent/elision.ts';

const page = (n: number) => `<<<page-content>>>\nстраница ${n}\n<<<end-page-content>>>`;
const toolMsg = (value: string, toolName = 'snapshot') => ({role: 'tool', content: [{type: 'tool-result', toolCallId: 'x', toolName, output: {type: 'text', value}}]});

test('elideOldPages: три последних описания целы, старые заменены, остальное не тронуто', () => {
  const messages: any[] = [{role: 'user', content: `вопрос ${page(0)}`}, ...[1, 2, 3, 4, 5].map(n => toolMsg(page(n))), toolMsg('квитанция без страницы', 'click')];
  const out = elideOldPages(messages, 3) as any[];
  const values = out.slice(1).map(m => m.content[0].output.value);
  assert.deepEqual(values, [ELIDED, ELIDED, page(3), page(4), page(5), 'квитанция без страницы']);
  assert.equal(out[0].content, `вопрос ${page(0)}`);
  assert.equal((messages[1] as any).content[0].output.value, page(1), 'исходные сообщения не меняются');
});

import {estimateTokens, fitToContext} from '../src/agent/elision.ts';

test('estimateTokens: текст и результаты по 4 символа на токен, картинка — 1000', () => {
  const messages: any[] = [{role: 'user', content: 'a'.repeat(400)}, toolMsg('b'.repeat(800)),
    {role: 'user', content: [{type: 'text', text: 'c'.repeat(40)}, {type: 'image', image: 'x'.repeat(99999)}]}];
  assert.equal(estimateTokens(messages), 100 + 200 + 10 + 1000);
});

test('fitToContext держит порог', () => {
  const big = (n: number) => `<<<page-content>>>\\n${String(n).repeat(4000)}\\n<<<end-page-content>>>`;
  const messages: any[] = [{role: 'user', content: 'Найди баги на сайте'}];
  for (let i = 0; i < 60; i++) {
    messages.push(toolMsg(big(i % 10)));
    messages.push(toolMsg(`<<<page-content>>>\\nclick [a${i}] button "Ок": событие отправлено · реакция: страница изменилась\\nизменения:\\n+ text "${'x'.repeat(300)}"\\n<<<end-page-content>>>`, 'click'));
  }
  const out = fitToContext(messages, 32768) as any[];
  assert.ok(estimateTokens(out) <= 0.7 * 32768, `оценка ${estimateTokens(out)}`);
  assert.equal(out[0].content, 'Найди баги на сайте');
  assert.equal(out.at(-2).content[0].output.value, messages.at(-2).content[0].output.value, 'последнее описание страницы цело');
  const small: any[] = [{role: 'user', content: 'привет'}, toolMsg(big(1))];
  assert.equal(fitToContext(small, 32768), small);
});

test('сокращённая квитанция сохраняет первую строку и маркеры, пометка не повторяется', () => {
  const receipt = '<<<page-content>>>\nclick [a1] button "Ок": событие отправлено\nизменения:\n+ text "x"\n<<<end-page-content>>>';
  const messages: any[] = [{role: 'user', content: 'задача'}];
  for (let i = 0; i < 30; i++) messages.push(toolMsg(receipt, 'click'), toolMsg(`<<<page-content>>>\n${'s'.repeat(30000)}\n<<<end-page-content>>>`));
  const once = fitToContext(messages, 8192) as any[];
  const twice = fitToContext(once, 8192) as any[];
  const first = twice[1].content[0].output.value;
  assert.match(first, /^<<<page-content>>>\nclick \[a1\] button "Ок": событие отправлено \[подробности скрыты\]\n<<<end-page-content>>>$/);
  assert.equal((first.match(/подробности скрыты/g) ?? []).length, 1);
});

test('старые описания страниц скрываются всегда, даже когда история маленькая', () => {
  const page = (n: number) => `<<<page-content>>>\nстраница ${n}\n<<<end-page-content>>>`;
  const messages: any[] = [1, 2, 3, 4, 5].map(n => toolMsg(page(n)));
  const out = fitToContext(messages, 32768) as any[];
  assert.deepEqual(out.map(m => m.content[0].output.value), [ELIDED, ELIDED, page(3), page(4), page(5)]);
});

test('рассуждения старых шагов и старые пары шагов уходят, когда иначе не помещается', () => {
  const messages: any[] = [{role: 'user', content: 'задача'}];
  for (let i = 0; i < 60; i++) {
    messages.push({role: 'assistant', content: [{type: 'reasoning', text: 'р'.repeat(1500)}, {type: 'text', text: 'н'.repeat(300)}, {type: 'tool-call', toolCallId: `c${i}`, toolName: 'click', input: {ref: `a${i}`}}]});
    messages.push({role: 'tool', content: [{type: 'tool-result', toolCallId: `c${i}`, toolName: 'click', output: {type: 'text', value: `click [a${i}] ok`}}]});
  }
  const out = fitToContext(messages, 8192) as any[];
  assert.ok(estimateTokens(out) <= 0.7 * 8192, `оценка ${estimateTokens(out)}`);
  assert.equal(out[0].content, 'задача');
  const calls = out.flatMap(m => (Array.isArray(m.content) ? m.content : []).filter((p: any) => p.type === 'tool-call').map((p: any) => p.toolCallId));
  const results = out.flatMap(m => (m.role === 'tool' ? m.content : []).map((p: any) => p.toolCallId));
  assert.deepEqual(calls, results, 'у каждого вызова остался свой результат');
  assert.ok(calls.includes('c59'), 'последний шаг на месте');
});

test('результаты QA-проверок не скрываются на обычной ступени: это доказательства для отчёта', () => {
  const page = (n: number) => `<<<page-content>>>\nстраница ${n}\n<<<end-page-content>>>`;
  const messages: any[] = [toolMsg(page(1)), toolMsg('ошибка ×3 · Не удалось загрузить настройки', 'console_log'), toolMsg('GET 404', 'network_log'),
    toolMsg('Битые картинки: 1', 'page_checks'), toolMsg('скриншот сделан', 'screenshot'), toolMsg(page(2)), toolMsg(page(3))];
  const out = fitToContext(messages, 32768) as any[];
  assert.equal(out[1].content[0].output.value, 'ошибка ×3 · Не удалось загрузить настройки');
  assert.equal(out[2].content[0].output.value, 'GET 404');
});
