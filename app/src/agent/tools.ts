// The tools the model gets. Chat mode reads the current page and the notes and highlights on it; Agent mode also acts: pages, tabs,
// highlights, notes, questions to the user, and `done` to finish. Pages open lazily, on the first call.
import {tool, type ToolSet} from 'ai';
import {z} from 'zod';
import type {Profile, ToolName} from '../store/types.ts';
import type {NotesApi} from './notes.ts';
import type {ScreenshotStore} from './screenshots.ts';
import type {ActionReceipt, Expectation, SemanticTarget} from '../page/receipt.ts';
import {MUTATING_TOOLS} from './tool-policy.ts';
import {LOCATOR_KINDS, type LocatorKind} from './locator-intent.ts';

// Highlighting only draws over the page (it changes nothing the site sees), so Chat mode has it too.
export const CHAT_TOOLS: ToolName[] = ['snapshot', 'find', 'read', 'locator', 'notes_search', 'notes_read', 'console_log', 'network_log', 'page_checks', 'highlight', 'clear_highlights'];
/** Every tool is offered now; screenshot additionally depends on the model seeing images. */
const NOT_YET: ToolName[] = [];

export interface ImageOptions {
  vision?: boolean;
  screenshots?: ScreenshotStore;
  /** Agent mode: QA tools may reload the page. */
  allowReload?: boolean;
  /** User-requested locator type, enforced independently of model arguments. */
  locatorKind?: LocatorKind | null;
}

type Result = Promise<{ok: boolean; text: string; receipt?: ActionReceipt; error?: {code: string; retryable: boolean; dispatched: boolean | 'unknown'}}>;
export interface ReadTools {
  snapshot(args: {mode?: 'interactive' | 'all'; window?: 'near' | 'all'}): Result;
  find(args: {role?: string; name?: string; text?: string}): Result;
  read(args: {ref?: string}): Result;
  locator?(args: {ref: string; kind?: LocatorKind}): Result;
  screenshot?(): Promise<{ok: boolean; text: string; image?: string}>;
  consoleLog?(args: {level?: 'error' | 'warning' | 'all'; reload?: boolean}): Result;
  networkLog?(args: {reload?: boolean}): Result;
  pageChecks?(): Result;
  highlight?(args: {ref?: string; text?: string; color?: string}): Result;
  clearHighlights?(): Result;
}
export interface ActTools extends ReadTools {
  readonly revision?: number;
  click(args: {ref?: string; target?: SemanticTarget; expect?: Expectation}): Result;
  hover(args: {ref?: string; target?: SemanticTarget; expect?: Expectation}): Result;
  scroll(args: {direction: 'down' | 'up'; amount?: 'page' | 'half'; ref?: string}): Result;
  type(args: {ref?: string; target?: SemanticTarget; text: string; clear?: boolean; submit?: boolean; expect?: Expectation}): Result;
  set(args: {ref?: string; target?: SemanticTarget; value: string | boolean; expect?: Expectation}): Result;
  press(args: {key: any; ref?: string; target?: SemanticTarget; expect?: Expectation}): Result;
  wait(args: {text?: string; ref?: string; gone?: boolean; timeoutMs?: number}): Result;
  navigate(args: {url?: string; action?: 'back' | 'forward' | 'reload'; expect?: Expectation}): Result;
  handleDialog(args: {accept: boolean; text?: string; expect?: Expectation}): Result;
  highlight(args: {ref?: string; text?: string; color?: string}): Result;
  clearHighlights(): Result;
}

export interface AgentContext {
  tabs: {current(): Promise<ActTools>; list(): Promise<string>; open(url: string): Promise<string>; switch(tabId: number): Promise<string>; close(tabId: number): Promise<string>};
  notes: NotesApi;
  ask(q: {question: string; kind: 'input' | 'takeover'}): Promise<string>;
  /** Asks the user before a note is changed, in Ask mode; true when allowed. */
  confirmNotes(what: string): Promise<boolean>;
  vision?: boolean;
  screenshots?: ScreenshotStore;
  /** When the user named a locator type, it overrides whatever the model sends. */
  locatorKind?: LocatorKind | null;
}

const text = async (fn: () => Promise<string>) => { try { return await fn(); } catch (error) { return `ошибка: ${error instanceof Error ? error.message : String(error)}`; } };

