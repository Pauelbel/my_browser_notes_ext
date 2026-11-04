# Помощник 2.0, этап 1 «Каркас» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Расширение с вкладками «Чат» / «Заметки»: чат со стримингом ответов локальной модели Ollama, два редактируемых профиля, история чатов; заметки 1.0 работают как раньше.

**Architecture:** Новый код — TypeScript в `app/src/`, собирается esbuild в `app/dist/` (бандл коммитится, как `vendor/editor.js`). Код заметок 1.0 (`app.js`, `db.js`, `tree.js`, `backup.js`, `vendor/editor.js`) не переписывается: `index.html` подключает и `app.js`, и `dist/panel.js`. Ответ модели генерирует service worker (`dist/background.js`), панель общается с ним через `chrome.runtime` порт `assistant`; чаты, сообщения и профили лежат в отдельной базе IndexedDB `assistant`, которую панель читает напрямую, а пишет в неё (кроме профилей и переименования) только worker.

**Tech Stack:** Chrome MV3, TypeScript 7.0.2 (только проверка типов), esbuild 0.28.2, Vercel AI SDK `ai@7.0.162` + `@ai-sdk/openai-compatible@3.0.84`, `marked@18.1.3` + `dompurify@3.4.17`, `node:test` на Node 22 (встроенное снятие типов), `fake-indexeddb@6.2.7` для тестов.

**Spec:** `docs/superpowers/specs/2026-11-04-ai-assistant-design.md` (этот план — раздел «Порядок работ», этап 1).

## Global Constraints

- Всё в `app/`; команды выполняются из `app/`. Если `pnpm` не установлен глобально — `npx -y pnpm@10 <команда>`.
- База `notes` и формат заметок 1.0 не меняются. Новые данные — только в базе IndexedDB `assistant` и в `chrome.storage.local`.
- `manifest.json`: `"version": "2.0.0"`, `"name": "Помощник"`, `"minimum_chrome_version": "128"`, `permissions`: `["sidePanel", "storage"]`, `host_permissions`: `["http://localhost/*", "http://127.0.0.1/*"]`. Разрешения `debugger`, `tabs`, `tabGroups` — в следующих этапах, не сейчас.
- Без сети в рантайме, кроме запросов к адресу Ollama из настроек. Никаких CDN.
- Интерфейс только на русском. Вне диалогов — только иконки, у каждой `aria-label` и `data-tip` (анти-цель 1.0 «кнопки с текстом вне диалогов» остаётся).
- Ollama по умолчанию: `http://localhost:11434`; запросы модели — на `<адрес>/v1` (OpenAI-совместимый). Модель по умолчанию не задана (пустая строка), выбирается из `/api/tags`.
- Заголовок чата — начало первого сообщения в одну строку, не длиннее 60 символов, обрезка с `…`.
- Порог предупреждения о контексте модели: 16 384 токена.
- Импорты в TS — с расширением `.ts` (нужно для `node --test`); только «стираемый» синтаксис TS (без `enum`, `namespace`, параметров-свойств в конструкторах).
- Модули `src/llm/` не знают про браузерный UI; `src/ui/` не импортирует `src/background/`.

## Review Focus

- Ollama не запущена, неверный адрес или ответ 403 (не задан `OLLAMA_ORIGINS`) — пользователь видит понятное сообщение с подсказкой, а не вечный «печатает…». → тесты `describeError` в Task 3 и `ошибка модели завершает сообщение со статусом failed` в Task 4.
- Панель закрыли посреди ответа — ответ дописывается и сохраняется; worker убит посреди ответа — после перезапуска сообщение показано как «прервано», а не «печатает». → тесты `markInterrupted` в Task 2 и `частичный текст сохраняется во время стриминга` в Task 4.
- Открыты панель и вкладка, в одной отправляют сообщение, пока чат уже отвечает — второй запуск не стартует, обе видят один и тот же ответ. → тест `повторная отправка в работающий чат даёт busy` в Task 4.
- «Стоп» посреди ответа — частичный текст остаётся со статусом `stopped` и учитывается в следующем запросе к модели. → тесты `stop оставляет частичный текст` (Task 4) и `toModelMessages` (Task 4).
- Удаление чата, пока он отвечает, — ответ останавливается, удалённый чат не «воскресает» от поздней записи. → тест `delete останавливает и удаляет чат` в Task 4.

---

### Task 1: TypeScript-сборка, manifest 2.0, worker из `dist/`

