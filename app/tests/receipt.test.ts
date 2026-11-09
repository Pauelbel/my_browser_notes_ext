import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderReceipt, type ActionReceipt} from '../src/page/receipt.ts';
import {RefRegistry} from '../src/page/refs.ts';
import {summarizeResult} from '../src/llm/stream.ts';

test('action receipt не смешивает dispatch, эффект и postcondition', () => {
  const receipt: ActionReceipt = {action: 'click', target: 'a1', dispatched: true,
    effect: {verdict: 'unattributable', signals: ['mutations', 'network']},
    postcondition: {verdict: 'unmet', details: 'текст не появился'},
    page: {revision: 7, url: 'https://example.test', changed: 'none'}};
  const line = renderReceipt(receipt);
  assert.match(line, /dispatched=true/);
  assert.match(line, /effect=unattributable/);
  assert.match(line, /postcondition=unmet/);
  assert.match(line, /page\.rev=7/);
});

test('action trace сохраняет смысловую строку и receipt, а не маркер блока страницы', () => {
  const summary = summarizeResult('<<<page-content>>>\nclick: событие отправлено\n<<<end-page-content>>>\n[action-receipt dispatched=true effect=changed]');
  assert.equal(summary, 'click: событие отправлено · [action-receipt dispatched=true effect=changed]');
});

test('ref сохраняет контекст записи виртуализированного списка', () => {
  const refs = new RefRegistry('a');
  const ref = refs.assign({kind: 'element', role: 'button', name: 'Открыть', states: [], children: [], interactive: true,
    frameId: 'f', loaderId: 'l', backendNodeId: 12, recordContext: 'Заказ 42 Иван'});
  assert.equal(refs.get(ref).recordContext, 'Заказ 42 Иван');
});
