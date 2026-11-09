import {test} from 'node:test';
import assert from 'node:assert/strict';
import {budgets, measureContext} from '../src/agent/budgets.ts';

test('бюджеты из одного счёта окна: системный промпт, инструменты и запас на ответ вычтены', () => {
  const b = budgets({context: 16384, system: 'с'.repeat(3000), tools: {a: {description: 'о'.repeat(600)}, b: {description: 'о'.repeat(600)}}, agent: true});
  assert.ok(b.run + 2048 + 1000 + 400 <= 16384, JSON.stringify(b));
  assert.ok(b.history <= b.run * 0.3, `история агента ${b.history} при окне хода ${b.run}`);
  const chat = budgets({context: 16384, system: 'с'.repeat(3000), tools: {}, agent: false});
  assert.ok(chat.history > b.history);
});

test('индикатор контекста учитывает системный промпт, инструменты и отправляемую историю', () => {
  const usage = measureContext({context: 8192, system: 'с'.repeat(300), tools: {click: {description: 'к'.repeat(120)}},
    messages: [{content: 'п'.repeat(600)}, {content: [{type: 'text', text: 'x'.repeat(90)}]}]});
  assert.equal(usage.limit, 8192);
  assert.equal(usage.used, usage.system + usage.tools + usage.history);
  assert.ok(usage.system >= 100 && usage.tools >= 100 && usage.history >= 200, JSON.stringify(usage));
});