function readTools(enabled: Set<ToolName>, page: () => Promise<ReadTools>, notes?: NotesApi, images: ImageOptions = {}): ToolSet {
  // Locator is a stricter form of read and follows its permission for profiles created before the tool existed.
  if (enabled.has('read')) enabled.add('locator');
  const tools: ToolSet = {};
  if (enabled.has('screenshot') && images.vision && images.screenshots) {
    const store = images.screenshots;
    tools.screenshot = tool({
      description: 'Скриншот видимой части текущей страницы: картинка будет приложена к следующему сообщению. Для вёрстки, наложений и того, чего нет в описании.',
      inputSchema: z.object({}),
      execute: async () => {
        const target = await page();
        if (!target.screenshot) return 'ошибка: скриншот недоступен';
        const r = await target.screenshot.call(target);
        if (r.image) store.put(r.image);
        return r.text;
      },
    });
  }
  // QA tools only read; reloading the page to collect from the start is an action, so only Agent mode offers it.
  const call = async (name: 'consoleLog' | 'networkLog' | 'pageChecks', args: object) => {
    const target = await page();
    const fn = target[name] as ((a: object) => Result) | undefined;
    return fn ? (await fn.call(target, args)).text : 'ошибка: инструмент недоступен';
  };
  const reload = images.allowReload ? {reload: z.boolean().optional().describe('перезагрузить страницу и собрать с начала загрузки')} : {};
  if (enabled.has('console_log')) tools.console_log = tool({
    description: 'Ошибки и предупреждения консоли страницы (сгруппированы, со счётчиком и местом в коде).',
    inputSchema: z.object({level: z.enum(['error', 'warning', 'all']).optional(), ...reload}),
    execute: async input => call('consoleLog', input),
  });
  if (enabled.has('network_log')) tools.network_log = tool({
    description: 'Упавшие сетевые запросы страницы: ответы 4xx/5xx, ошибки сети, CORS, блокировки.',
    inputSchema: z.object({...reload}),
    execute: async input => call('networkLog', input),
  });
  if (enabled.has('page_checks')) tools.page_checks = tool({
    description: 'Проверки страницы на баги: битые картинки, ссылки этого сайта с ошибкой, элементы без подписи, картинки без alt, переполнение по ширине, перекрывающиеся элементы.',
    inputSchema: z.object({}),
    execute: async () => call('pageChecks', {}),
  });
  if (enabled.has('snapshot')) tools.snapshot = tool({
    description: 'Описание текущей страницы: интерактивные элементы с метками вроде [a12] (кнопки, ссылки, поля) и заголовки. '
      + 'mode="all" добавляет текст страницы; window="all" — всю страницу, а не только около экрана.',
    inputSchema: z.object({mode: z.enum(['interactive', 'all']).optional(), window: z.enum(['near', 'all']).optional()}),
    execute: async input => (await (await page()).snapshot(input)).text,
  });
  if (enabled.has('find')) tools.find = tool({
    description: 'Найти элементы на текущей странице по роли (button, link, textbox, heading…), имени или тексту.',
    inputSchema: z.object({role: z.string().optional(), name: z.string().optional(), text: z.string().optional()}),
    execute: async input => (await (await page()).find(input)).text,
  });
  const draw = async (name: 'highlight' | 'clearHighlights', args?: object) => {
    const target = await page();
    const fn = target[name] as ((a?: object) => Result) | undefined;
    return fn ? (await fn.call(target, args)).text : 'ошибка: подсветка недоступна';
  };
  if (enabled.has('highlight')) tools.highlight = tool({
    description: 'Подсветить на странице фрагмент текста (text) или элемент (ref) цветом: yellow, green, blue, red, orange.',
    inputSchema: z.object({text: z.string().optional(), ref: z.string().describe('метка элемента из snapshot, например a12').optional(),
      color: z.enum(['yellow', 'green', 'blue', 'red', 'orange']).optional()}),
    execute: async input => draw('highlight', input),
  });
  if (enabled.has('clear_highlights')) tools.clear_highlights = tool({
    description: 'Снять подсветку на текущей странице.', inputSchema: z.object({}), execute: async () => draw('clearHighlights'),
  });
  if (enabled.has('read')) tools.read = tool({
    description: 'Прочитать текст текущей страницы в Markdown. Для CSS/XPath используй отдельный locator.',
    inputSchema: z.object({ref: z.string().optional()}),
    execute: async input => (await (await page()).read(input)).text,
  });
  if (enabled.has('locator')) tools.locator = tool({
    description: 'Получить ровно один локатор запрошенного типа для ref. Он принимается только при одном совпадении с тем же DOM-узлом через CDP/DevTools. Не добавляй свои варианты.',
    inputSchema: z.object({ref: z.string(), kind: z.enum(LOCATOR_KINDS).optional()
      .describe('xpath, css, id, testid, aria, name, class, tag, role или best; должен совпадать с запросом пользователя')}),
    execute: async input => {
      const target = await page();
      return target.locator ? (await target.locator.call(target, {...input, kind: images.locatorKind ?? input.kind ?? 'best'})).text : 'ошибка: проверка локатора недоступна';
    },
  });
  if (notes && enabled.has('notes_search')) tools.notes_search = tool({
    description: 'Найти заметки пользователя по словам из названия, текста или тегов. Возвращает id заметок.',
    inputSchema: z.object({query: z.string()}),
    execute: async ({query}) => text(() => notes.search(query)),
  });
  if (notes && enabled.has('notes_read')) tools.notes_read = tool({
    description: 'Прочитать заметку пользователя по id (из notes_search).',
    inputSchema: z.object({id: z.string()}),
    execute: async ({id}) => text(() => notes.read(id)),
  });
  return tools;
}

