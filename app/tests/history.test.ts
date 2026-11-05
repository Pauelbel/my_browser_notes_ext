import {test} from 'node:test';
import assert from 'node:assert/strict';
import {toModelMessages} from '../src/agent/history.ts';
import type {Message} from '../src/store/types.ts';

let t = 0;
const msg = (over: Partial<Message>): Message => ({id: crypto.randomUUID(), conversationId: 'c', role: 'user', text: '', reasoning: '', status: 'done', createdAt: t++, ...over});
const tokens = (messages: {content: string}[]) => Math.ceil(messages.reduce((s, m) => s + m.content.length, 0) / 4);

test('история укладывается в бюджет, все вопросы пользователя дословно', () => {
  const history: Message[] = [];
  for (let i = 0; i < 100; i++) {
    history.push(msg({role: 'user', text: `Вопрос ${i}: ${'в'.repeat(190)}`}));
    history.push(msg({role: 'assistant', text: `Ответ ${i}: ${'о'.repeat(2990)}`}));
  }
  const out = toModelMessages(history, 8000);
  assert.ok(tokens(out) <= 8000, `оценка ${tokens(out)}`);
  const questions = out.filter(m => m.role === 'user').map(m => m.content);
  assert.equal(questions.length, 100);
  assert.deepEqual(questions, history.filter(m => m.role === 'user').map(m => m.text));
});

test('последний ответ и все вопросы целы; старые ответы сокращаются раньше новых', () => {
  const history = [
    msg({role: 'user', text: 'первый'}), msg({role: 'assistant', text: 'а'.repeat(5000)}),
    msg({role: 'user', text: 'второй'}), msg({role: 'assistant', text: 'б'.repeat(5000)}),
    msg({role: 'user', text: 'третий'}), msg({role: 'assistant', text: 'в'.repeat(5000)}),
  ];
  const out = toModelMessages(history, 2600);
  assert.equal(out.at(-1)!.content, 'в'.repeat(5000));
  assert.match(out[1].content, /ответ сокращён/);
  assert.ok(out[1].content.length <= out[3].content.length);
  assert.deepEqual(out.filter(m => m.role === 'user').map(m => m.content), ['первый', 'второй', 'третий']);
});

test('шаги агента в истории', () => {
  const steps = [
    {id: '1', name: 'snapshot' as const, input: '', status: 'done' as const, summary: ''},
    {id: '2', name: 'click' as const, input: 'a5', status: 'done' as const, summary: ''},
  ];
  const out = toModelMessages([msg({role: 'user', text: 'удали'}), msg({role: 'assistant', text: '', status: 'interrupted', steps})]);
  assert.equal(out.length, 2);
  assert.match(out[1].content, /Шаги: snapshot · click a5 \(прервано\)/);
  const stopped = toModelMessages([msg({role: 'user', text: 'удали'}), msg({role: 'assistant', text: 'Начал.', status: 'stopped', steps})]);
  assert.match(stopped[1].content, /^Начал\.\n\n\(Шаги: snapshot · click a5 \(остановлено\)\)$/);
});