**Files:**
- Create: `app/tsconfig.json`, `app/src/background/index.ts`, `app/src/ui/main.ts`, `app/tests/smoke.test.ts`
- Modify: `app/package.json`, `app/build.mjs`, `app/manifest.json`, `app/index.html` (подключить `dist/panel.js`)
- Delete: `app/background.js`

**Interfaces:**
- Produces: `node build.mjs` собирает `src/background/index.ts → dist/background.js` и `src/ui/main.ts → dist/panel.js` (ESM, `target: 'chrome128'`, `bundle: true`, без минификации) плюс прежний `vendor/editor.js`; скрипты `test`, `build`, `typecheck`.

- [ ] **Step 1: Зависимости и скрипты**

`package.json`: dependencies + `ai@7.0.162`, `@ai-sdk/openai-compatible@3.0.84`, `marked@18.1.3`, `dompurify@3.4.17`; devDependencies `typescript@7.0.2`, `@types/chrome` (последняя), `fake-indexeddb@6.2.7`. Scripts: `"test": "node --test tests/*.test.js tests/*.test.ts"`, `"build": "node build.mjs"`, `"typecheck": "tsc --noEmit"`. Затем `pnpm install`.

`tsconfig.json`: `strict: true`, `noEmit: true`, `module/moduleResolution: "bundler"`, `target: "ES2023"`, `lib: ["ES2023", "DOM", "DOM.Iterable", "WebWorker"]` (или раздельные проверки, если конфликт DOM/WebWorker мешает — на усмотрение), `types: ["chrome"]`, `allowImportingTsExtensions: true`, `erasableSyntaxOnly: true`, `allowJs: true`, `checkJs: false`, `include: ["src", "tests"]`.

- [ ] **Step 2: Тест-заглушка `tests/smoke.test.ts`**

```ts
import {test} from 'node:test';
import assert from 'node:assert/strict';
test('TypeScript-тесты запускаются', () => { const x: number = 1; assert.equal(x, 1); });
```

Run: `pnpm test` — Expected: все прежние тесты `tree`/`backup` и smoke PASS.

- [ ] **Step 3: Сборка и manifest**

`build.mjs`: перед блоком THIRD_PARTY_NOTICES добавить сборку двух точек входа в `dist/`. `src/background/index.ts` — перенос строки из `background.js` (`chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true})`). `src/ui/main.ts` — пока пустой модуль с комментарием. `manifest.json` — значения из Global Constraints, `"background": {"service_worker": "dist/background.js", "type": "module"}`. `index.html`: `<script type="module" src="dist/panel.js"></script>` после `app.js`; `<title>Помощник</title>`.

- [ ] **Step 4: Проверка**

Run: `node build.mjs && pnpm typecheck && pnpm test` — Expected: без ошибок, появились `dist/background.js`, `dist/panel.js`.
Вручную: `chrome://extensions` → «Обновить» → панель открывается кликом по значку, заметки на месте.

- [ ] **Step 5: Commit**

```bash
git add -A app && git commit -m "Сборка TypeScript, manifest 2.0, worker из dist"
```

---

### Task 2: Хранилище — настройки, база `assistant`, профили по умолчанию

**Files:**
- Create: `app/src/store/types.ts`, `app/src/store/settings.ts`, `app/src/store/assistant-db.ts`, `app/src/store/title.ts`, `app/src/agent/profiles.ts`
- Test: `app/tests/settings.test.ts`, `app/tests/assistant-db.test.ts`, `app/tests/title.test.ts`

**Interfaces:**
- Produces (`src/store/types.ts`):
  ```ts
  export type ToolName = 'snapshot'|'find'|'read'|'screenshot'|'notes_search'|'notes_read'
    |'tabs'|'navigate'|'click'|'hover'|'scroll'|'type'|'set'|'press'|'wait'|'handle_dialog'
    |'highlight'|'clear_highlights'|'ask_user'|'notes_create'|'notes_append'|'done'
    |'console_log'|'network_log'|'page_checks';
  export interface Profile { id: string; name: string; prompt: string; tools: ToolName[]; createdAt: number }
  export interface Conversation { id: string; title: string; titleByUser: boolean; profileId: string; createdAt: number; updatedAt: number }
  export type MessageStatus = 'streaming'|'done'|'stopped'|'failed'|'interrupted';
  export interface Message { id: string; conversationId: string; role: 'user'|'assistant'; text: string; reasoning: string;
    status: MessageStatus; error?: string; model?: string; createdAt: number }
  export interface Settings { ollamaUrl: string; model: string }
  ```
