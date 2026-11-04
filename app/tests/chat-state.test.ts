import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyEvent, emptyChat, type ChatState} from '../src/ui/chat-state.ts';
import type {Conversation, Message} from '../src/store/types.ts';

const conversation: Conversation = {id: 'c1', title: 't', titleByUser: false, profileId: 'assistant', mode: 'chat', permission: 'ask', createdAt: 1, updatedAt: 1};
const user: Message = {id: 'u', conversationId: 'c1', role: 'user', text: 'привет', reasoning: '', status: 'done', createdAt: 1};
const assistant: Message = {...user, id: 'a', role: 'assistant', text: '', status: 'streaming', createdAt: 2};
const started = (requestId: string, c = conversation) => ({type: 'started' as const, requestId, conversation: c, user: {...user, conversationId: c.id}, assistant: {...assistant, conversationId: c.id}});
const inChat: ChatState = {conversationId: 'c1', pendingRequestId: null, messages: [user, assistant], running: true, prompts: []};

test('started своего запроса усыновляет новый чат', () => {
  const s = applyEvent({...emptyChat, pendingRequestId: 'r1'}, started('r1'));
  assert.equal(s.conversationId, 'c1');
  assert.deepEqual(s.messages.map(m => m.id), ['u', 'a']);
  assert.equal(s.running, true);
  assert.equal(s.pendingRequestId, null);
});

test('started чужого запроса игнорируется', () => {
  const before = {...emptyChat, pendingRequestId: 'r1'};
  assert.deepEqual(applyEvent(before, started('r2')), before);
});

test('delta заменяет текст сообщения целиком', () => {
  let s = applyEvent(inChat, {type: 'delta', conversationId: 'c1', messageId: 'a', text: 'При', reasoning: ''});
  s = applyEvent(s, {type: 'delta', conversationId: 'c1', messageId: 'a', text: 'Привет', reasoning: 'r'});
  assert.equal(s.messages[1].text, 'Привет');
  assert.equal(s.messages[1].reasoning, 'r');
});

test('finished снимает running и ставит итоговое сообщение', () => {
  const s = applyEvent(inChat, {type: 'finished', conversationId: 'c1', message: {...assistant, text: 'Готово', status: 'done'}});
  assert.equal(s.running, false);
  assert.equal(s.messages[1].text, 'Готово');
  assert.equal(s.messages[1].status, 'done');
});

test('события другого чата не меняют состояние', () => {
  assert.deepEqual(applyEvent(inChat, {type: 'delta', conversationId: 'c2', messageId: 'a', text: 'x', reasoning: ''}), inChat);
  assert.deepEqual(applyEvent(inChat, {type: 'finished', conversationId: 'c2', message: assistant}), inChat);
  assert.deepEqual(applyEvent(inChat, started('r9', {...conversation, id: 'c2'})), inChat);
});

test('busy своего запроса снимает pendingRequestId', () => {
  const s = applyEvent({...inChat, running: false, pendingRequestId: 'r5'}, {type: 'busy', requestId: 'r5', conversationId: 'c1'});
  assert.equal(s.pendingRequestId, null);
});

test('running ставит флаг, если текущий чат отвечает', () => {
  const idle = {...inChat, running: false};
  assert.equal(applyEvent(idle, {type: 'running', conversationIds: ['c1']}).running, true);
  assert.equal(applyEvent(idle, {type: 'running', conversationIds: ['c2']}).running, false);
});

test('running без текущего чата помечает его зависший ответ прерванным', () => {
  const s = applyEvent(inChat, {type: 'running', conversationIds: []});
  assert.equal(s.running, false);
  assert.equal(s.messages[1].status, 'interrupted');
  assert.equal(s.messages[0].status, 'done');
});

test('deleted текущего чата очищает экран', () => {
  assert.deepEqual(applyEvent(inChat, {type: 'deleted', conversationId: 'c1'}), emptyChat);
  assert.deepEqual(applyEvent(inChat, {type: 'deleted', conversationId: 'c2'}), inChat);
});

test('step добавляет и обновляет шаг текущего сообщения', () => {
  const step = {id: 's1', name: 'snapshot' as const, input: '', status: 'running' as const, summary: ''};
  let s = applyEvent(inChat, {type: 'step', conversationId: 'c1', messageId: 'a', step});
  assert.deepEqual(s.messages[1].steps, [step]);
  s = applyEvent(s, {type: 'step', conversationId: 'c1', messageId: 'a', step: {...step, status: 'done', summary: 'ок'}});
  assert.equal(s.messages[1].steps?.length, 1);
  assert.equal(s.messages[1].steps?.[0].status, 'done');
  assert.deepEqual(applyEvent(inChat, {type: 'step', conversationId: 'c2', messageId: 'a', step}), inChat);
});

const ask = (id: string, conversationId = 'c1') => ({id, conversationId, kind: 'confirm' as const, text: 'Нажать «Удалить»?'});

test('вопросы: свой чат добавляется, чужой нет; prompt-closed убирает; running заменяет список своими', () => {
  let s = applyEvent(inChat, {type: 'prompt', prompt: ask('p1')});
  assert.deepEqual(s.prompts.map(p => p.id), ['p1']);
  assert.deepEqual(applyEvent(inChat, {type: 'prompt', prompt: ask('p2', 'c2')}).prompts, []);
  s = applyEvent(s, {type: 'prompt-closed', promptId: 'p1'});
  assert.deepEqual(s.prompts, []);
  s = applyEvent(inChat, {type: 'running', conversationIds: ['c1'], prompts: [ask('p3'), ask('p4', 'c2')]});
  assert.deepEqual(s.prompts.map(p => p.id), ['p3']);
});
