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

const SETTINGS: Settings = {ollamaUrl: 'http://localhost:11434', model: 'm', siteRules: {}, border: true};

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

test('пока идёт ответ, worker получает сердцебиение, после — нет', async () => {
  const g = gate();
  let beats = 0;
  const events: WorkerToPanel[] = [];
  const chat = new ChatRunner({
    stream: fakeModel([{type: 'text', delta: 'а'}, {gate: g.promise}]).stream,
    settings: async () => SETTINGS, emit: e => events.push(e), heartbeat: () => { beats++; }, heartbeatMs: 10,
  });
  const done = chat.send(send('привет'));
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.ok(beats >= 2, `сердцебиений: ${beats}`);
  g.open(); await done;
  const after = beats;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(beats, after);
});

test('delete сообщает панелям deleted', async () => {
  const {chat, events} = runner(fakeModel([{type: 'text', delta: 'x'}]));
  await chat.send(send('привет'));
  const id = (events[0] as Extract<WorkerToPanel, {type: 'started'}>).conversation.id;
  await chat.delete(id);
  assert.deepEqual(events.at(-1), {type: 'deleted', conversationId: id});
});

test('delete до начала ответа не даёт started и не пишет сообщений', async () => {
  const conversation = await db.createConversation({profileId: 'assistant', firstMessage: 'было'});
  const g = gate();
  const events: WorkerToPanel[] = [];
  const chat = new ChatRunner({
    stream: fakeModel([{type: 'text', delta: 'x'}]).stream,
    settings: async () => { await g.promise; return SETTINGS; }, emit: e => events.push(e),
  });
  const done = chat.send(send('ещё', {conversationId: conversation.id}));
  const deleting = chat.delete(conversation.id);
  g.open(); await done; await deleting;
  assert.deepEqual(events.map(e => e.type), ['deleted']);
  assert.equal(await db.getConversation(conversation.id), undefined);
  assert.deepEqual(await db.listMessages(conversation.id), []);
  assert.deepEqual(chat.running(), []);
});

/** A page whose tools answer fixed text, counting how often it is opened and released. */
function fakePage(text = 'Тестовая страница · http://x\n<<<page-content>>>\nbutton "Ок"\n<<<end-page-content>>>') {
  const counts = {opened: 0, released: 0};
  const page = async (_tabId: number) => {
    counts.opened++;
    const answer = async () => ({ok: true, text});
    return {tools: {snapshot: answer, find: answer, read: answer} as any, release: async () => { counts.released++; }};
  };
  return {page, counts};
}

/** A model that calls the snapshot tool through the tool set it was given, then answers. */
function toolCallingModel(answer = 'На странице кнопка «Ок».') {
  const calls: Parameters<StreamReply>[0][] = [];
  const stream: StreamReply = async function* (request) {
    calls.push(request);
    yield {type: 'tool-call', id: 't1', name: 'snapshot', input: {}};
    const output = await (request.tools!.snapshot as any).execute({}, {toolCallId: 't1', messages: []});
    yield {type: 'tool-result', id: 't1', ok: !String(output).startsWith('ошибка'), summary: String(output).split('\n')[0]};
    yield {type: 'text', delta: answer};
  };
  return {stream, calls};
}

test('шаги инструментов сохраняются', async () => {
  const model = toolCallingModel();
  const {page, counts} = fakePage();
  const events: WorkerToPanel[] = [];
  const chat = new ChatRunner({stream: model.stream, settings: async () => SETTINGS, emit: e => events.push(e), page});
  await chat.send({...send('что на странице?'), tabId: 5});
  const finished = events.at(-1) as Extract<WorkerToPanel, {type: 'finished'}>;
  assert.equal(finished.message.status, 'done');
  assert.equal(finished.message.steps?.length, 1);
  assert.equal(finished.message.steps?.[0].status, 'done');
  assert.equal(events.filter(e => e.type === 'step').length, 2);
  assert.equal(model.calls[0].maxSteps, 5);
  assert.deepEqual(Object.keys(model.calls[0].tools ?? {}).sort(), ['find', 'read', 'snapshot']);
  assert.equal(counts.opened, 1);
  const stored = await db.listMessages(finished.conversationId);
  assert.equal(stored[1].steps?.[0].name, 'snapshot');
});