- Produces (`src/store/settings.ts`): `DEFAULT_SETTINGS: Settings` (`{ollamaUrl: 'http://localhost:11434', model: ''}`); `type KeyValueArea = Pick<chrome.storage.StorageArea, 'get'|'set'>`; `getSettings(area?: KeyValueArea): Promise<Settings>`; `saveSettings(patch: Partial<Settings>, area?: KeyValueArea): Promise<Settings>`; `normalizeOllamaUrl(input: string): string`. Хранится под одним ключом `settings` в `chrome.storage.local` (по умолчанию `area = chrome.storage.local`).
- Produces (`src/store/title.ts`): `titleFrom(text: string): string`.
- Produces (`src/agent/profiles.ts`): `TOOL_CATALOGUE: {name: ToolName; label: string; group: 'read'|'act'|'qa'}[]` (все 25 имён, подписи по-русски по таблицам спеки); `DEFAULT_PROFILES: Profile[]` с id `'assistant'` («Помощник», инструменты групп `read`+`act`) и `'qa'` («QA-тестировщик», все инструменты); промпты — 3–6 предложений «роли» по разделу «Профили» спеки; `validateProfile(p: Pick<Profile,'name'|'prompt'>): string | null` (имя 1–40 символов после trim, промпт до 4000; иначе текст ошибки по-русски).
- Produces (`src/store/assistant-db.ts`), база `assistant` версии 1, хранилища `conversations` (keyPath `id`), `messages` (keyPath `id`, индекс `conversationId`), `profiles` (keyPath `id`):
  `openAssistantDb(name?: string): Promise<void>`, `closeAssistantDb(): void`,
  `listConversations(): Promise<Conversation[]>` (по `updatedAt` убыв.), `getConversation(id): Promise<Conversation|undefined>`,
  `createConversation(init: {profileId: string; firstMessage: string}): Promise<Conversation>`,
  `renameConversation(id: string, title: string): Promise<void>` (ставит `titleByUser: true`),
  `setConversationProfile(id: string, profileId: string): Promise<void>`,
  `deleteConversation(id: string): Promise<void>` (вместе с сообщениями, одной транзакцией),
  `listMessages(conversationId: string): Promise<Message[]>` (по `createdAt` возр.),
  `putMessage(message: Message): Promise<void>` (одной транзакцией обновляет `updatedAt` чата; если чата нет — сообщение не пишется),
  `markInterrupted(): Promise<number>` (все `streaming` → `interrupted`, возвращает число),
  `listProfiles(): Promise<Profile[]>` (если пусто — записывает `DEFAULT_PROFILES` и возвращает их; порядок по `createdAt`),
  `putProfile(profile: Profile): Promise<void>`, `deleteProfile(id: string): Promise<void>` (бросает `Error('Нельзя удалить последний профиль')`),
  `onAssistantChange(cb: (e: {conversationId?: string}) => void): () => void`. Каждая запись публикует `{type: 'changed', conversationId?}` в `BroadcastChannel('assistant')` — по образцу `db.js`.

- [ ] **Step 1: Тесты**

