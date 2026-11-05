import {test} from 'node:test';
import assert from 'node:assert/strict';
import {toModelMessages} from '../src/agent/history.ts';
import type {Message} from '../src/store/types.ts';

let t = 0;
const msg = (over: Partial<Message>): Message => ({id: crypto.randomUUID(), conversationId: 'c', role: 'user', text: '', reasoning: '', status: 'done', createdAt: t++, ...over});
const tokens = (messages: {content: unknown}[]) => Math.ceil(messages.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0) / 4);

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
  assert.match(out[1].content as string, /ответ сокращён/);
  assert.ok(out[1].content.length <= out[3].content.length);
  assert.deepEqual(out.filter(m => m.role === 'user').map(m => m.content), ['первый', 'второй', 'третий']);
});

const parts = (m: any) => (Array.isArray(m.content) ? m.content : []);

test('шаги в истории — настоящие вызовы инструментов с результатами, а не текст ответа', () => {
  // A steps line in the reply's text taught the model to write «(Шаги: clear_highlights)» instead of calling the tool.
  const steps = [
    {id: '1', name: 'snapshot' as const, input: '', args: {mode: 'all'}, status: 'done' as const, summary: 'описание'},
    {id: '2', name: 'highlight' as const, input: '"29 комментариев"', args: {text: '29 комментариев'}, status: 'done' as const, summary: 'выделено мест: 1 (цвет yellow)'},
  ];
  const out = toModelMessages([msg({role: 'user', text: 'подсвети'}), msg({role: 'assistant', text: 'Подсветил.', steps}), msg({role: 'user', text: 'сними'})]) as any[];
  assert.deepEqual(out.map(m => m.role), ['user', 'assistant', 'tool', 'assistant', 'user']);
  assert.deepEqual(parts(out[1]), [
    {type: 'tool-call', toolCallId: '1', toolName: 'snapshot', input: {mode: 'all'}},
    {type: 'tool-call', toolCallId: '2', toolName: 'highlight', input: {text: '29 комментариев'}},
  ]);
  assert.deepEqual(parts(out[2]).map((p: any) => [p.toolCallId, p.toolName, p.output.value]), [['1', 'snapshot', 'описание'], ['2', 'highlight', 'выделено мест: 1 (цвет yellow)']]);
  assert.equal(out[3].content, 'Подсветил.');
  assert.ok(!JSON.stringify(out).includes('Шаги'));
});

test('прерванный ответ: незавершённый шаг получает пометку, конец ответа помечен', () => {
  const steps = [
    {id: '1', name: 'snapshot' as const, input: '', status: 'done' as const, summary: ''},
    {id: '2', name: 'click' as const, input: 'a5', status: 'running' as const, summary: ''},
  ];
  const out = toModelMessages([msg({role: 'user', text: 'удали'}), msg({role: 'assistant', text: '', status: 'interrupted', steps})]) as any[];
  assert.deepEqual(out.map(m => m.role), ['user', 'assistant', 'tool', 'assistant']);
  // Steps saved before arguments were kept are called with no arguments.
  assert.deepEqual(parts(out[1])[1], {type: 'tool-call', toolCallId: '2', toolName: 'click', input: {}});
  assert.equal(parts(out[2])[1].output.value, 'не завершён: ответ прерван');
  assert.equal(out[3].content, '(ответ прерван)');
  const stopped = toModelMessages([msg({role: 'user', text: 'удали'}), msg({role: 'assistant', text: 'Начал.', status: 'stopped', steps})]) as any[];
  assert.equal(stopped.at(-1).content, 'Начал.\n\n(остановлено пользователем)');
});

test('из длинного списка шагов — первый и последние', () => {
  const steps = Array.from({length: 60}, (_, i) => ({id: String(i), name: 'click' as const, input: `a${i}`, status: 'done' as const, summary: 'ок'}));
  const out = toModelMessages([msg({role: 'user', text: 'делай'}), msg({role: 'assistant', text: 'Готово.', steps})]) as any[];
  const calls = parts(out[1]).filter((p: any) => p.type === 'tool-call').map((p: any) => p.toolCallId);
  assert.equal(calls.length, 20);
  assert.deepEqual([calls[0], calls[1], calls.at(-1)], ['0', '41', '59']);
  assert.ok(parts(out[1]).some((p: any) => p.type === 'text' && p.text.includes('пропущено шагов: 40')));
  assert.equal(parts(out[2]).length, 20);
});

test('бюджет: шаги старых ответов уходят после их текста, последний ответ цел', () => {
  const steps = (k: string) => Array.from({length: 20}, (_, i) => ({id: `${k}${i}`, name: 'read' as const, input: '', status: 'done' as const, summary: 'т'.repeat(400)}));
  const history = [
    msg({role: 'user', text: 'первый'}), msg({role: 'assistant', text: 'а'.repeat(2000), steps: steps('a')}),
    msg({role: 'user', text: 'второй'}), msg({role: 'assistant', text: 'б'.repeat(2000), steps: steps('b')}),
  ];
  const size = (ms: any[]) => Math.ceil(ms.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0) / 4);
  const out = toModelMessages(history, 4000) as any[];
  assert.ok(size(out) <= 4000, `оценка ${size(out)}`);
  assert.deepEqual(out.filter(m => m.role === 'user').map(m => m.content), ['первый', 'второй']);
  assert.equal(out.at(-1).content, 'б'.repeat(2000));
  assert.equal(out.filter(m => m.role === 'tool').length, 1, 'шаги старого ответа должны уйти');
  // Every call keeps its result: a tool message follows each assistant message with calls.
  out.forEach((m, i) => { if (parts(m).some((p: any) => p.type === 'tool-call')) assert.equal(out[i + 1]?.role, 'tool'); });
});
