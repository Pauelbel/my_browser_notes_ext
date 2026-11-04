# Помощник 2.0, этап 3 «Агентный режим» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Режим «Агент»: модель сама выполняет цепочку действий на страницах (клики, ввод, переходы, вкладки, подсветка, заметки) до 100 шагов, а опасные действия ждут решения пользователя по правилам Ask/Auto и правилам сайтов.

**Architecture:** Слой страницы получает детерминированный классификатор действий и «ворота» (`gate`) перед отправкой события: запись (отправка формы, отправка, удаление, выход) — по решению из настроек, оплата/доступ/ввод секрета/ответ на `prompt` — шаг пользователя. Агент (`src/agent/`) собирает набор инструментов из профиля и ведёт цикл в `ChatRunner` (тот же стриминг, `maxSteps = 100`, остановка на `done`), вопросы к пользователю идут в панель карточками и ждут ответа в worker. Вкладки задачи собираются в группу, вокруг страницы, с которой работает агент, — рамка.

**Tech Stack:** как этапы 1–2. Новые разрешения manifest: `tabs`, `tabGroups`.

**Spec:** `docs/superpowers/specs/2026-11-04-ai-assistant-design.md` — «Чат и агент» (режимы, опасные действия, охват), «Профили», «Инструменты», «Порядок работ» п. 3.

## Global Constraints

- Всё в `app/`; `pnpm` = `npx -y pnpm@10`; e2e — `pnpm e2e <имя>`.
- `manifest.json`: `permissions` = `["sidePanel", "storage", "debugger", "tabs", "tabGroups"]`, `"version": "2.2.0"`.
- Слой `src/page/` по-прежнему не знает про модель и настройки: решение по воротам приходит в него функцией.
- Режимы чата: `chat` (как этап 2, читающие инструменты + `notes_search`, `notes_read`, ≤ 5 шагов) и `agent` (все инструменты профиля, ≤ 100 шагов, конец — вызов `done` или ответ без вызова инструмента). Режим и Ask/Auto хранятся в чате; по умолчанию `chat` и `ask`.
- Решение по записи (как у nanobrowser): правило сайта `block` → действие и переход запрещены; `allow` → без вопроса; `ask` → вопрос в обоих режимах; без правила: Ask → вопрос, Auto → без вопроса.
- Шаг пользователя (без кнопки «Разрешить»): оплата, выдача доступа, ввод в секретное поле (`isSecretField`), ответ на диалог `prompt`, капча (через `ask_user` вида `takeover`).
- Классификатор детерминированный, словарь русский и английский, при сомнении — опаснее. Категории и приоритет: `pay` > `access` > `secret` > `delete` > `logout` > `send` > `submit`.
- Отклонённое действие → результат `ошибка USER_DECLINED: … событие не отправлено`; после ответа пользователя цель проверяется заново (resolve + проверки).
- Ни модель, ни инструмент не меняют режим, Ask/Auto и правила сайтов.
- Агент работает только во вкладках своего чата: вкладка, где начали, и открытые им; они в группе вкладок с названием чата (до 20 символов). Рамка вокруг страницы, с которой работает агент, — пока подключён отладчик; выключается в настройках.
- Заметки: `notes_search`, `notes_read`, `notes_create` — без вопроса; `notes_append` — запись (Ask/Auto, без правил сайта); удаления нет.
- Старые результаты страниц в истории цикла заменяются заглушкой «[описание страницы скрыто — при необходимости сделайте snapshot]», кроме трёх последних.
- `screenshot` переносится на этап 4 (нужна проверка изображений в результатах инструментов через OpenAI-совместимый адрес Ollama).
- Карточки решений в ленте (Разрешить / Разрешить на этом сайте / Отклонить, Готово / Отменить, поле ответа) — единственное исключение из правила «вне диалогов только иконки»: это диалог в ленте.

## Review Focus

