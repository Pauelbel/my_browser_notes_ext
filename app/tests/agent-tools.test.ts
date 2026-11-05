import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildAgentTools, buildChatTools, CHAT_TOOLS} from '../src/agent/tools.ts';
import {agentSystemPrompt, systemPrompt} from '../src/agent/prompt.ts';
import {DEFAULT_PROFILES} from '../src/agent/profiles.ts';
import {modelContext} from '../src/llm/ollama.ts';
import type {Profile} from '../src/store/types.ts';

const [assistant, qa] = DEFAULT_PROFILES;
const json = (body: unknown) => (async () => new Response(JSON.stringify(body), {status: 200})) as unknown as typeof fetch;

test('buildChatTools: только читающие инструменты, отмеченные в профиле', () => {
  assert.deepEqual(CHAT_TOOLS, ['snapshot', 'find', 'read', 'notes_search', 'notes_read', 'console_log', 'network_log', 'page_checks']);
  const notes = {search: async () => '', read: async () => '', create: async () => '', append: async () => ''};
  assert.deepEqual(Object.keys(buildChatTools(qa, async () => { throw new Error('не нужно'); }, notes)).sort(), ['console_log', 'find', 'network_log', 'notes_read', 'notes_search', 'page_checks', 'read', 'snapshot']);
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

const fakeCtx = () => {
  const calls: string[] = [];
  const answer = (name: string) => async (args: unknown) => { calls.push(`${name} ${JSON.stringify(args)}`); return {ok: true, text: `${name} ok`}; };
  const tools = new Proxy({}, {get: (_t, name: string) => (name === 'then' ? undefined : answer(name))});
  return {
    calls,
    ctx: {
      tabs: {current: async () => tools, list: async () => 'список', open: async () => 'открыта', switch: async () => 'переключена', close: async () => 'закрыта'},
      notes: {search: async () => 'найдено', read: async () => 'заметка', create: async () => 'создана', append: async () => 'дописано'},
      ask: async () => 'ответ пользователя',
      confirmNotes: async () => false,
    } as any,
  };
};

test('buildAgentTools: действия из профиля; screenshot только при vision', () => {
  const keys = Object.keys(buildAgentTools(qa, fakeCtx().ctx));
  for (const name of ['click', 'type', 'navigate', 'tabs', 'highlight', 'ask_user', 'notes_append', 'done', 'snapshot']) assert.ok(keys.includes(name), name);
  assert.ok(!keys.includes('screenshot'));
  const noClick: Profile = {...assistant, tools: assistant.tools.filter(t => t !== 'click')};
  assert.ok(!('click' in buildAgentTools(noClick, fakeCtx().ctx)));
});

test('buildAgentTools: done возвращает итог, click идёт в текущую вкладку, отказ по заметке — USER_DECLINED', async () => {
  const {ctx, calls} = fakeCtx();
  const tools = buildAgentTools(assistant, ctx) as any;
  assert.equal(await tools.done.execute({outcome: 'success', summary: 'Готово'}, {toolCallId: '1', messages: []}), 'Готово');
  assert.equal(await tools.click.execute({ref: 'a1'}, {toolCallId: '2', messages: []}), 'click ok');
  assert.deepEqual(calls, ['click {"ref":"a1"}']);
  assert.match(await tools.notes_append.execute({id: 'n', text: 'x'}, {toolCallId: '3', messages: []}), /USER_DECLINED/);
  assert.equal(await tools.ask_user.execute({question: '?', kind: 'input'}, {toolCallId: '4', messages: []}), 'ответ пользователя');
});

test('agentSystemPrompt: правила работы, шаги пользователя, маркеры, роль', () => {
  const text = agentSystemPrompt(qa, ['click', 'done', 'ask_user']);
  for (const piece of ['done', 'takeover', '<<<page-content>>>', '<<<note>>>', qa.prompt.slice(0, 30), 'Не показывай пользователю метки', 'расширение само спросит']) assert.ok(text.includes(piece), piece);
});

test('QA-инструменты: в агенте все три, в чате console_log без reload', () => {
  const agentKeys = Object.keys(buildAgentTools(qa, fakeCtx().ctx));
  for (const name of ['console_log', 'network_log', 'page_checks']) assert.ok(agentKeys.includes(name), name);
  const notes = {search: async () => '', read: async () => '', create: async () => '', append: async () => ''};
  const chat = buildChatTools(qa, async () => { throw new Error('не нужно'); }, notes) as any;
  for (const name of ['console_log', 'network_log', 'page_checks']) assert.ok(name in chat, name);
  assert.ok(!('reload' in chat.console_log.inputSchema.shape));
  assert.ok('reload' in (buildAgentTools(qa, fakeCtx().ctx) as any).console_log.inputSchema.shape);
});
