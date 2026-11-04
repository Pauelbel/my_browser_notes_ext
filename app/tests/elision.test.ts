import {test} from 'node:test';
import assert from 'node:assert/strict';
import {elideOldPages, ELIDED} from '../src/agent/elision.ts';

const page = (n: number) => `<<<page-content>>>\nстраница ${n}\n<<<end-page-content>>>`;
const toolMsg = (value: string) => ({role: 'tool', content: [{type: 'tool-result', toolCallId: 'x', toolName: 'snapshot', output: {type: 'text', value}}]});

test('elideOldPages: три последних описания целы, старые заменены, остальное не тронуто', () => {
  const messages: any[] = [{role: 'user', content: `вопрос ${page(0)}`}, ...[1, 2, 3, 4, 5].map(n => toolMsg(page(n))), toolMsg('квитанция без страницы')];
  const out = elideOldPages(messages, 3) as any[];
  const values = out.slice(1).map(m => m.content[0].output.value);
  assert.deepEqual(values, [ELIDED, ELIDED, page(3), page(4), page(5), 'квитанция без страницы']);
  assert.equal(out[0].content, `вопрос ${page(0)}`);
  assert.equal((messages[1] as any).content[0].output.value, page(1), 'исходные сообщения не меняются');
});