- В Ask модель нажимает «Удалить»: карточка в панели, событие не отправлено до решения; «Отклонить» → ничего не произошло, агент продолжает. → e2e `gate` (Task 2) и сценарий 3 в `agent` (Task 9).
- «Стоп» или удаление чата, пока висит карточка, — цикл заканчивается, карточка исчезает, событие не отправлено. → тест `стоп во время вопроса` (Task 7).
- Панель закрыли, пока висит карточка, — при открытии карточка снова видна и ответ доходит. → тест `вопрос повторяется новой панели` (Task 7).
- Агент упёрся в 100 шагов — ответ «достигнут лимит шагов» со статусом, отличным от успеха. → тест `лимит шагов` (Task 7).
- Длинная задача: история с десятками описаний страниц не переполняет контекст. → тест `elideOldPages` (Task 7).

---

### Task 1: Классификатор действий и решение по записи (чистые функции)

**Files:**
- Create: `app/src/page/classify.ts`, `app/src/agent/permissions.ts`
- Test: `app/tests/classify.test.ts`

**Interfaces:**
- Produces (`classify.ts`):
  ```ts
  export type Category = 'pay' | 'access' | 'secret' | 'delete' | 'logout' | 'send' | 'submit';
  export const USER_STEP: ReadonlySet<Category>;   // pay, access, secret
  export interface ActionFacts { action: 'activate' | 'enter' | 'type'; role: string; name: string; tag: string; type: string;
    inForm: boolean; formHasPassword: boolean; secretField: boolean; nearbyText: string }
  export function classify(f: ActionFacts): Category | null;
  ```
  `activate` — клик или Enter/Space по кнопке/ссылке; `enter` — Enter в поле; `type` — ввод текста. Правила: `type` в секретное поле → `secret`; иначе `type` → `null`. Словари (по слову, без учёта регистра и `ё/е`): **pay** — оплат*, купить, заказать, оформить заказ, перейти к оплате, подписаться, пожертвовать, перевести деньги, пополнить, pay, buy, purchase, checkout, place order, subscribe, donate, top up; а также сумма с валютой (`\d[\d\s]*(₽|руб|\$|€|USD|EUR)`) в имени или `nearbyText` при общем имени «подтвердить|продолжить|confirm|continue»; **access** — разрешить доступ, предоставить доступ, авторизовать, authorize, allow access, grant access, connect account; **delete** — удал*, стереть, очистить всё, delete, remove, erase, destroy; **logout** — выйти, выход, log out, logout, sign out; **send** — отправить, опубликовать, send, post, publish, reply; **submit** — `activate` по кнопке отправки формы (`type=submit` или `button` без типа внутри формы, `input[type=submit|image]`) или `enter` в поле внутри формы.
- Produces (`permissions.ts`): `type PermissionMode = 'ask' | 'auto'`; `type SiteRule = 'allow' | 'ask' | 'block'`; `siteOf(url: string): string` (хост без `www.`, `''` для не-http); `decideWrite(mode: PermissionMode, rule: SiteRule | undefined): 'allow' | 'ask' | 'block'`.

- [ ] **Step 1: Тесты:**
  - `classify`: «Удалить черновик» (button, activate) → `delete`; «Выйти» → `logout`; «Оплатить 1 990 ₽» → `pay`; «Подтвердить» с `nearbyText: 'Итого 1 990 ₽'` → `pay`; «Разрешить доступ» → `access`; «Отправить» (button type=submit в форме) → `send` (словарь важнее `submit`); «Сохранить» (type=submit в форме) → `submit`; Enter в поле внутри формы → `submit`; Enter в поле вне формы → `null`; ввод в поле с `secretField: true` → `secret`; ввод в обычное поле → `null`; «Удалить» и «Оплатить» в одном имени → `pay`; «Ёлка» (ссылка) → `null`; «Delete account» → `delete`; «Sign out» → `logout`.
  - `decideWrite`: таблица из Global Constraints (5 строк: block→block при любом режиме, allow→allow в ask, ask→ask в auto, без правила ask→ask, без правила auto→allow).
  - `siteOf('https://www.example.com/a?b')` → `example.com`; `siteOf('chrome://x')` → `''`.
- [ ] **Step 2–4:** FAIL → реализация → `pnpm test` PASS. **Step 5: Commit** `"Классификатор действий и решение по записи"`.

