import 'fake-indexeddb/auto';
import {test, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../src/store/assistant-db.ts';
import {ChatRunner} from '../src/background/chat-runner.ts';
import {systemPrompt} from '../src/agent/prompt.ts';
import {toModelMessages} from '../src/agent/history.ts';
import {DEFAULT_PROFILES} from '../src/agent/profiles.ts';
import {titleFrom} from '../src/store/title.ts';
import type {WorkerToPanel} from '../src/shared/protocol.ts';
import type {StreamPart, StreamReply} from '../src/llm/stream.ts';
import type {Message, Settings} from '../src/store/types.ts';

const SETTINGS: Settings = {ollamaUrl: 'http://localhost:11434', model: 'm'};

beforeEach(async () => { await db.openAssistantDb(`test-${crypto.randomUUID()}`); });
afterEach(() => { db.closeAssistantDb(); });

/** A gate the fake model waits on, so a test can act in the middle of a reply. */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return {promise, open};
}

interface Fake { stream: StreamReply; calls: Parameters<StreamReply>[0][] }

/** A model that yields `parts`; a gate in the list pauses there; an Error in the list is thrown. */
function fakeModel(parts: (StreamPart | {gate: Promise<void>} | Error)[]): Fake {
  const calls: Parameters<StreamReply>[0][] = [];
  const stream: StreamReply = async function* (request) {
    calls.push(request);
    for (const part of parts) {
      if (part instanceof Error) throw part;
      if ('gate' in part) {
        await Promise.race([part.gate, new Promise(resolve => request.signal.addEventListener('abort', resolve))]);
        if (request.signal.aborted) throw new DOMException('aborted', 'AbortError');
        continue;
      }
      yield part;
    }
  };
  return {stream, calls};
}

function runner(fake: Fake, settings: Settings = SETTINGS, saveEveryMs?: number) {
  const events: WorkerToPanel[] = [];
  const chat = new ChatRunner({stream: fake.stream, settings: async () => settings, emit: e => events.push(e), saveEveryMs});
  return {chat, events};
}

const send = (text: string, over: {conversationId?: string | null; requestId?: string; profileId?: string} = {}) => ({
  type: 'send' as const, requestId: over.requestId ?? 'r1', conversationId: over.conversationId ?? null, text, profileId: over.profileId ?? 'assistant',
});

const msg = (over: Partial<Message>): Message => ({
  id: crypto.randomUUID(), conversationId: 'c', role: 'user', text: 't', reasoning: '', status: 'done', createdAt: 0, ...over,
});

test('toModelMessages оставляет пользователя и законченные ответы', () => {
  const result = toModelMessages([
    msg({role: 'user', text: 'вопрос'}),
    msg({role: 'assistant', text: 'ответ', status: 'done', reasoning: 'думал'}),
    msg({role: 'assistant', text: 'част', status: 'stopped'}),
    msg({role: 'assistant', text: 'прерв', status: 'interrupted'}),
    msg({role: 'assistant', text: 'ошибка', status: 'failed'}),
    msg({role: 'assistant', text: '', status: 'done'}),
    msg({role: 'assistant', text: 'идёт', status: 'streaming'}),
  ]);
  assert.deepEqual(result, [
    {role: 'user', content: 'вопрос'}, {role: 'assistant', content: 'ответ'},
    {role: 'assistant', content: 'част'}, {role: 'assistant', content: 'прерв'},
  ]);
});

test('systemPrompt: общая часть и роль профиля', () => {
  const p = DEFAULT_PROFILES[0];
  const text = systemPrompt(p);
  assert.ok(text.includes('Ты — помощник в боковой панели браузера'));
  assert.ok(text.includes('## Роль') && text.includes(p.prompt));
  assert.ok(!systemPrompt({...p, prompt: '  '}).includes('## Роль'));
});

test('send создаёт чат и стримит ответ', async () => {
  const fake = fakeModel([{type: 'reasoning', delta: 'хм'}, {type: 'text', delta: 'Привет, '}, {type: 'text', delta: 'мир'}]);
  const {chat, events} = runner(fake);
  await chat.send(send('Скажи привет'));
  assert.deepEqual(events.map(e => e.type), ['started', 'delta', 'delta', 'delta', 'finished']);
  const deltas = events.filter(e => e.type === 'delta');
  assert.equal(deltas.at(-1)?.text, 'Привет, мир');
  assert.equal(deltas.at(-1)?.reasoning, 'хм');
  const finished = events.at(-1) as Extract<WorkerToPanel, {type: 'finished'}>;
  assert.equal(finished.message.status, 'done');
  assert.equal(finished.message.model, 'm');
  const [conversation] = await db.listConversations();
  assert.equal(conversation.title, titleFrom('Скажи привет'));
  const stored = await db.listMessages(conversation.id);
  assert.deepEqual(stored.map(m => [m.role, m.text, m.status]), [['user', 'Скажи привет', 'done'], ['assistant', 'Привет, мир', 'done']]);
  assert.equal(fake.calls[0].system, systemPrompt(DEFAULT_PROFILES[0]));
  assert.deepEqual(fake.calls[0].messages, [{role: 'user', content: 'Скажи привет'}]);
});