`title.test.ts`:
```ts
test('titleFrom: одна строка, до 60 символов', () => {
  assert.equal(titleFrom('  Привет,\n  мир  '), 'Привет, мир');
  const long = 'а'.repeat(80);
  assert.equal(titleFrom(long).length, 60);
  assert.ok(titleFrom(long).endsWith('…'));
  assert.equal(titleFrom(''), 'Новый чат');
});
```
`settings.test.ts` (фейковое хранилище — объект с `get`/`set` над `Map`):
```ts
test('normalizeOllamaUrl', () => {
  assert.equal(normalizeOllamaUrl(' localhost:11434/ '), 'http://localhost:11434');
  assert.equal(normalizeOllamaUrl('http://127.0.0.1:11434/v1/'), 'http://127.0.0.1:11434');
  assert.equal(normalizeOllamaUrl(''), DEFAULT_SETTINGS.ollamaUrl);
});
test('getSettings без сохранённого даёт значения по умолчанию, saveSettings сливает и нормализует', async () => {
  const area = fakeArea();
  assert.deepEqual(await getSettings(area), DEFAULT_SETTINGS);
  const saved = await saveSettings({ollamaUrl: '127.0.0.1:1/'}, area);
  assert.deepEqual(saved, {ollamaUrl: 'http://127.0.0.1:1', model: ''});
  assert.deepEqual(await getSettings(area), saved);
});
```
`assistant-db.test.ts` (`import 'fake-indexeddb/auto'`, своя база на каждый тест через `openAssistantDb(randomName)` / `closeAssistantDb()`):
- `listProfiles засевает два профиля по умолчанию` — ids `['assistant','qa']`; повторный вызов не дублирует.
- `deleteProfile не удаляет последний` — удалить `qa` можно, затем удаление `assistant` бросает ошибку с текстом `Нельзя удалить последний профиль`.
- `createConversation берёт заголовок из первого сообщения`; `putMessage обновляет updatedAt и порядок listConversations`.
- `putMessage в удалённый чат ничего не пишет` — после `deleteConversation` вызов `putMessage` для него не создаёт сообщений и чата.
- `markInterrupted` — два `streaming` и один `done` → возвращает `2`, статусы `interrupted`, `done` не тронут.
- `validateProfile` — пустое имя и имя из 41 символа → строка ошибки; нормальный профиль → `null`.

- [ ] **Step 2: Run** `pnpm test` — Expected: FAIL, модули не найдены.

- [ ] **Step 3: Реализация** файлов по Interfaces. `chrome` в тестах не существует — `settings.ts` обращается к `chrome.storage.local` только когда `area` не передан.

- [ ] **Step 4: Run** `pnpm test && pnpm typecheck` — Expected: PASS.

- [ ] **Step 5: Commit** `git add -A app && git commit -m "Хранилище помощника: настройки, чаты, профили"`

---

### Task 3: Подключение к Ollama

**Files:**
- Create: `app/src/llm/ollama.ts`, `app/src/llm/stream.ts`
- Test: `app/tests/ollama.test.ts`

**Interfaces:**
- Consumes: `Settings` (Task 2).
- Produces (`src/llm/ollama.ts`):
  `listModels(baseUrl: string, fetchFn?: typeof fetch): Promise<string[]>` — `GET <base>/api/tags`, имена `models[].name` по алфавиту;
  `type OllamaCheck = {ok: true; models: string[]; warning?: string} | {ok: false; error: string}`;
  `checkOllama(baseUrl: string, model: string, fetchFn?: typeof fetch): Promise<OllamaCheck>` — список моделей; затем `GET <base>/api/ps`: если выбранная модель загружена и её `context_length` < 16384 — `warning` с подсказкой про `OLLAMA_CONTEXT_LENGTH`; если выбранной модели нет в списке — `warning` «Модель … не найдена в Ollama»;
  `describeError(error: unknown, baseUrl: string): string`.
- Produces (`src/llm/stream.ts`):
  ```ts
  export interface ModelMessage { role: 'user'|'assistant'; content: string }
  export type StreamPart = {type: 'text'; delta: string} | {type: 'reasoning'; delta: string};
  export type StreamReply = (req: {settings: Settings; system: string; messages: ModelMessage[]; signal: AbortSignal}) => AsyncIterable<StreamPart>;
  export const ollamaStream: StreamReply;
  ```
  `ollamaStream` — `createOpenAICompatible({name: 'ollama', baseURL: settings.ollamaUrl + '/v1'})` + `streamText({model, system, messages, abortSignal})`, из `fullStream` отдаёт части текста и рассуждений; часть `error` — бросает. Точные имена частей потока сверить с типами установленного `ai@7.0.162`.