---

### Task 2: Ворота перед действием в слое страницы

**Files:**
- Modify: `app/src/page/tools.ts`, `app/src/page/act.ts`, `app/src/page/errors.ts` (код `USER_DECLINED`, `SITE_BLOCKED`), `app/src/page/index.ts`, `app/src/dev/harness.ts`
- Create: `app/tests/fixtures/pages/danger.html`, `app/tests/e2e/gate.e2e.mjs`

**Interfaces:**
- Consumes: `classify`, `USER_STEP`, `ActionFacts` (Task 1).
- Produces:
  ```ts
  export interface GateQuestion { action: string; ref: string; role: string; name: string; category: Category; site: string; url: string }
  export type GateAnswer = {decision: 'allow'} | {decision: 'deny'} | {decision: 'user-did-it'} | {decision: 'cancel'};
  export interface Gate { check(q: GateQuestion): Promise<GateAnswer>; blocked(site: string): boolean }
  // PageTools constructor options: {budget: number; gate?: Gate}
  ```
  В `#act` после проверок и до снятия базы: факты цели (`callOn`: тег, тип, `form`, пароль в форме, текст вокруг — ближайший предок-блок до 200 символов, `isSecretField` по атрибутам) → `classify`; категория есть и `gate` задан → `gate.check`. `deny`/`cancel` → `USER_DECLINED` (`delivered: false`); `user-did-it` (шаг пользователя) → результат «шаг выполнен пользователем, событие не отправлено помощником» без отправки; `allow` → заново `resolveTarget` + `waitActionable`, затем отправка. Без `gate` (dev, этап 2) — как раньше. Для `type` с `submit: true` проверяется и `enter`. `handleDialog` для диалога типа `prompt` — шаг пользователя: `gate.check` с `category: 'secret'` и `action: 'handle_dialog'`; ответ `user-did-it` → «пользователь ответил на диалог сам». `navigate` и переход по клику на сайт, для которого `gate.blocked(site)` → `SITE_BLOCKED` до отправки (для клика — по `href` ссылки).
- `danger.html`: кнопки «Удалить черновик», «Выйти», «Оплатить 1 990 ₽», «Разрешить доступ», форма с полем «Комментарий» и кнопкой «Сохранить», поле пароля, ссылка на `basic.html`; каждая кнопка пишет своё имя в `#status`.
- Harness: `layer.call(tabId, method, args, budget, gateScript)` — `gateScript`: массив ответов по очереди (`'allow'|'deny'|'user-did-it'`) и список заблокированных сайтов; вопросы копятся в `layer.questions`.

- [ ] **Step 1: e2e `gate.e2e.mjs`:** «Удалить черновик» с ответом `deny` → `USER_DECLINED`, статус не изменился, вопрос с категорией `delete`; с `allow` → статус «Удалить черновик»; «Оплатить 1 990 ₽» → вопрос `pay`, ответ `user-did-it` → результат без отправки, статус не изменился; ввод в пароль → вопрос `secret`; «Сохранить» → `submit`; клик по обычной ссылке — вопросов нет; `navigate` на заблокированный сайт `localhost` → `SITE_BLOCKED`.
- [ ] **Step 2–3:** FAIL → реализация → `node build.mjs && pnpm e2e gate act` PASS (старые сценарии без ворот не меняются).
- [ ] **Step 4: Commit** `"Ворота перед опасным действием в слое страницы"`.

---

### Task 3: Настройки и чат: режим, Ask/Auto, правила сайтов, рамка

**Files:**
- Modify: `app/src/store/types.ts`, `app/src/store/settings.ts`, `app/src/store/assistant-db.ts`
- Test: `app/tests/settings.test.ts`, `app/tests/assistant-db.test.ts`