test('второе сообщение отправляет модели историю', async () => {
  const fake = fakeModel([{type: 'text', delta: 'ок'}]);
  const {chat, events} = runner(fake);
  await chat.send(send('раз'));
  const id = (events[0] as Extract<WorkerToPanel, {type: 'started'}>).conversation.id;
  await chat.send(send('два', {conversationId: id, requestId: 'r2'}));
  assert.deepEqual(fake.calls[1].messages, [
    {role: 'user', content: 'раз'}, {role: 'assistant', content: 'ок'}, {role: 'user', content: 'два'},
  ]);
});

test('пустое сообщение игнорируется', async () => {
  const {chat, events} = runner(fakeModel([]));
  await chat.send(send('   '));
  assert.deepEqual(events, []);
  assert.deepEqual(await db.listConversations(), []);
});

test('повторная отправка в работающий чат даёт busy', async () => {
  const g = gate();
  const {chat, events} = runner(fakeModel([{type: 'text', delta: 'а'}, {gate: g.promise}]));
  const first = chat.send(send('раз'));
  await waitFor(() => events.some(e => e.type === 'delta'));
  const id = (events[0] as Extract<WorkerToPanel, {type: 'started'}>).conversation.id;
  assert.deepEqual(chat.running(), [id]);
  await chat.send(send('два', {conversationId: id, requestId: 'r2'}));
  assert.deepEqual(events.at(-1), {type: 'busy', requestId: 'r2', conversationId: id});
  g.open(); await first;
  assert.equal((await db.listMessages(id)).length, 2);
  assert.deepEqual(chat.running(), []);
});

test('stop оставляет частичный текст', async () => {
  const g = gate();
  const {chat, events} = runner(fakeModel([{type: 'text', delta: 'начало'}, {gate: g.promise}, {type: 'text', delta: ' конец'}]));
  const done = chat.send(send('расскажи'));
  await waitFor(() => events.some(e => e.type === 'delta'));
  const id = (events[0] as Extract<WorkerToPanel, {type: 'started'}>).conversation.id;
  chat.stop(id);
  await done;
  const finished = events.at(-1) as Extract<WorkerToPanel, {type: 'finished'}>;
  assert.equal(finished.message.status, 'stopped');
  assert.equal(finished.message.text, 'начало');
  assert.equal((await db.listMessages(id))[1].status, 'stopped');
});

test('ошибка модели завершает сообщение со статусом failed', async () => {
  const {chat, events} = runner(fakeModel([new TypeError('Failed to fetch')]));
  await chat.send(send('привет'));
  const finished = events.at(-1) as Extract<WorkerToPanel, {type: 'finished'}>;
  assert.equal(finished.message.status, 'failed');
  assert.match(finished.message.error ?? '', /localhost:11434/);
});

test('модель не выбрана', async () => {
  const fake = fakeModel([{type: 'text', delta: 'x'}]);
  const {chat, events} = runner(fake, {...SETTINGS, model: ''});
  await chat.send(send('привет'));
  const finished = events.at(-1) as Extract<WorkerToPanel, {type: 'finished'}>;
  assert.equal(finished.message.status, 'failed');
  assert.match(finished.message.error ?? '', /Модель не выбрана/);
  assert.equal(fake.calls.length, 0);
});

test('удалённый профиль заменяется первым', async () => {
  const fake = fakeModel([{type: 'text', delta: 'x'}]);
  const {chat} = runner(fake);
  await chat.send(send('привет', {profileId: 'нет-такого'}));
  const [conversation] = await db.listConversations();
  assert.equal(conversation.profileId, 'assistant');
  assert.equal(fake.calls[0].system, systemPrompt(DEFAULT_PROFILES[0]));
});

test('смена профиля в существующем чате сохраняется', async () => {
  const fake = fakeModel([{type: 'text', delta: 'x'}]);
  const {chat, events} = runner(fake);
  await chat.send(send('раз'));
  const id = (events[0] as Extract<WorkerToPanel, {type: 'started'}>).conversation.id;
  await chat.send(send('два', {conversationId: id, requestId: 'r2', profileId: 'qa'}));
  assert.equal((await db.getConversation(id))?.profileId, 'qa');
  assert.equal(fake.calls[1].system, systemPrompt(DEFAULT_PROFILES[1]));
});

test('частичный текст сохраняется во время стриминга', async () => {
  const g = gate();
  const {chat, events} = runner(fakeModel([{type: 'text', delta: 'кусок'}, {gate: g.promise}]), SETTINGS, 0);
  const done = chat.send(send('привет'));
  await waitFor(() => events.some(e => e.type === 'delta'));
  const id = (events[0] as Extract<WorkerToPanel, {type: 'started'}>).conversation.id;
  await waitFor(async () => (await db.listMessages(id))[1]?.text === 'кусок');
  const assistant = (await db.listMessages(id))[1];
  assert.equal(assistant.status, 'streaming');
  g.open(); await done;
});

test('delete останавливает и удаляет чат', async () => {
  const g = gate();
  const {chat, events} = runner(fakeModel([{type: 'text', delta: 'кусок'}, {gate: g.promise}]), SETTINGS, 0);
  const done = chat.send(send('привет'));
  await waitFor(() => events.some(e => e.type === 'delta'));
  const id = (events[0] as Extract<WorkerToPanel, {type: 'started'}>).conversation.id;
  await chat.delete(id);
  g.open(); await done;
  assert.equal(await db.getConversation(id), undefined);
  assert.deepEqual(await db.listMessages(id), []);
});

async function waitFor(condition: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > ms) throw new Error('waitFor: условие не выполнилось');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