- [ ] **Step 1: Тесты** (фейковый `fetch`, возвращающий `Response`):
```ts
test('listModels сортирует имена', async () => {
  const f = fakeFetch({'/api/tags': {models: [{name: 'qwen3.5:35b-a3b'}, {name: 'llama3.2:3b'}]}});
  assert.deepEqual(await listModels('http://x', f), ['llama3.2:3b', 'qwen3.5:35b-a3b']);
});
test('checkOllama предупреждает о маленьком контексте', async () => {
  const f = fakeFetch({'/api/tags': {models: [{name: 'm'}]}, '/api/ps': {models: [{name: 'm', context_length: 4096}]}});
  const r = await checkOllama('http://x', 'm', f);
  assert.equal(r.ok, true); assert.match((r as any).warning, /OLLAMA_CONTEXT_LENGTH/);
});
test('describeError: 403 → OLLAMA_ORIGINS', () => {
  assert.match(describeError(new Response('', {status: 403}), 'http://x'), /OLLAMA_ORIGINS=chrome-extension:\/\/\*/);
});
test('describeError: сеть недоступна → адрес и «запущена ли Ollama»', () => {
  const text = describeError(new TypeError('Failed to fetch'), 'http://localhost:11434');
  assert.match(text, /localhost:11434/); assert.match(text, /запущена/);
});
test('checkOllama при 403 возвращает ok:false с подсказкой', async () => {
  const r = await checkOllama('http://x', '', fakeFetch({'/api/tags': 403}));
  assert.equal(r.ok, false); assert.match((r as any).error, /OLLAMA_ORIGINS/);
});
```
`describeError` распознаёт: `Response`/ошибку со статусом 403 (в т. ч. `APICallError` AI SDK со `statusCode`), 404 модели («модель не найдена, проверьте имя»), сетевую ошибку (`TypeError`), прочее — `error.message`.

- [ ] **Step 2: Run** `pnpm test` — Expected: FAIL.
- [ ] **Step 3: Реализация** по Interfaces.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** `git add -A app && git commit -m "Подключение к Ollama"`

---

### Task 4: Чат в service worker

**Files:**
- Create: `app/src/shared/protocol.ts`, `app/src/agent/prompt.ts`, `app/src/agent/history.ts`, `app/src/background/chat-runner.ts`
- Modify: `app/src/background/index.ts`
- Test: `app/tests/chat-runner.test.ts`, `app/tests/history.test.ts`

**Interfaces:**
- Consumes: хранилище (Task 2), `StreamReply`, `ModelMessage`, `describeError` (Task 3).
- Produces (`src/shared/protocol.ts`), порт `chrome.runtime.connect({name: 'assistant'})`:
  ```ts
  export type PanelToWorker =
    | {type: 'send'; requestId: string; conversationId: string | null; text: string; profileId: string}
    | {type: 'stop'; conversationId: string}
    | {type: 'delete'; conversationId: string};
  export type WorkerToPanel =
    | {type: 'running'; conversationIds: string[]}
    | {type: 'started'; requestId: string; conversation: Conversation; user: Message; assistant: Message}
    | {type: 'delta'; conversationId: string; messageId: string; text: string; reasoning: string}   // накопленный текст целиком, не приращение
    | {type: 'finished'; conversationId: string; message: Message}
    | {type: 'busy'; requestId: string; conversationId: string};
  ```
- Produces (`src/agent/prompt.ts`): `BASE_PROMPT: string` = «Ты — помощник в боковой панели браузера пользователя. Отвечай ясно и коротко, используй Markdown, где он помогает. Отвечай на языке сообщения пользователя.»; `systemPrompt(profile: Profile): string` = `BASE_PROMPT + '\n\n## Роль\n\n' + profile.prompt.trim()` (без раздела «Роль», если промпт пуст).
- Produces (`src/agent/history.ts`): `toModelMessages(messages: Message[]): ModelMessage[]` — все `user`; `assistant` со статусами `done`/`stopped`/`interrupted` и непустым текстом; `failed`, пустые и `streaming` пропускаются.
- Produces (`src/background/chat-runner.ts`):
  ```ts
  export interface ChatDeps {
    stream: StreamReply;
    settings: () => Promise<Settings>;
    emit: (event: WorkerToPanel) => void;
    now?: () => number;
    saveEveryMs?: number;          // по умолчанию 500
  }
  export class ChatRunner {
    constructor(deps: ChatDeps);
    send(cmd: Extract<PanelToWorker, {type: 'send'}>): Promise<void>;   // резолвится, когда ответ закончен
    stop(conversationId: string): void;
    delete(conversationId: string): Promise<void>;
    running(): string[];
  }
  ```
  `send`: пустой после trim текст — ничего не делает. Чат уже отвечает — `busy`. Иначе: создать чат при `conversationId === null` (профиль из команды; у существующего чата при другом `profileId` — `setConversationProfile`), записать сообщение пользователя и пустое сообщение ассистента `streaming`, `started`; стримить, `delta` с накопленным текстом на каждую часть, `putMessage` не чаще `saveEveryMs`; в конце статус `done` | `stopped` (по `stop`) | `failed` (`error = describeError(...)`), `putMessage`, `finished`. Модель не выбрана — сразу `failed` с текстом «Модель не выбрана — выберите её в настройках». Профиль берётся из `listProfiles()` по `profileId`; если такого нет (удалён) — первый из списка, и чату ставится его id. `delete`: остановить, дождаться завершения запуска, затем `deleteConversation`.