**Interfaces:**
- Produces: `Settings` + `siteRules: Record<string, SiteRule>` (по умолчанию `{}`), `border: boolean` (по умолчанию `true`); `Conversation` + `mode: 'chat' | 'agent'`, `permission: PermissionMode` (старые записи без полей читаются как `chat`/`ask`); `createConversation(init: {profileId; firstMessage; mode?; permission?})`; `setConversationMode(id, mode, permission)`; `setSiteRule(site: string, rule: SiteRule | null): Promise<Settings>` (null — удалить).
- [ ] **Step 1: Тесты:** значения по умолчанию; `setSiteRule('example.com', 'allow')` → в настройках, `null` → удалено; `getConversation` старой записи без `mode` → `mode: 'chat'`, `permission: 'ask'`; `setConversationMode` сохраняет.
- [ ] **Step 2–4:** FAIL → реализация → PASS. **Step 5: Commit** `"Режим чата, Ask/Auto, правила сайтов"`.

---

### Task 4: Вкладки задачи, группа и рамка

**Files:**
- Create: `app/src/agent/agent-tabs.ts`
- Modify: `app/src/page/probe.ts` (`__assistant.border(on, color)` — рамка в том же слое, что подсветка, отдельным элементом), `app/src/page/tools.ts` (`border(on: boolean)`), `app/manifest.json`, `app/src/dev/harness.ts`
- Test: `app/tests/e2e/tabs.e2e.mjs`

**Interfaces:**
- Consumes: `acquire`/`release`, `PageTools`, `Gate`.
- Produces:
  ```ts
  export interface TabsDeps { tabs: typeof chrome.tabs; tabGroups?: typeof chrome.tabGroups; open: (tabId: number) => Promise<{tools: PageTools; release(): Promise<void>}>; border: boolean; title: string }
  export class AgentTabs {
    constructor(startTabId: number, deps: TabsDeps);
    current(): Promise<PageTools>;          // подключается лениво, рисует рамку
    list(): Promise<string>;                // «* [вкладка 12] Заголовок — url», * у текущей
    open(url: string): Promise<string>;     // новая вкладка в группе, становится текущей
    switch(tabId: number): Promise<string>; // только вкладки задачи, иначе ошибка
    close(tabId: number): Promise<string>;  // не стартовую
    adopt(tabId: number): void;             // вкладка, открытая страницей (target=_blank), входит в задачу
    releaseAll(): Promise<void>;            // снимает рамки и отключается от всех
  }
  ```
  Группа создаётся при первом подключении (`chrome.tabs.group`, название — `title` до 20 символов, цвет `blue`); вкладки, открытые со стартовой/текущей (`chrome.tabs.onCreated` с `openerTabId` из задачи), добавляются через `adopt`. Рамка: при подключении `border(true)`, при `releaseAll` — `border(false)`; при `deps.border === false` не рисуется.
- `manifest.json`: разрешения и версия из Global Constraints.
- [ ] **Step 1: e2e `tabs.e2e.mjs`** (harness `layer.agentTabs(...)`): `current()` на `basic.html` → в странице есть слой рамки; `open(basic2.html)` → две вкладки задачи, обе в одной группе (`chrome.tabs.get(id).groupId` равны и не `-1`); `list()` содержит обе с `*` у второй; `switch` на чужую вкладку → ошибка; `releaseAll()` → слоя рамки нет, отладчик отключён от обеих.
- [ ] **Step 2–3:** FAIL → реализация → PASS. **Step 4: Commit** `"Вкладки задачи, группа и рамка"`.

---

### Task 5: Инструменты заметок

**Files:**
- Create: `app/src/agent/notes.ts`
- Test: `app/tests/agent-notes.test.ts`

