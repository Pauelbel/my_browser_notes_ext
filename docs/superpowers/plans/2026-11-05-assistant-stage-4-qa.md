# Помощник 2.0, этап 4 «Поиск багов» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Инструменты QA — ошибки консоли, упавшие запросы, проверки страницы и скриншот для моделей с изображениями — и профиль «QA-тестировщик», который с их помощью находит баги на сайте.

**Architecture:** Слой страницы собирает консоль и сеть фоном, пока подключён отладчик (`Runtime`, `Log`, `Network`), и отдаёт сводку, а не поток. Проверки страницы выполняются в изолированном мире пробы и по описанию страницы. Скриншот — `Page.captureScreenshot`; так как OpenAI-совместимый адрес не принимает изображения в результатах инструментов, изображение добавляется к следующему ходу модели отдельным сообщением пользователя (через `prepareMessages`), хранится только последнее.

**Tech Stack:** как этапы 1–3.

**Spec:** `docs/superpowers/specs/2026-11-04-ai-assistant-design.md` — «Инструменты» (QA-проверки, `screenshot`), «Профили» (QA-тестировщик), «Порядок работ» п. 4.

## Global Constraints

- Всё в `app/`; `pnpm` = `npx -y pnpm@10`.
- QA-инструменты только читают: доступны и в режиме «Чат», и в «Агенте», если отмечены в профиле. Параметр `reload: true` (собрать с начала загрузки) — только в режиме «Агент».
- Сбор идёт с момента подключения отладчика; в каждой сводке строка «собрано с HH:MM:SS (с подключения к вкладке); ошибки до этого не видны — используйте reload: true».
- Ограничения: до 300 записей консоли и 300 сетевых записей на вкладку (старые вытесняются, вытеснение сообщается); в сводке до 30 групп; одинаковые сообщения группируются со счётчиком.
- Консоль: `console.error`/`console.assert`/`console.warn`, необработанные исключения (`Runtime.exceptionThrown`), записи `Log.entryAdded` уровней `error` и `warning` (сеть, CSP, нарушения). Сеть: ответы со статусом ≥ 400 и `Network.loadingFailed` (текст ошибки, CORS, блокировка); отменённые пользователем/страницей (`canceled`) не считаются ошибкой.
- Проверки страницы (`page_checks`): битые картинки (видимые `img` с `complete && naturalWidth === 0`), ссылки того же сайта, отвечающие ≥ 400 (до 40 уникальных адресов, `HEAD`, при 405 — `GET`, параллельно не больше 6, таймаут 5000 мс каждая), интерактивные элементы без доступного имени, картинки без `alt`, горизонтальное переполнение страницы и элементы, вылезающие за правый край окна (до 10), перекрывающиеся интерактивные элементы (пересечение > 30 % меньшего, до 10).
- Скриншот: только видимая часть, JPEG качества 70, ширина не больше 1280 px; инструмент есть, только если у модели есть способность `vision` (Ollama `/api/show` → `capabilities`); в истории модели остаётся только последний скриншот.
- Текст со страниц в результатах — внутри маркеров `<<<page-content>>>`, как у остальных инструментов.

## Review Focus

- Ошибки, случившиеся до подключения отладчика, — сводка честно говорит, что их не видно, и предлагает `reload: true`. → тест `сводка говорит, с какого момента собрано` (Task 1).
- Страница сыплет одним и тем же сообщением тысячи раз — сводка короткая, со счётчиком, память ограничена. → тест `одинаковые сообщения группируются, лимит записей` (Task 1).
- Сайт с сотнями ссылок — проверка ссылок не длится минутами и не грузит чужие сайты. → e2e `qa` (Task 2): 40 адресов, только свой сайт, < 15 с.
- Модель без изображений — инструмента `screenshot` нет, а не ошибка при вызове. → тест `screenshot только для моделей с vision` (Task 3).
- Длинная QA-задача с несколькими скриншотами — в контекст уходит только последний. → тест `в истории остаётся последний скриншот` (Task 3).

---

### Task 1: Сбор консоли и сети в слое