test('ошибка инструмента не роняет ответ', async () => {
  const model = toolCallingModel('Не смог прочитать страницу.');
  const {page} = fakePage('ошибка DETACHED: Отладка отключена пользователем.');
  const events: WorkerToPanel[] = [];
  const chat = new ChatRunner({stream: model.stream, settings: async () => SETTINGS, emit: e => events.push(e), page});
  await chat.send({...send('что на странице?'), tabId: 5});
  const finished = events.at(-1) as Extract<WorkerToPanel, {type: 'finished'}>;
  assert.equal(finished.message.status, 'done');
  assert.equal(finished.message.steps?.[0].status, 'error');
});

test('сессия страницы отпускается после ответа и после ошибки модели', async () => {
  const {page, counts} = fakePage();
  const ok = new ChatRunner({stream: toolCallingModel().stream, settings: async () => SETTINGS, emit: () => {}, page});
  await ok.send({...send('раз'), tabId: 5});
  assert.equal(counts.released, 1);
  const failing: StreamReply = async function* (request) {
    await (request.tools!.snapshot as any).execute({}, {toolCallId: 't', messages: []});
    throw new TypeError('Failed to fetch');
  };
  const bad = new ChatRunner({stream: failing, settings: async () => SETTINGS, emit: () => {}, page});
  await bad.send({...send('два', {requestId: 'r2'}), tabId: 5});
  assert.equal(counts.released, 2);
});

test('без tabId инструменты не открывают страницу', async () => {
  const model = toolCallingModel();
  const {page, counts} = fakePage();
  const events: WorkerToPanel[] = [];
  const chat = new ChatRunner({stream: model.stream, settings: async () => SETTINGS, emit: e => events.push(e), page});
  await chat.send({...send('что на странице?'), tabId: null});
  assert.equal(counts.opened, 0);
  const finished = events.at(-1) as Extract<WorkerToPanel, {type: 'finished'}>;
  assert.equal(finished.message.steps?.[0].status, 'error');
});

// ——— Agent mode ———

/** A tabs API stand-in for AgentTabs. */
const fakeTabsApi = () => ({
  get: async (id: number) => ({id, title: `вкладка ${id}`, url: 'http://x/'}), create: async () => ({id: 99}), update: async () => ({}),
  remove: async () => {}, group: async () => 1, onCreated: {addListener() {}, removeListener() {}},
}) as unknown as typeof chrome.tabs;

/** Page tools whose click asks the gate as a dangerous click would, then reports what happened. */
function fakeAgentPage() {
  const log: string[] = [];
  const openTab = async (_tabId: number, gate: any) => {
    const tools = {
      snapshot: async () => ({ok: true, text: '<<<page-content>>>\n[a1] button "Удалить"\n<<<end-page-content>>>'}),
      click: async ({ref}: {ref: string}) => {
        const answer = await gate.check({action: 'click', ref, role: 'button', name: 'Удалить', category: 'delete', site: 'example.com', url: 'https://example.com/'});
        log.push(`click ${answer.decision}`);
        return answer.decision === 'allow' ? {ok: true, text: 'click: событие отправлено'} : {ok: false, text: 'ошибка USER_DECLINED: отказано'};
      },
      border: async () => {},
    };
    return {tools: tools as any, release: async () => { log.push('release'); }};
  };
  return {openTab, log};
}

/** A model that calls the given tools in order, then `done` (unless told not to). */
function agentModel(calls: {name: string; input: object}[], opts: {done?: boolean; loopForever?: boolean} = {}) {
  const requests: Parameters<StreamReply>[0][] = [];
  const stream: StreamReply = async function* (request) {
    requests.push(request);
    const run = async function* (name: string, input: object, id: string) {
      yield {type: 'tool-call' as const, id, name, input};
      const output = await (request.tools![name] as any).execute(input, {toolCallId: id, messages: []});
      yield {type: 'tool-result' as const, id, ok: !String(output).startsWith('ошибка'), summary: String(output).split('\n')[0]};
      yield {type: 'step' as const};
    };
    if (opts.loopForever) {
      for (let i = 0; i < request.maxSteps!; i++) yield* run('snapshot', {}, `s${i}`);
      return;
    }
    let i = 0;
    for (const c of calls) yield* run(c.name, c.input, `c${i++}`);
    if (opts.done !== false) yield* run('done', {outcome: 'success', summary: 'Готово: черновик удалён'}, 'd');
  };
  return {stream, requests};
}