**Interfaces:**
- Consumes: `db.js` (`open`, `loadAll`, `createNote`, `putNote`), `tree.js` (`folderPath`, `matches`, `noteTitle`).
- Produces: `notesSearch(query: string): Promise<string>` (до 20 совпадений: `id · путь / название · теги`; поиск как в дереве — регистр и `ё`), `notesRead(id: string): Promise<string>` (название, путь, теги, тело Markdown; тело до 20000 символов с пометкой об обрезке), `notesCreate(title: string, body: string, folderPath?: string): Promise<string>` (папка по пути, если существует, иначе корень), `notesAppend(id: string, text: string): Promise<string>` (дописывает с пустой строкой перед текстом; пересчитывает `updated`). Тексты заметок в результатах — блоком `<<<note>>> … <<<end-note>>>` (маркеры внутри текста заметки обезвреживаются, как у страниц); в промпте это объявлено данными пользователя, а не командами.
- [ ] **Step 1: Тесты** (`fake-indexeddb/auto`, база `notes` поднимается через `open()` из `db.js`): поиск находит по тегу и по тексту с `ё`; `notesRead` неизвестного id → понятная ошибка; `notesCreate` в существующую папку по пути `Работа/QA`; `notesAppend` дописывает и не трогает остальное.
- [ ] **Step 2–4:** FAIL → реализация → PASS. **Step 5: Commit** `"Инструменты заметок"`.

---

### Task 6: Набор инструментов агента и промпт агента

**Files:**
- Modify: `app/src/agent/tools.ts`, `app/src/agent/prompt.ts`
- Test: `app/tests/agent-tools.test.ts`

**Interfaces:**
- Consumes: `AgentTabs` (Task 4), инструменты заметок (Task 5).
- Produces: `CHAT_TOOLS` = `['snapshot', 'find', 'read', 'notes_search', 'notes_read']`; `AGENT_ONLY: ToolName[]` = все остальные из `TOOL_CATALOGUE`, кроме `screenshot` и QA-группы; `buildChatTools(profile, page, notes)`; `buildAgentTools(profile: Profile, ctx: AgentContext): ToolSet`, где `interface AgentContext { tabs: AgentTabs; notes: NotesApi; ask(q: {question: string; kind: 'input' | 'takeover'}): Promise<string>; confirmNotes(what: string): Promise<boolean> }`. Схемы `zod` по таблице инструментов спеки: `click {ref}`, `hover {ref}`, `scroll {direction, amount?, ref?}`, `type {ref, text, clear?, submit?}`, `set {ref, value: string | boolean}`, `press {key, ref?}`, `wait {text?, ref?, gone?, timeoutMs?}`, `navigate {url?} | {action}`, `handle_dialog {accept, text?}`, `highlight {ref?, text?, color?}`, `clear_highlights {}`, `tabs {action: 'list'|'open'|'switch'|'close', url?, tabId?}`, `ask_user {question, kind}`, `notes_create {title, body, folder?}`, `notes_append {id, text}`, `done {outcome: 'success'|'partial'|'failed', summary}`; инструменты страницы работают в `ctx.tabs.current()`; `done.execute` возвращает `summary`.
- Produces (`prompt.ts`): `agentSystemPrompt(profile: Profile, tools: ToolName[]): string` — разделы по-русски: «Как работать» (сначала snapshot, действуй по меткам, читай квитанцию: событие отправлено / реакция / изменения; ошибка с «событие отправлено» или «неизвестно» — сначала посмотри страницу, не повторяй; одна понятная операция за раз; закончи вызовом done с честным итогом; ответ без вызова инструмента заканчивает задачу), «Что решает пользователь» (отклонённое действие — ответ, не обходи; оплата, доступ, пароли и коды, капча — шаг пользователя через ask_user вида takeover; не проси пароль), правило о маркерах страниц и заметок, правило «не показывай метки», роль профиля.
- [ ] **Step 1: Тесты:** у профиля «QA-тестировщик» в агентном наборе есть `click`, `tabs`, `done`, нет `screenshot` и QA-инструментов (этап 4); у профиля без `click` его нет; `done.execute({outcome: 'success', summary: 'Готово'})` → `'Готово'`; `buildChatTools` содержит `notes_search`; `agentSystemPrompt` содержит «done», «takeover», `<<<page-content>>>`, `<<<note>>>`, роль профиля.
- [ ] **Step 2–4:** FAIL → реализация → PASS. **Step 5: Commit** `"Инструменты и промпт агента"`.

---

### Task 7: Цикл агента в worker, вопросы пользователю