**Files:**
- Create: `app/src/page/diagnostics.ts`
- Modify: `app/src/page/tools.ts` (`consoleLog`, `networkLog`), `app/src/page/frames.ts` (включить `Log`), `app/src/page/index.ts`
- Test: `app/tests/diagnostics.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ConsoleEntry { level: 'error' | 'warning'; source: 'console' | 'exception' | 'log'; text: string; url?: string; line?: number; at: number }
  export interface NetworkEntry { method: string; url: string; status?: number; error?: string; type?: string; at: number }
  export class Diagnostics {
    constructor(cdp: Cdp, limit?: number);          // подписка на события всех сессий вкладки; limit по умолчанию 300
    readonly since: number;
    console(): {entries: ConsoleEntry[]; dropped: number};
    network(): {entries: NetworkEntry[]; dropped: number};
    reset(): void;
    stop(): void;
  }
  export function summarizeConsole(d: {entries: ConsoleEntry[]; dropped: number; since: number}, level: 'error' | 'warning' | 'all'): string;
  export function summarizeNetwork(d: {entries: NetworkEntry[]; dropped: number; since: number}): string;
  ```
  Группа консоли — по `level + text`, строка: `ошибка ×12 · текст (до 300 символов) · url:строка`; сети — по `method + status|error + url без query`: `GET 404 ×3 · /api/items (fetch)`. Время «собрано с» — локальное `HH:MM:SS`.
- `PageTools.consoleLog({level?, reload?})`, `PageTools.networkLog({reload?})`: при `reload` — `diagnostics.reset()`, `navigate({action: 'reload'})`, затем сводка.

- [ ] **Step 1: Тесты:** `одинаковые сообщения группируются, лимит записей` (1000 одинаковых ошибок при лимите 300 → одна группа `×300`, строка о вытесненных 700); `сводка говорит, с какого момента собрано`; `отменённые запросы не считаются ошибкой` (событие `loadingFailed` с `canceled: true` не попадает); `summarizeNetwork` группирует по адресу без query; фейковый `Cdp` с методом `emit` для событий `Runtime.consoleAPICalled` (типы `error`, `warning`, `log` — последний не попадает), `Runtime.exceptionThrown`, `Log.entryAdded`, `Network.requestWillBeSent` + `Network.responseReceived` (404), `Network.loadingFailed`.
- [ ] **Step 2–4:** FAIL → реализация → `pnpm test && pnpm typecheck` PASS. **Step 5: Commit** `"Сбор ошибок консоли и сети"`.

---

### Task 2: Проверки страницы

**Files:**
- Create: `app/src/page/checks.ts`, `app/tests/fixtures/pages/qa.html`, `app/tests/e2e/qa.e2e.mjs`
- Modify: `app/src/page/probe.ts`, `app/src/page/tools.ts` (`pageChecks`, `consoleLog`, `networkLog` в harness), `app/src/dev/harness.ts`
- Test: `app/tests/checks.test.ts`

**Interfaces:**
- Produces: `findUnnamed(roots: ONode[]): ONode[]`, `findOverlaps(boxes: {ref: string; label: string; box: Box}[]): [string, string][]` (чистые); probe-функции `__assistant.brokenImages()`, `__assistant.imagesWithoutAlt()`, `__assistant.overflow()` (`{pageOverflow: number; elements: {text, right}[]}`), `__assistant.checkLinks(urls, opts)` (fetch из изолированного мира, правила из Global Constraints); `PageTools.pageChecks()` — отчёт по разделам, в каждом «найдено N» или «нет»; элементы с метками там, где они интерактивны.
- `qa.html`: при загрузке `console.error('Не удалось загрузить настройки')` трижды и необработанное исключение; `fetch('/missing-api')` (404) и `fetch('http://127.0.0.1:9/x')` (ошибка сети); картинка `/nope.png`; ссылка на `/missing`; три ссылки на существующие страницы; кнопка-иконка без подписи; картинка без `alt`; блок шириной 2000 px; две кнопки, наложенные друг на друга.

- [ ] **Step 1: Тесты:** `findUnnamed` на `form`-снимке с пустым именем кнопки → находится; `findOverlaps` — два прямоугольника с пересечением 50 % → пара, 10 % → нет.
- [ ] **Step 2: e2e `qa.e2e.mjs`:** после `reload: true` `consoleLog` содержит «Не удалось загрузить настройки» с `×3` и исключение; `networkLog` — 404 на `/missing-api` и ошибку сети; `pageChecks` — битая картинка, `/missing` с 404, кнопка без имени (с меткой), картинка без `alt`, переполнение, перекрытие; проверка ссылок длится < 15 с и не трогает адреса других сайтов.
- [ ] **Step 3–4:** FAIL → реализация → PASS. **Step 5: Commit** `"Проверки страницы"`.

---

### Task 3: Скриншот для моделей с изображениями