- `src/background/index.ts`: при старте `openAssistantDb()` → `markInterrupted()`; один `ChatRunner` с `ollamaStream` и `getSettings`; `emit` рассылает всем подключённым портам; при подключении порта — `running`.

- [ ] **Step 1: Тесты** (`fake-indexeddb/auto`, фейковый `stream` — async-генератор из заданных частей, с паузой-промисом для теста «стоп»):
- `toModelMessages` — по описанию выше, включая `stopped` с частичным текстом.
- `systemPrompt` — содержит `BASE_PROMPT` и промпт профиля; при пустом промпте нет «## Роль».
- `send создаёт чат и стримит ответ` — события `started`, `delta` (последний с текстом `'Привет, мир'`), `finished` со статусом `done`; в базе 2 сообщения, заголовок чата = `titleFrom(text)`; модели переданы `system = systemPrompt(профиль)` и сообщения истории.
- `пустое сообщение игнорируется` — `send` с `'   '` не даёт событий и не создаёт чат.
- `повторная отправка в работающий чат даёт busy` — второй `send` в тот же чат до завершения первого → событие `busy` с его `requestId`, новых сообщений нет.
- `stop оставляет частичный текст` — после первой части вызвать `stop` → `finished` со статусом `stopped` и текстом первой части.
- `ошибка модели завершает сообщение со статусом failed` — генератор бросает `new TypeError('Failed to fetch')` → `failed`, `error` содержит адрес Ollama.
- `модель не выбрана` — `settings` с `model: ''` → `failed` с «Модель не выбрана».
- `удалённый профиль заменяется первым` — `send` с `profileId: 'нет-такого'` → у чата `profileId === 'assistant'`, `system` построен из профиля «Помощник».
- `частичный текст сохраняется во время стриминга` — `saveEveryMs: 0`; во время паузы генератора `listMessages` показывает ассистента со статусом `streaming` и уже пришедшим текстом.
- `delete останавливает и удаляет чат` — `delete` посреди стриминга → чата и сообщений нет в базе даже после завершения генератора.

- [ ] **Step 2: Run** `pnpm test` — Expected: FAIL.
- [ ] **Step 3: Реализация** по Interfaces.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck && node build.mjs` — Expected: PASS, сборка без ошибок.
- [ ] **Step 5: Commit** `"Чат в service worker: стриминг, стоп, ошибки"`.

---

### Task 5: Вкладки «Чат» / «Заметки» и экран чата

**Files:**
- Create: `app/src/ui/client.ts`, `app/src/ui/chat-state.ts`, `app/src/ui/markdown.ts`, `app/src/ui/views.ts`, `app/src/ui/chat.ts`
- Modify: `app/src/ui/main.ts`, `app/index.html`, `app/style.css`, `app/icons.js` (иконки `chat`, `notes`, `history`, `newChat`, `send`, `stop`)
- Test: `app/tests/chat-state.test.ts`

**Interfaces:**
- Consumes: протокол (Task 4), хранилище (Task 2), `TOOL_CATALOGUE` не нужен.
- Produces (`src/ui/chat-state.ts`):
  ```ts
  export interface ChatState { conversationId: string | null; pendingRequestId: string | null; messages: Message[]; running: boolean }
  export const emptyChat: ChatState;
  export function applyEvent(state: ChatState, event: WorkerToPanel): ChatState;
  ```
  `started` принимается, если `requestId === pendingRequestId` (новый чат усыновляется) или `conversation.id === conversationId`; `delta`/`finished` — только для текущего чата, заменяют сообщение по `messageId`/`message.id` (если его нет — добавляют); `finished` снимает `running`; `busy` своего запроса снимает `pendingRequestId`; `running` ставит `running`, если текущий чат в списке.
- Produces (`src/ui/client.ts`): `connect(onEvent: (e: WorkerToPanel) => void): {post(msg: PanelToWorker): void}` — переподключается при `onDisconnect` (worker перезапущен).
- Produces (`src/ui/markdown.ts`): `renderMarkdown(text: string): string` — `marked` (GFM, `breaks: true`) → `DOMPurify.sanitize`; у ссылок `target="_blank" rel="noopener noreferrer"`.
- Produces (`src/ui/views.ts`): `type View = 'chat'|'notes'`; `getView(): View` / `setView(v: View): void` — `localStorage['assistant:view']`, по умолчанию `'chat'`; ставит `document.body.dataset.view`.
- Produces (`src/ui/chat.ts`): `initChat(): {open(conversationId: string | null): Promise<void>}` — для истории (Task 6).

Раскладка — по спеке: в верхней полосе слева переключатель вида (две иконки-кнопки с `aria-pressed`), затем иконки «Недавние» и «Новый чат» (только в виде «Чат»); кнопки заметок (`toggleSidebar`, `newNote`, `newFolder`) и `#app` — только в виде «Заметки»; `☼ ⚙` — всегда. Скрытие — CSS по `body[data-view]`. Экран чата `#chat`: лента сообщений; ответ ассистента — Markdown, рассуждения — свёрнутый `<details>` «Рассуждения»; статусы: `streaming` — индикатор «печатает…», `stopped` — пометка «остановлено», `interrupted` — «прервано», `failed` — текст ошибки в рамке ошибки. Поле ввода: Enter — отправить, Shift+Enter — новая строка; под полем — `select` профиля, `select` модели (из `listModels`, выбор сохраняется `saveSettings({model})`), кнопка-иконка «Отправить» / «Стоп» (одна кнопка, меняется по `running`). Лента прокручивается вниз при новых частях, если пользователь не прокрутил вверх. Последний открытый чат — `localStorage['assistant:last']`. Изменения базы из другой панели (`onAssistantChange`) перечитывают ленту, если не идёт стриминг текущего чата.

