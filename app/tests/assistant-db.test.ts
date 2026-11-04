import 'fake-indexeddb/auto';
import {test, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../src/store/assistant-db.ts';
import {validateProfile} from '../src/agent/profiles.ts';
import type {Message} from '../src/store/types.ts';

beforeEach(async () => { await db.openAssistantDb(`test-${crypto.randomUUID()}`); });
afterEach(() => { db.closeAssistantDb(); });

const message = (conversationId: string, over: Partial<Message> = {}): Message => ({
  id: crypto.randomUUID(), conversationId, role: 'user', text: 'привет', reasoning: '', status: 'done', createdAt: Date.now(), ...over,
});

test('listProfiles засевает два профиля по умолчанию', async () => {
  assert.deepEqual((await db.listProfiles()).map(p => p.id), ['assistant', 'qa']);
  assert.deepEqual((await db.listProfiles()).map(p => p.id), ['assistant', 'qa']);
});

test('deleteProfile не удаляет последний', async () => {
  await db.listProfiles();
  await db.deleteProfile('qa');
  await assert.rejects(db.deleteProfile('assistant'), /Нельзя удалить последний профиль/);
  assert.deepEqual((await db.listProfiles()).map(p => p.id), ['assistant']);
});

test('createConversation берёт заголовок из первого сообщения', async () => {
  const c = await db.createConversation({profileId: 'assistant', firstMessage: 'Найди  баги\nна сайте'});
  assert.equal(c.title, 'Найди баги на сайте');
  assert.equal(c.titleByUser, false);
  assert.deepEqual(await db.getConversation(c.id), c);
});

test('putMessage обновляет updatedAt и порядок listConversations', async () => {
  const a = await db.createConversation({profileId: 'assistant', firstMessage: 'a'});
  const b = await db.createConversation({profileId: 'assistant', firstMessage: 'b'});
  await db.putMessage(message(a.id, {createdAt: Date.now() + 1000}));
  const list = await db.listConversations();
  assert.deepEqual(list.map(c => c.id), [a.id, b.id]);
  assert.ok(list[0].updatedAt > b.updatedAt);
  assert.equal((await db.listMessages(a.id)).length, 1);
});

test('listMessages по возрастанию createdAt', async () => {
  const c = await db.createConversation({profileId: 'assistant', firstMessage: 'a'});
  await db.putMessage(message(c.id, {text: 'второе', createdAt: 20}));
  await db.putMessage(message(c.id, {text: 'первое', createdAt: 10}));
  assert.deepEqual((await db.listMessages(c.id)).map(m => m.text), ['первое', 'второе']);
});

test('renameConversation ставит titleByUser', async () => {
  const c = await db.createConversation({profileId: 'assistant', firstMessage: 'a'});
  await db.renameConversation(c.id, 'Своё');
  const r = await db.getConversation(c.id);
  assert.equal(r?.title, 'Своё'); assert.equal(r?.titleByUser, true);
});

test('putMessage в удалённый чат ничего не пишет', async () => {
  const c = await db.createConversation({profileId: 'assistant', firstMessage: 'a'});
  await db.putMessage(message(c.id));
  await db.deleteConversation(c.id);
  await db.putMessage(message(c.id));
  assert.equal(await db.getConversation(c.id), undefined);
  assert.deepEqual(await db.listMessages(c.id), []);
});

test('markInterrupted', async () => {
  const c = await db.createConversation({profileId: 'assistant', firstMessage: 'a'});
  await db.putMessage(message(c.id, {status: 'streaming', role: 'assistant'}));
  await db.putMessage(message(c.id, {status: 'streaming', role: 'assistant'}));
  await db.putMessage(message(c.id, {status: 'done'}));
  assert.equal(await db.markInterrupted(), 2);
  assert.deepEqual((await db.listMessages(c.id)).map(m => m.status).sort(), ['done', 'interrupted', 'interrupted']);
});

test('validateProfile', () => {
  assert.equal(typeof validateProfile({name: '  ', prompt: ''}), 'string');
  assert.equal(typeof validateProfile({name: 'я'.repeat(41), prompt: ''}), 'string');
  assert.equal(typeof validateProfile({name: 'Ок', prompt: 'п'.repeat(4001)}), 'string');
  assert.equal(validateProfile({name: 'Помощник', prompt: 'Роль'}), null);
});

test('markInterrupted сообщает о каждом затронутом чате', async () => {
  const c = await db.createConversation({profileId: 'assistant', firstMessage: 'a'});
  await db.putMessage(message(c.id, {status: 'streaming', role: 'assistant'}));
  const seen: (string | undefined)[] = [];
  const stop = db.onAssistantChange(e => seen.push(e.conversationId));
  await db.markInterrupted();
  await new Promise(resolve => setTimeout(resolve, 50));
  stop();
  assert.ok(seen.includes(c.id), `получено: ${JSON.stringify(seen)}`);
});

test('режим чата: старые записи — chat/ask, setConversationMode сохраняет', async () => {
  const c = await db.createConversation({profileId: 'assistant', firstMessage: 'a'});
  assert.equal(c.mode, 'chat');
  assert.equal(c.permission, 'ask');
  const agent = await db.createConversation({profileId: 'assistant', firstMessage: 'b', mode: 'agent', permission: 'auto'});
  assert.equal((await db.getConversation(agent.id))?.mode, 'agent');
  await db.setConversationMode(c.id, 'agent', 'auto');
  const updated = await db.getConversation(c.id);
  assert.equal(updated?.mode, 'agent');
  assert.equal(updated?.permission, 'auto');
});