export function buildChatTools(profile: Profile, page: () => Promise<ReadTools>, notes?: NotesApi, images: ImageOptions = {}): ToolSet {
  return readTools(new Set(profile.tools.filter(t => CHAT_TOOLS.includes(t) || t === 'screenshot')), page, notes, {...images, allowReload: false});
}

export function buildAgentTools(profile: Profile, ctx: AgentContext): ToolSet {
  // done and ask_user are always there: without them a run cannot finish properly or hand a step to the user.
  const enabled = new Set([...profile.tools.filter(t => !NOT_YET.includes(t)), 'done' as ToolName, 'ask_user' as ToolName]);
  const tools = readTools(enabled, () => ctx.tabs.current(), ctx.notes,
    {vision: ctx.vision, screenshots: ctx.screenshots, allowReload: true, locatorKind: ctx.locatorKind});
  let verificationDebt = '';
  let consecutiveErrors = 0;
  const recent: {signature: string; outcome: string}[] = [];
  const noEffect = new Map<string, number>();
  const actionNames = MUTATING_TOOLS;
  const verificationNames = new Set<ToolName>(['snapshot', 'find', 'read', 'wait']);
  const expectation = z.object({
    url: z.string().optional().describe('часть ожидаемого URL'),
    text: z.string().optional().describe('текст должен появиться'),
    textGone: z.string().optional().describe('текст должен исчезнуть'),
    ref: z.string().optional().describe('ref проверяемого элемента; без него используется цель действия'),
    gone: z.boolean().optional(), value: z.string().optional(), checked: z.boolean().optional(),
  }).optional().describe('проверяемый результат действия; указывай, когда итог известен');

  const stable = (value: unknown): string => {
    if (!value || typeof value !== 'object') return JSON.stringify(value);
    return JSON.stringify(Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))));
  };
  const guard = (name: string, args: unknown): string | null => {
    const signature = `${name}:${stable(args)}`;
    const matching = recent.slice(-6).filter(r => r.signature === signature);
    if (matching.length >= 3 && matching.every(r => r.outcome === matching[0].outcome)) {
      return 'ошибка LOOP_GUARD: одинаковое действие уже трижды дало тот же результат. Сделайте новый snapshot и выберите другой путь.';
    }
    const ref = (args as {ref?: string} | null)?.ref;
    if (ref && (noEffect.get(`${name}:${ref}`) ?? 0) >= 2) {
      return `ошибка LOOP_GUARD: действие ${name} для ${ref} дважды не дало подтверждаемого эффекта. Сделайте snapshot; не повторяйте его вслепую.`;
    }
    if (consecutiveErrors >= 5) return 'ошибка LOOP_GUARD: пять действий подряд завершились ошибкой. Остановитесь, сделайте snapshot и измените план.';
    return null;
  };
  // Methods are called on the tab's tools object: they use `this`.
  const page = async (name: keyof ActTools, args: unknown): Promise<string> => {
    const blocked = guard(String(name), args);
    if (blocked) return blocked;
    const target = await ctx.tabs.current();
    const result = await (target[name] as (a: unknown) => Result).call(target, args);
    const signature = `${String(name)}:${stable(args)}`;
    const outcome = result.error?.code ?? result.receipt?.effect.verdict ?? (result.ok ? 'ok' : 'error');
    recent.push({signature, outcome});
    if (recent.length > 12) recent.shift();
    consecutiveErrors = result.ok ? 0 : consecutiveErrors + 1;
    const ref = (args as {ref?: string} | null)?.ref;
    if (ref) {
      const key = `${String(name)}:${ref}`;
      if (result.receipt?.effect.verdict === 'none' || result.receipt?.effect.verdict === 'unattributable') noEffect.set(key, (noEffect.get(key) ?? 0) + 1);
      else if (result.receipt) noEffect.delete(key);
    }
    if (result.receipt && (result.receipt.effect.verdict !== 'changed' || result.receipt.postcondition.verdict === 'unmet'
      || (result.receipt.consequential && result.receipt.postcondition.verdict !== 'met'))) {
      verificationDebt = `${name}: effect=${result.receipt.effect.verdict}, postcondition=${result.receipt.postcondition.verdict}`;
    } else if (result.receipt?.postcondition.verdict === 'met') verificationDebt = '';
    return result.text;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const add = (name: ToolName, def: any) => { if (enabled.has(name)) tools[name] = tool(def); };
  const ref = z.string().describe('метка элемента из snapshot, например a12');
  const target = z.object({role: z.string(), name: z.string(), nth: z.number().int().positive().optional(), within: ref.optional()})
    .describe('точное семантическое совпадение; при нескольких элементах обязательно within или nth');

  add('click', {description: 'Кликнуть по элементу. Укажите ref либо точный target. Если ожидаемый итог известен, обязательно укажите expect.', inputSchema: z.object({ref: ref.optional(), target: target.optional(), expect: expectation}), execute: async (a: {ref?: string; target?: SemanticTarget; expect?: Expectation}) => page('click', a)});
  add('hover', {description: 'Навести указатель на элемент (меню по наведению). Укажите ref либо точный target.', inputSchema: z.object({ref: ref.optional(), target: target.optional(), expect: expectation}), execute: async (a: {ref?: string; target?: SemanticTarget; expect?: Expectation}) => page('hover', a)});
  add('scroll', {description: 'Прокрутить страницу (или элемент ref) вниз или вверх.',
    inputSchema: z.object({direction: z.enum(['down', 'up']), amount: z.enum(['page', 'half']).optional(), ref: ref.optional()}),
    execute: async (a: {direction: 'down' | 'up'}) => page('scroll', a)});
  add('type', {description: 'Ввести текст в поле. clear=true заменяет текущее значение, submit=true нажимает Enter после ввода.',
    inputSchema: z.object({ref: ref.optional(), target: target.optional(), text: z.string(), clear: z.boolean().optional(), submit: z.boolean().optional(), expect: expectation}),
    execute: async (a: {ref?: string; target?: SemanticTarget; text: string; expect?: Expectation}) => page('type', a)});
  add('set', {description: 'Выбрать вариант в списке (value — текст варианта) или включить/выключить флажок (value — true/false).',
    inputSchema: z.object({ref: ref.optional(), target: target.optional(), value: z.union([z.string(), z.boolean()]), expect: expectation}), execute: async (a: {ref?: string; target?: SemanticTarget; value: string; expect?: Expectation}) => page('set', a)});
  add('press', {description: 'Нажать клавишу: Enter, Tab, Escape, Backspace, ArrowUp/Down/Left/Right, Space, PageDown, PageUp. Для Enter и Space нужен ref.',
    inputSchema: z.object({key: z.string(), ref: ref.optional(), target: target.optional(), expect: expectation}), execute: async (a: {key: string; target?: SemanticTarget; expect?: Expectation}) => page('press', a)});
  add('wait', {description: 'Подождать появления (или исчезновения, gone=true) текста или элемента; без условий — пока страница успокоится.',
    inputSchema: z.object({text: z.string().optional(), ref: ref.optional(), gone: z.boolean().optional(), timeoutMs: z.number().optional()}),
    execute: async (a: object) => page('wait', a)});
  add('navigate', {description: 'Перейти по адресу в текущей вкладке, или назад/вперёд/обновить (action).',
    inputSchema: z.object({url: z.string().optional(), action: z.enum(['back', 'forward', 'reload']).optional(), expect: expectation}), execute: async (a: object) => page('navigate', a)});
  add('handle_dialog', {description: 'Ответить на диалог страницы (alert/confirm): accept=true — OK, false — Отмена.',
    inputSchema: z.object({accept: z.boolean(), text: z.string().optional(), expect: expectation}), execute: async (a: {accept: boolean; expect?: Expectation}) => page('handleDialog', a)});
  add('tabs', {description: 'Вкладки задачи: list — список, open — открыть адрес в новой вкладке, switch/close — по tabId из списка.',
    inputSchema: z.object({action: z.enum(['list', 'open', 'switch', 'close']), url: z.string().optional(), tabId: z.number().optional()}),
    execute: async (a: {action: string; url?: string; tabId?: number}) => text(() => a.action === 'open' ? ctx.tabs.open(a.url ?? '')
      : a.action === 'switch' ? ctx.tabs.switch(a.tabId ?? -1) : a.action === 'close' ? ctx.tabs.close(a.tabId ?? -1) : ctx.tabs.list())});
  add('ask_user', {description: 'Спросить пользователя (kind="input") или передать ему шаг, который он должен сделать сам (kind="takeover": вход, оплата, капча).',
    inputSchema: z.object({question: z.string(), kind: z.enum(['input', 'takeover'])}),
    execute: async (a: {question: string; kind: 'input' | 'takeover'}) => text(() => ctx.ask(a))});
  add('notes_create', {description: 'Создать заметку пользователя. Теги передавай только в tags, не добавляй строку с тегами в body. folder — путь папки вида «Работа/QA», необязательно.',
    inputSchema: z.object({title: z.string(), body: z.string(), folder: z.string().optional(),
      tags: z.array(z.string()).optional().describe('теги заметки без символа #')}),
    execute: async (a: {title: string; body: string; folder?: string; tags?: string[]}) => text(async () => {
      if (!await ctx.confirmNotes(`Создать заметку «${a.title}»?`)) return 'ошибка USER_DECLINED: пользователь не разрешил создавать заметку.';
      return ctx.notes.create(a.title, a.body, a.folder, a.tags);
    })});
  add('notes_append', {description: 'Изменить существующую заметку по id: дописать обычный текст через text и/или добавить настоящие теги через tags. Никогда не записывай хэштеги в text.',
    inputSchema: z.object({id: z.string(), text: z.string().optional(),
      tags: z.array(z.string()).optional().describe('добавляемые теги без символа #')}),
    execute: async (a: {id: string; text?: string; tags?: string[]}) => text(async () => {
      if (!a.text && !a.tags?.length) return 'ошибка: укажите text или tags.';
      if (!await ctx.confirmNotes(`Изменить заметку ${a.id}?`)) return 'ошибка USER_DECLINED: пользователь не разрешил менять заметку.';
      return ctx.notes.append(a.id, a.text, a.tags);
    })});
  add('done', {description: 'Закончить задачу: outcome — success, partial или failed; summary — ответ пользователю.',
    inputSchema: z.object({outcome: z.enum(['success', 'partial', 'failed']), summary: z.string()}),
    execute: async (a: {outcome: 'success' | 'partial' | 'failed'; summary: string}) => {
      if (a.outcome === 'success' && verificationDebt) return `ошибка VERIFICATION_REQUIRED: после ${verificationDebt} результат не проверен. Сначала вызовите snapshot/read/wait, затем завершите задачу.`;
      return a.summary;
    }});
  // The model may call several tools in one turn; one page cannot take two actions at once, so they run in order.
  let queue: Promise<unknown> = Promise.resolve();
  let mutationGeneration = 0;
  for (const [toolName, def] of Object.entries(tools)) {
    const execute = def.execute;
    if (!execute) continue;
    def.execute = (input: unknown, options: unknown) => {
      const enqueuedAt = mutationGeneration;
      const run = queue.then(async () => {
        const name = toolName as ToolName;
        // Several tool calls emitted in one model turn were planned against one page state. Once the first mutation
        // runs, the rest must be replanned from its receipt instead of acting on stale refs.
        if (enqueuedAt !== mutationGeneration && actionNames.has(name)) {
          return 'ошибка PAGE_CHANGED: предыдущее действие изменило состояние. Сделайте новый snapshot и вызовите следующий инструмент отдельно.';
        }
        const output = await (execute as (i: unknown, o: unknown) => unknown)(input, options);
        const value = String(output ?? '');
        if (verificationNames.has(name) && !value.startsWith('ошибка')) {
          verificationDebt = '';
          consecutiveErrors = 0;
        }
        if (actionNames.has(name) && (!value.startsWith('ошибка') || value.includes('dispatched=true'))) mutationGeneration++;
        return output;
      });
      queue = run.catch(() => {});
      return run as never;
    };
  }
  return tools;
}

/** The arguments of a tool call in a few words, for the step line in the panel. */
export function describeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  return Object.entries(input as Record<string, unknown>).filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => (k === 'name' || k === 'text' || k === 'query' || k === 'question' ? `"${String(v).slice(0, 40)}"` : k === 'ref' || k === 'summary' ? String(v).slice(0, 40) : `${k}=${String(v)}`))
    .join(' ').slice(0, 80);
}