function agentRunner(model: ReturnType<typeof agentModel>, page = fakeAgentPage(), extra: Partial<ConstructorParameters<typeof ChatRunner>[0]> = {}, settings: Settings = SETTINGS) {
  const events: WorkerToPanel[] = [];
  const chat = new ChatRunner({stream: model.stream, settings: async () => settings, emit: e => events.push(e),
    openTab: page.openTab, tabsApi: fakeTabsApi(), setSiteRule: async () => settings, ...extra});
  return {chat, events, page};
}

const agentSend = (text: string, permission: 'ask' | 'auto' = 'auto') => ({...send(text), tabId: 7, mode: 'agent' as const, permission});

test('агент вызывает click и done', async () => {
  const model = agentModel([{name: 'click', input: {ref: 'a1'}}]);
  const {chat, events, page} = agentRunner(model);
  await chat.send(agentSend('удали черновик'));
  const finished = events.at(-1) as Extract<WorkerToPanel, {type: 'finished'}>;
  assert.equal(finished.message.text, 'Готово: черновик удалён');
  assert.deepEqual(finished.message.steps?.map(s => s.name), ['click', 'done']);
  assert.equal(model.requests[0].maxSteps, 100);
  assert.equal(model.requests[0].stopOnTool, 'done');
  assert.ok(model.requests[0].tools!.click && model.requests[0].tools!.tabs);
  assert.deepEqual(page.log, ['click allow', 'release']);
});

test('лимит шагов', async () => {
  const model = agentModel([], {loopForever: true});
  const {chat, events} = agentRunner(model);
  await chat.send(agentSend('бесконечная задача'));
  const finished = events.at(-1) as Extract<WorkerToPanel, {type: 'finished'}>;
  assert.match(finished.message.text, /Достигнут лимит шагов \(100\)/);
});

test('стоп во время вопроса', async () => {
  const model = agentModel([{name: 'click', input: {ref: 'a1'}}], {done: false});
  const {chat, events, page} = agentRunner(model);
  const done = chat.send(agentSend('удали черновик', 'ask'));
  await waitFor(() => events.some(e => e.type === 'prompt'));
  const prompt = (events.find(e => e.type === 'prompt') as Extract<WorkerToPanel, {type: 'prompt'}>).prompt;
  assert.equal(prompt.kind, 'confirm');
  assert.match(prompt.text, /удаление/);
  chat.stop(prompt.conversationId);
  await done;
  assert.ok(events.some(e => e.type === 'prompt-closed' && e.promptId === prompt.id));
  assert.deepEqual(page.log, ['click cancel', 'release']);
  assert.equal((events.at(-1) as Extract<WorkerToPanel, {type: 'finished'}>).message.status, 'stopped');
});

test('вопрос повторяется новой панели, ответ доходит', async () => {
  const model = agentModel([{name: 'click', input: {ref: 'a1'}}]);
  const {chat, events, page} = agentRunner(model);
  const done = chat.send(agentSend('удали черновик', 'ask'));
  await waitFor(() => chat.pending().length === 1);
  const [prompt] = chat.pending();
  chat.answer(prompt.id, 'allow');
  await done;
  assert.deepEqual(chat.pending(), []);
  assert.deepEqual(page.log, ['click allow', 'release']);
  assert.equal((events.at(-1) as Extract<WorkerToPanel, {type: 'finished'}>).message.text, 'Готово: черновик удалён');
});