- [ ] **Step 1: Тесты `chat-state.test.ts`**:
- `started своего запроса усыновляет новый чат` — из `emptyChat` с `pendingRequestId: 'r1'` → `conversationId` из события, 2 сообщения, `running: true`, `pendingRequestId: null`.
- `started чужого запроса игнорируется`.
- `delta заменяет текст сообщения целиком` — две `delta` подряд → текст равен последней.
- `finished снимает running и ставит итоговое сообщение`.
- `события другого чата не меняют состояние`.
- `busy своего запроса снимает pendingRequestId`.

- [ ] **Step 2: Run** `pnpm test` — FAIL. **Step 3:** реализация `chat-state.ts`, затем остальные модули и разметка. **Step 4:** `pnpm test && pnpm typecheck && node build.mjs` — PASS.

- [ ] **Step 5: Ручная проверка** (Ollama запущена с `OLLAMA_ORIGINS=chrome-extension://*`): обновить расширение; вид «Чат» по умолчанию; выбрать модель; отправить «Привет» — ответ появляется по частям, рассуждения свёрнуты; «Стоп» посреди длинного ответа — «остановлено»; переключение на «Заметки» и обратно — заметки 1.0 работают как раньше (создать, отредактировать, найти), ответ в чате на месте; закрыть панель посреди ответа и открыть снова — ответ дописан; ответ модели с `<img src=x onerror=alert(1)>` в тексте не выполняет скрипт.

- [ ] **Step 6: Commit** `"Вкладки Чат/Заметки и экран чата"`.

---

### Task 6: Недавние чаты

**Files:**
- Create: `app/src/ui/history.ts`
- Modify: `app/src/ui/main.ts`, `app/index.html`, `app/style.css`
- Test: `app/tests/history-filter.test.ts`

**Interfaces:**
- Consumes: `listConversations`, `renameConversation`, `onAssistantChange` (Task 2), `PanelToWorker` `delete` (Task 4), `initChat().open` (Task 5).
- Produces: `filterConversations(list: Conversation[], query: string): Conversation[]` — без учёта регистра, `ё` = `е`, по `updatedAt` убыв.; `initHistory(chat: {open(id: string | null): Promise<void>}): void`.

Иконка «Недавние» открывает поповер (как меню дерева в 1.0): поле поиска, список чатов (заголовок, время/дата `updatedAt`), у строки `⋮` → «Переименовать» (диалог ввода, до 60 символов) и «Удалить» (подтверждение «Удалить чат навсегда?», затем `{type: 'delete'}` воркеру — не удалять из панели напрямую). Чат, который сейчас отвечает, отмечен точкой. «Новый чат» — `chat.open(null)`. Удаление открытого чата открывает пустой новый.

