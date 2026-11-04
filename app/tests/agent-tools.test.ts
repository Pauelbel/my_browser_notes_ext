import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildChatTools, CHAT_TOOLS} from '../src/agent/tools.ts';
import {systemPrompt} from '../src/agent/prompt.ts';
import {DEFAULT_PROFILES} from '../src/agent/profiles.ts';
import {modelContext} from '../src/llm/ollama.ts';
import type {Profile} from '../src/store/types.ts';

const [assistant, qa] = DEFAULT_PROFILES;
const json = (body: unknown) => (async () => new Response(JSON.stringify(body), {status: 200})) as unknown as typeof fetch;

test('buildChatTools: только читающие инструменты, отмеченные в профиле', () => {
  assert.deepEqual(CHAT_TOOLS, ['snapshot', 'find', 'read']);
  assert.deepEqual(Object.keys(buildChatTools(qa, async () => { throw new Error('не нужно'); })).sort(), ['find', 'read', 'snapshot']);
  const noFind: Profile = {...assistant, tools: assistant.tools.filter(t => t !== 'find')};
  assert.ok(!('find' in buildChatTools(noFind, async () => { throw new Error('не нужно'); })));
});

test('buildChatTools: страница подключается только при вызове инструмента', async () => {
  let calls = 0;
  const tools = buildChatTools(assistant, async () => { calls++; return {snapshot: async () => ({ok: true, text: 'описание'}), find: async () => ({ok: true, text: ''}), read: async () => ({ok: true, text: ''})}; });
  assert.equal(calls, 0);
  const out = await (tools.snapshot as any).execute({}, {toolCallId: '1', messages: []});
  assert.equal(out, 'описание');
  assert.equal(calls, 1);
});

test('systemPrompt: с инструментами — правило о содержимом страниц, без — честное «нет доступа»', () => {
  const withTools = systemPrompt(assistant, ['snapshot', 'read']);
  assert.ok(withTools.includes('<<<page-content>>>'));
  assert.ok(withTools.includes('пока этого не умеешь'));
  assert.ok(withTools.includes('snapshot'));
  assert.ok(withTools.includes('Не показывай пользователю метки'));
  const without = systemPrompt(assistant, []);
  assert.ok(without.includes('нет доступа к страницам'));
  assert.ok(!without.includes('<<<page-content>>>'));
});

test('modelContext: из /api/ps, иначе 8192', async () => {
  assert.equal(await modelContext('http://x', 'm', json({models: [{name: 'm', context_length: 32768}]})), 32768);
  assert.equal(await modelContext('http://x', 'm', json({models: []})), 8192);
});