**Files:**
- Create: `app/src/agent/screenshots.ts`
- Modify: `app/src/page/tools.ts` (`screenshot(): Promise<{ok; text; image?: string}>`), `app/src/llm/ollama.ts` (`modelCapabilities`), `app/src/agent/tools.ts`, `app/src/background/chat-runner.ts`, `app/src/background/agent-session.ts`, `app/src/background/index.ts`
- Test: `app/tests/screenshots.test.ts`, `app/tests/agent-tools.test.ts`

**Interfaces:**
- Produces: `modelCapabilities(baseUrl, model, fetchFn?): Promise<string[]>` (`/api/show` → `capabilities`, при ошибке `[]`); `class ScreenshotStore { put(base64Jpeg: string): void; inject<T>(messages: T[]): T[] }` — `inject` добавляет после последнего результата инструмента `screenshot` сообщение `{role: 'user', content: [{type: 'text', text: 'Скриншот видимой части страницы (последний):'}, {type: 'image', image: <base64>, mediaType: 'image/jpeg'}]}`, более ранние скриншоты не добавляются; `PageTools.screenshot()` — `Page.captureScreenshot {format: 'jpeg', quality: 70, clip?}` с масштабом до ширины 1280; инструмент `screenshot` в `buildChatTools`/`buildAgentTools` только при `vision` (параметр `vision: boolean` в контексте), результат для модели — текст «скриншот сделан: ширина×высота, приложен к следующему сообщению».
- `prepareMessages` в обоих режимах: `elideOldPages` → `screenshots.inject` (в режиме «Чат» тоже, раз скриншот — читающий инструмент).
- [ ] **Step 1: Тесты:** `screenshot только для моделей с vision` (без `vision` ключа нет); `в истории остаётся последний скриншот` (два `put` и два результата `screenshot` в истории → одно сообщение с изображением, после последнего результата, с последней картинкой); `modelCapabilities` из фейкового `/api/show`.
- [ ] **Step 2–4:** FAIL → реализация → PASS.
- [ ] **Step 5: e2e `qa` дополняется:** `layer.call(tab, 'screenshot')` возвращает изображение JPEG шириной ≤ 1280. Commit `"Скриншот для моделей с изображениями"`.

---

### Task 4: QA-инструменты для модели и профиль

**Files:**
- Modify: `app/src/agent/tools.ts` (`console_log {level?, reload?}`, `network_log {reload?}`, `page_checks {}`; в `CHAT_TOOLS` — все три без `reload`), `app/src/agent/profiles.ts` (промпт «QA-тестировщик»: порядок работы — обойти разделы, на каждой странице `console_log`, `network_log`, `page_checks`, при необходимости `screenshot`; формат бага: страница, шаги, ожидаемо, фактически, доказательство; не выдумывать — только из инструментов), `app/src/agent/prompt.ts`, `app/src/store/assistant-db.ts` (миграция: у сохранённого профиля `qa` с промптом из этапа 1 промпт заменяется на новый, если пользователь его не менял)
- Test: `app/tests/agent-tools.test.ts`, `app/tests/assistant-db.test.ts`
- Create: в `app/tests/e2e/agent.e2e.mjs` — сценарий 5 (профиль «QA-тестировщик», `qa.html`, «Найди баги на этой странице») → в ответе ошибка консоли, 404 и битая картинка; шаги включают хотя бы два QA-инструмента.

- [ ] **Step 1: Тесты:** в агентном наборе QA-профиля есть `console_log`, `network_log`, `page_checks`; у `console_log` в режиме «Чат» нет параметра `reload`; профиль `qa` со старым промптом этапа 1 после `listProfiles` получает новый, изменённый пользователем — нет.
- [ ] **Step 2–4:** FAIL → реализация → PASS + `node build.mjs`.
- [ ] **Step 5:** `pnpm e2e agent` — сценарий 5 проходит; разбор и правка промпта при провале. Commit `"QA-инструменты для модели и профиль QA-тестировщика"`.

---

### Task 5: Итоговая проверка этапа

- [ ] **Step 1:** `pnpm install --frozen-lockfile && node build.mjs && pnpm typecheck && pnpm test && pnpm e2e && pnpm e2e agent chat-tools` — всё `ok`; `git status` чист.
- [ ] **Step 2:** README: раздел «Поиск багов» (профиль QA, что проверяется, `reload`, скриншот только для моделей с изображениями). Commit `"Этап 4: итоговая проверка и README"`.