- [ ] **Step 1: Тест** `filterConversations`: три чата с заголовками `'Ёлка'`, `'план'`, `'Отчёт QA'` и разными `updatedAt` → запрос `'ел'` даёт `['Ёлка']`; запрос `'QA'` и `'qa'` — `['Отчёт QA']`; пустой запрос — все три по убыванию `updatedAt`.
- [ ] **Step 2–4:** FAIL → реализация → `pnpm test && pnpm typecheck && node build.mjs` PASS.
- [ ] **Step 5: Ручная проверка:** три чата; поиск; переименование сохраняется и не перетирается новым сообщением; удаление отвечающего чата — ответ остановлен, чат не возвращается; панель и вкладка одновременно — список обновляется в обеих.
- [ ] **Step 6: Commit** `"Недавние чаты: поиск, переименование, удаление"`.

---

### Task 7: Настройки — модель и профили, README

**Files:**
- Create: `app/src/ui/settings.ts`
- Modify: `app/src/ui/main.ts`, `app/index.html` (секции в `#settingsDialog` перед «Резервная копия»), `app/style.css`, `README.md`

**Interfaces:**
- Consumes: `getSettings`/`saveSettings`/`normalizeOllamaUrl` (Task 2), `checkOllama` (Task 3), `listProfiles`/`putProfile`/`deleteProfile`/`validateProfile`/`TOOL_CATALOGUE` (Task 2).
- Produces: `initSettings(): void` — обновляет свои секции при каждом открытии диалога (слушатель на `#openSettings`, в дополнение к обработчику `app.js`).

Секция «Модель»: поле адреса Ollama, кнопка «Проверить» → `checkOllama`; `select` модели; строка статуса: ошибка (текст из `describeError`), предупреждение или «Подключено, моделей: N». Постоянная подсказка мелким текстом: запуск Ollama с `OLLAMA_ORIGINS=chrome-extension://*` и `OLLAMA_CONTEXT_LENGTH` не меньше 16384.
Секция «Профили»: список профилей; выбранный редактируется — имя, промпт (`textarea`), флажки инструментов по группам «Чтение» / «Действия» / «QA-проверки» с пометкой «инструменты заработают в следующих версиях»; «Новый профиль» (копия общих полей, имя «Новый профиль»), «Удалить» (с подтверждением; для последнего — кнопка неактивна). Сохранение — по `change`/`blur` с проверкой `validateProfile`, ошибка показывается под полем. Подпись: «Общие правила работы добавляются к роли автоматически».
README: название «Помощник», что умеет этап 1, установка (как раньше), раздел «Ollama» (переменные `OLLAMA_ORIGINS`, `OLLAMA_CONTEXT_LENGTH`, пример для Linux systemd `systemctl edit ollama` и для запуска вручную), раздел «Разработка» — `pnpm build` (TS + редактор), `pnpm test`, `pnpm typecheck`; совместимость и бэкап — без изменений; заметка «Переход с 1.0: заметки сохраняются».

- [ ] **Step 1: Реализация** секций и README.
- [ ] **Step 2: Run** `pnpm test && pnpm typecheck && node build.mjs` — PASS.
- [ ] **Step 3: Ручная проверка:** неверный адрес → понятная ошибка; Ollama без `OLLAMA_ORIGINS` → подсказка про `OLLAMA_ORIGINS`; правильный адрес → список моделей; создать профиль, изменить промпт, выбрать его в чате — ответ следует роли (например, «Отвечай только стихами»); пустое имя — ошибка, не сохраняется; удалить профиль, выбранный в каком-то чате, — чат открывается с первым профилем.
- [ ] **Step 4: Commit** `"Настройки модели и профилей, README 2.0"`.

---

### Task 8: Итоговая проверка этапа

**Files:** без новых; правки по найденному.

- [ ] **Step 1:** `pnpm install --frozen-lockfile && node build.mjs && pnpm typecheck && pnpm test` — всё PASS; `git status` чистый после сборки (бандлы в `dist/` и `vendor/` закоммичены и актуальны).
- [ ] **Step 2: Ручной прогон** по Review Focus (все пять пунктов) и анти-целям спеки, относящимся к этапу: заметки 1.0 целы после обновления с 1.0 на 2.0 (поставить 1.0 с `main`, создать заметки, переключиться на ветку, «Обновить» расширение); данные не уходят никуда, кроме адреса Ollama (DevTools worker → Network).
- [ ] **Step 3: Commit** исправлений, если были: `"Этап 1: исправления по итоговой проверке"`.