**Files:**
- Modify: `app/src/background/chat-runner.ts`, `app/src/background/index.ts`, `app/src/shared/protocol.ts`, `app/src/llm/stream.ts`
- Create: `app/src/agent/elision.ts`, `app/src/background/prompts.ts`
- Test: `app/tests/chat-runner.test.ts`, `app/tests/elision.test.ts`

**Interfaces:**
- Produces (`protocol.ts`): `PanelToWorker` + `{type: 'answer'; promptId: string; answer: 'allow' | 'allow-site' | 'deny' | 'done' | 'cancel' | {text: string}}`, `{type: 'mode'; conversationId: string; mode: 'chat'|'agent'; permission: PermissionMode}`; `send` + `mode?`, `permission?` (для нового чата); `WorkerToPanel` + `{type: 'prompt'; prompt: PendingPrompt}`, `{type: 'prompt-closed'; promptId: string}`; `running` + `prompts: PendingPrompt[]`. `interface PendingPrompt { id: string; conversationId: string; kind: 'confirm' | 'takeover' | 'input'; text: string; site?: string; category?: Category }`.
- Produces (`prompts.ts`): `class PromptBroker { ask(p: Omit<PendingPrompt, 'id'>, signal: AbortSignal): Promise<PanelAnswer>; answer(promptId, answer): void; pending(): PendingPrompt[] }` — `ask` эмитит `prompt`, по ответу или `signal.abort()` закрывает (`prompt-closed`, при отмене — `cancel`).
- Produces (`elision.ts`): `elideOldPages(messages: ModelMessage[], keep = 3): ModelMessage[]` — в сообщениях-результатах инструментов, содержащих `<<<page-content>>>`, всё, кроме последних `keep`, заменяется на `'[описание страницы скрыто — при необходимости сделайте snapshot]'`; сообщения пользователя не трогаются.
- `StreamReply` + `stopOnTool?: string` (`done`) и `prepareMessages?: (messages) => messages` (через `prepareStep` AI SDK); `ollamaStream` передаёт `stopWhen: [stepCountIs(maxSteps), hasToolCall(stopOnTool)]` (имена сверить с `ai@7.0.162`).
- `ChatRunner`: для `mode === 'agent'` — `AgentTabs` со стартовой `tabId`, `Gate` из настроек (`decideWrite` по `permission` чата и правилу сайта; `ask` → `PromptBroker` `confirm` с текстом «Нажать «<имя>» на <сайт> (<категория по-русски>)?»; шаг пользователя → `takeover` «Сделайте это сами: …, затем нажмите «Готово»»; `allow-site` → `setSiteRule(site, 'allow')` и разрешить), `buildAgentTools`, `maxSteps = 100`, `stopOnTool: 'done'`, `prepareMessages: elideOldPages`; итог — текст модели или `summary` из `done`; 100 шагов без `done` → статус `done` с пометкой в тексте «Достигнут лимит шагов (100): задача выполнена не полностью.»; `releaseAll` в `finally`. `notes_append` в Ask → `confirm` «Дописать в заметку «…»?». Ответ панели — `{type: 'answer'}` → `broker.answer`. `stop`/`delete` прерывают сигнал → открытые вопросы закрываются `cancel`. Новой панели `running` отдаёт и `prompts`.
- [ ] **Step 1: Тесты:**
  - `elision.test.ts`: пять результатов со страницей → три последних целы, два заменены; результат без маркеров не тронут; сообщение пользователя с маркером не тронуто.
  - `chat-runner.test.ts` (фейковая модель вызывает инструменты из переданного набора): `агент вызывает click и done` (итог — `summary`, шаги `click`, `done`); `лимит шагов` (модель всегда вызывает `snapshot`; `maxSteps` передан 100; без `done` → в тексте «Достигнут лимит шагов»); `стоп во время вопроса` (gate спрашивает → `stop` → событие `prompt-closed`, инструмент вернул `USER_DECLINED`, сообщение `stopped`); `вопрос повторяется новой панели` (пока вопрос открыт, `runner.pending()` содержит его; после `answer` — пуст); `allow-site сохраняет правило` (фейковый `setSiteRule` вызван с сайтом и `allow`); `в режиме chat инструментов действий нет`.