test('allow-site сохраняет правило', async () => {
  const saved: [string, string | null][] = [];
  const model = agentModel([{name: 'click', input: {ref: 'a1'}}]);
  const {chat} = agentRunner(model, fakeAgentPage(), {setSiteRule: async (site: string, rule: any) => { saved.push([site, rule]); return SETTINGS; }});
  const done = chat.send(agentSend('удали черновик', 'ask'));
  await waitFor(() => chat.pending().length === 1);
  chat.answer(chat.pending()[0].id, 'allow-site');
  await done;
  assert.deepEqual(saved, [['example.com', 'allow']]);
});

test('правило сайта block отклоняет без вопроса, auto разрешает без вопроса', async () => {
  const blocked = agentRunner(agentModel([{name: 'click', input: {ref: 'a1'}}]), fakeAgentPage(), {}, {...SETTINGS, siteRules: {'example.com': 'block'}});
  await blocked.chat.send(agentSend('удали', 'auto'));
  assert.deepEqual(blocked.page.log, ['click deny', 'release']);
  assert.ok(!blocked.events.some(e => e.type === 'prompt'));
});

test('в режиме chat инструментов действий нет', async () => {
  const model = toolCallingModel();
  const {page} = fakePage();
  const chat = new ChatRunner({stream: model.stream, settings: async () => SETTINGS, emit: () => {}, page, openTab: fakeAgentPage().openTab, tabsApi: fakeTabsApi()});
  await chat.send({...send('что на странице?'), tabId: 5, mode: 'chat'});
  assert.ok(!('click' in (model.calls[0].tools ?? {})));
  assert.equal(model.calls[0].maxSteps, 5);
});

test('текст до и после вызова инструмента разделён пустой строкой', async () => {
  const stream: StreamReply = async function* (request) {
    yield {type: 'text', delta: 'Сейчас посмотрю.'};
    yield {type: 'tool-call', id: 't', name: 'snapshot', input: {}};
    await (request.tools!.snapshot as any).execute({}, {toolCallId: 't', messages: []});
    yield {type: 'tool-result', id: 't', ok: true, summary: 'ok'};
    yield {type: 'text', delta: 'Готово.'};
  };
  const {page} = fakePage();
  const events: WorkerToPanel[] = [];
  const chat = new ChatRunner({stream, settings: async () => SETTINGS, emit: e => events.push(e), page});
  await chat.send({...send('что там?'), tabId: 5});
  assert.equal((events.at(-1) as Extract<WorkerToPanel, {type: 'finished'}>).message.text, 'Сейчас посмотрю.\n\nГотово.');
});

test('итог done не теряется за текстом по ходу работы, частичный исход назван', async () => {
  const stream: StreamReply = async function* (request) {
    yield {type: 'text', delta: 'Сначала посмотрю страницу.'};
    yield {type: 'tool-call', id: 'd', name: 'done', input: {outcome: 'partial', summary: 'Удалил один черновик из двух.'}};
    await (request.tools!.done as any).execute({outcome: 'partial', summary: 'Удалил один черновик из двух.'}, {toolCallId: 'd', messages: []});
    yield {type: 'tool-result', id: 'd', ok: true, summary: 'Удалил один черновик из двух.'};
  };
  const {chat, events} = agentRunner({stream, requests: []} as any);
  await chat.send(agentSend('удали черновики'));
  const text = (events.at(-1) as Extract<WorkerToPanel, {type: 'finished'}>).message.text;
  assert.match(text, /Сначала посмотрю страницу\./);
  assert.match(text, /Итог \(выполнено частично\): Удалил один черновик из двух\./);
});

test('продолжение берёт вкладки чата', async () => {
  // One model, two replies: the first opens a tab, the second (a continuation in the same chat) switches to it.
  let call = 0;
  const stream: StreamReply = async function* (request) {
    const input = call++ === 0 ? {action: 'open', url: 'https://example.com/'} : {action: 'switch', tabId: 99};
    yield {type: 'tool-call', id: `t${call}`, name: 'tabs', input};
    const output = String(await (request.tools!.tabs as any).execute(input, {toolCallId: `t${call}`, messages: []}));
    yield {type: 'tool-result', id: `t${call}`, ok: !output.startsWith('ошибка'), summary: output.split('\n')[0]};
  };
  const {chat, events} = agentRunner({stream, requests: []} as any);
  await chat.send(agentSend('открой пример'));
  const conversationId = (events.find(e => e.type === 'started') as Extract<WorkerToPanel, {type: 'started'}>).conversation.id;
  await chat.send({...agentSend('продолжи'), conversationId, requestId: 'r2'});
  const finished = events.at(-1) as Extract<WorkerToPanel, {type: 'finished'}>;
  assert.equal(finished.message.steps?.[0].status, 'done', JSON.stringify(finished.message.steps));
});

