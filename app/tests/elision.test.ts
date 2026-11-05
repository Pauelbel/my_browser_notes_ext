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