- [ ] **Step 2–4:** FAIL → реализация → `pnpm test && pnpm typecheck && node build.mjs` PASS.
- [ ] **Step 5: Commit** `"Цикл агента и вопросы пользователю"`.

---

### Task 8: Интерфейс агента в панели

**Files:**
- Modify: `app/index.html`, `app/style.css`, `app/src/ui/chat.ts`, `app/src/ui/chat-state.ts`, `app/src/ui/settings.ts`
- Test: `app/tests/chat-state.test.ts`

**Interfaces:**
- Produces (`chat-state.ts`): `ChatState` + `prompts: PendingPrompt[]`; `applyEvent` обрабатывает `prompt` (добавить, если чат текущий), `prompt-closed` (убрать), `running` (заменить список своими).
- Поле ввода: `select` режима («Чат» / «Агент») и `select` Ask/Auto («Спрашивать» / «Сам»), второй виден только в режиме «Агент»; выбор сохраняется в чате (`{type: 'mode'}`) или для нового чата идёт в `send`.
- Карточки в ленте под последним сообщением: `confirm` — текст + «Разрешить» / «Разрешить на этом сайте» / «Отклонить»; `takeover` — текст + «Готово» / «Отменить»; `input` — вопрос + поле + «Ответить». Ответ — `{type: 'answer'}`; карточка исчезает по `prompt-closed`.
- Настройки: секция «Агент» — флажок «Рамка вокруг страницы, с которой работает агент»; список правил сайтов (сайт, `select` allow/ask/block, удалить) с добавлением по имени сайта.
- [ ] **Step 1: Тесты `chat-state`:** `prompt` текущего чата добавляется, чужого — нет; `prompt-closed` убирает; `running` с `prompts` заменяет список.
- [ ] **Step 2–4:** FAIL → реализация → PASS + `node build.mjs`.
- [ ] **Step 5: Ручная проверка через e2e-драйвер** (страница `index.html`, подмена `chrome.tabs.query`, как в `chat-tools`): режим «Агент» сохраняется в чате; карточка появляется и исчезает по ответу. Commit `"Интерфейс агента: режимы, карточки решений, правила сайтов"`.

---

### Task 9: Сквозные проверки агента с моделью

**Files:**
- Create: `app/tests/e2e/agent.e2e.mjs` (только явно; нужна Ollama с `qwen3.5:35b-a3b`, иначе SKIP)

Сценарии (каждый — новый чат в режиме «Агент», вкладка с тестовой страницей подставлена через `chrome.tabs.query`):
1. `highlight.html`, «Выдели на странице все слова «настройки» жёлтым» → шаг `highlight` выполнен, на странице подсветка (проверка через `CSS.highlights` в странице), итог успешный.
2. `basic.html`, «Нажми кнопку «Изменить статус» и скажи, что изменилось» → шаг `click`, статус страницы «Кнопка нажата», в ответе «Кнопка нажата».
3. `danger.html`, режим «Спрашивать», «Удали черновик» → появляется карточка `confirm` с «удаление»; ответ «Отклонить» → статус не изменился, итог не «успех»; повтор с «Разрешить» → статус «Удалить черновик».
4. `basic.html`, «Открой вторую страницу по ссылке и прочитай её заголовок» → шаг `click` или `navigate`, в ответе «Вторая страница».
Для каждого печатается число шагов и время. Провал сценария разбирается: правка промпта или описаний инструментов, повтор.

- [ ] **Step 1:** сценарии. **Step 2:** прогон, разбор, правки. **Step 3: Commit** `"Сквозные проверки агента с моделью"`.

---

### Task 10: Итоговая проверка этапа

- [ ] **Step 1:** `pnpm install --frozen-lockfile && node build.mjs && pnpm typecheck && pnpm test && pnpm e2e && pnpm e2e agent` — всё `ok`; `git status` чист.
- [ ] **Step 2:** README: «Что умеет» — агентный режим, Ask/Auto, карточки решений, правила сайтов, группа вкладок и рамка; разрешения `tabs`, `tabGroups`. Commit `"Этап 3: итоговая проверка и README"`.