test('шаги сохраняются в базу по ходу ответа, до его конца', async () => {
  const g = gate();
  const stream: StreamReply = async function* (request) {
    yield {type: 'tool-call', id: 't1', name: 'snapshot', input: {}};
    await (request.tools!.snapshot as any).execute({}, {toolCallId: 't1', messages: []});
    yield {type: 'tool-result', id: 't1', ok: true, summary: 'ok'};
    await g.promise;
  };
  const {page} = fakePage();
  const events: WorkerToPanel[] = [];
  const chat = new ChatRunner({stream, settings: async () => SETTINGS, emit: e => events.push(e), page, saveEveryMs: 0});
  const done = chat.send({...send('что там?'), tabId: 5});
  await waitFor(() => events.filter(e => e.type === 'step').length === 2);
  const id = (events[0] as Extract<WorkerToPanel, {type: 'started'}>).conversation.id;
  await waitFor(async () => (await db.listMessages(id))[1]?.steps?.[0]?.status === 'done');
  assert.equal((await db.listMessages(id))[1].status, 'streaming');
  g.open(); await done;
});

test('шаг, который шёл при «Стопе», помечается незавершённым', async () => {
  const g = gate();
  const stream: StreamReply = async function* (request) {
    yield {type: 'tool-call', id: 't1', name: 'snapshot', input: {}};
    await Promise.race([g.promise, new Promise(r => request.signal.addEventListener('abort', r))]);
    if (request.signal.aborted) throw new DOMException('aborted', 'AbortError');
  };
  const {page} = fakePage();
  const events: WorkerToPanel[] = [];
  const chat = new ChatRunner({stream, settings: async () => SETTINGS, emit: e => events.push(e), page});
  const done = chat.send({...send('что там?'), tabId: 5});
  await waitFor(() => events.some(e => e.type === 'step'));
  chat.stop((events[0] as Extract<WorkerToPanel, {type: 'started'}>).conversation.id);
  await done;
  const step = (events.at(-1) as Extract<WorkerToPanel, {type: 'finished'}>).message.steps?.[0];
  assert.equal(step?.status, 'error');
  assert.match(step?.summary ?? '', /не завершён/);
});

test('память вкладок чата переживает перезапуск фонового скрипта', async () => {
  const stored = new Map<string, unknown>();
  const tabMemory = {get: async (id: string) => stored.get(id) as any, set: async (id: string, m: unknown) => { stored.set(id, m); }};
  let call = 0;
  const stream: StreamReply = async function* (request) {
    const input = call++ === 0 ? {action: 'open', url: 'https://example.com/'} : {action: 'switch', tabId: 99};
    yield {type: 'tool-call', id: `t${call}`, name: 'tabs', input};
    const output = String(await (request.tools!.tabs as any).execute(input, {toolCallId: `t${call}`, messages: []}));
    yield {type: 'tool-result', id: `t${call}`, ok: !output.startsWith('ошибка'), summary: output.split('\n')[0]};
  };
  const make = (events: WorkerToPanel[]) => new ChatRunner({stream, settings: async () => SETTINGS, emit: e => events.push(e),
    openTab: fakeAgentPage().openTab, tabsApi: fakeTabsApi(), setSiteRule: async () => SETTINGS, tabMemory});
  const events: WorkerToPanel[] = [];
  await make(events).send(agentSend('открой пример'));
  const conversationId = (events.find(e => e.type === 'started') as Extract<WorkerToPanel, {type: 'started'}>).conversation.id;
  const after: WorkerToPanel[] = [];
  await make(after).send({...agentSend('продолжи'), conversationId, requestId: 'r2'});
  assert.equal((after.at(-1) as Extract<WorkerToPanel, {type: 'finished'}>).message.steps?.[0].status, 'done');
});
