import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyEvent, emptyChat, type ChatState} from '../src/ui/chat-state.ts';
import type {Conversation, Message} from '../src/store/types.ts';

const conversation: Conversation = {id: 'c1', title: 't', titleByUser: false, profileId: 'assistant', createdAt: 1, updatedAt: 1};
const user: Message = {id: 'u', conversationId: 'c1', role: 'user', text: 'привет', reasoning: '', status: 'done', createdAt: 1};
const assistant: Message = {...user, id: 'a', role: 'assistant', text: '', status: 'streaming', createdAt: 2};
const started = (requestId: string, c = conversation) => ({type: 'started' as const, requestId, conversation: c, user: {...user, conversationId: c.id}, assistant: {...assistant, conversationId: c.id}});
const inChat: ChatState = {conversationId: 'c1', pendingRequestId: null, messages: [user, assistant], running: true};

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
