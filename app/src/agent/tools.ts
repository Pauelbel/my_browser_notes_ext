// The tools the model gets. Chat mode reads the current page and the notes; Agent mode also acts: pages, tabs,
// highlights, notes, questions to the user, and `done` to finish. Pages open lazily, on the first call.
import {tool, type ToolSet} from 'ai';
import {z} from 'zod';
import type {Profile, ToolName} from '../store/types.ts';
import type {NotesApi} from './notes.ts';
import type {ScreenshotStore} from './screenshots.ts';

export const CHAT_TOOLS: ToolName[] = ['snapshot', 'find', 'read', 'notes_search', 'notes_read', 'console_log', 'network_log', 'page_checks'];
/** Every tool is offered now; screenshot additionally depends on the model seeing images. */
const NOT_YET: ToolName[] = [];

export interface ImageOptions { vision?: boolean; screenshots?: ScreenshotStore; /** Agent mode: QA tools may reload the page. */ allowReload?: boolean }

type Result = Promise<{ok: boolean; text: string}>;
export interface ReadTools {
  snapshot(args: {mode?: 'interactive' | 'all'; window?: 'near' | 'all'}): Result;
  find(args: {role?: string; name?: string; text?: string}): Result;
  read(args: {ref?: string}): Result;
  screenshot?(): Promise<{ok: boolean; text: string; image?: string}>;
  consoleLog?(args: {level?: 'error' | 'warning' | 'all'; reload?: boolean}): Result;
  networkLog?(args: {reload?: boolean}): Result;
  pageChecks?(): Result;
}
export interface ActTools extends ReadTools {
  click(args: {ref: string}): Result;
  hover(args: {ref: string}): Result;
  scroll(args: {direction: 'down' | 'up'; amount?: 'page' | 'half'; ref?: string}): Result;
  type(args: {ref: string; text: string; clear?: boolean; submit?: boolean}): Result;
  set(args: {ref: string; value: string | boolean}): Result;
  press(args: {key: any; ref?: string}): Result;
  wait(args: {text?: string; ref?: string; gone?: boolean; timeoutMs?: number}): Result;
  navigate(args: {url?: string; action?: 'back' | 'forward' | 'reload'}): Result;
  handleDialog(args: {accept: boolean; text?: string}): Result;
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
}

const text = async (fn: () => Promise<string>) => { try { return await fn(); } catch (error) { return `ошибка: ${error instanceof Error ? error.message : String(error)}`; } };

function readTools(enabled: Set<ToolName>, page: () => Promise<ReadTools>, notes?: NotesApi, images: ImageOptions = {}): ToolSet {
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
  if (enabled.has('read')) tools.read = tool({
    description: 'Прочитать текст текущей страницы в Markdown, целиком или внутри элемента с меткой ref.',
    inputSchema: z.object({ref: z.string().optional()}),
    execute: async input => (await (await page()).read(input)).text,
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
  const tools = readTools(enabled, () => ctx.tabs.current(), ctx.notes, {vision: ctx.vision, screenshots: ctx.screenshots, allowReload: true});
  // Methods are called on the tab's tools object: they use `this`.
  const page = async (name: keyof ActTools, args: unknown): Promise<string> => {
    const target = await ctx.tabs.current();
    return (await (target[name] as (a: unknown) => Result).call(target, args)).text;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const add = (name: ToolName, def: any) => { if (enabled.has(name)) tools[name] = tool(def); };
  const ref = z.string().describe('метка элемента из snapshot, например a12');

  add('click', {description: 'Кликнуть по элементу.', inputSchema: z.object({ref}), execute: async (a: {ref: string}) => page('click', a)});
  add('hover', {description: 'Навести указатель на элемент (меню по наведению).', inputSchema: z.object({ref}), execute: async (a: {ref: string}) => page('hover', a)});
  add('scroll', {description: 'Прокрутить страницу (или элемент ref) вниз или вверх.',
    inputSchema: z.object({direction: z.enum(['down', 'up']), amount: z.enum(['page', 'half']).optional(), ref: ref.optional()}),
    execute: async (a: {direction: 'down' | 'up'}) => page('scroll', a)});
  add('type', {description: 'Ввести текст в поле. clear=true заменяет текущее значение, submit=true нажимает Enter после ввода.',
    inputSchema: z.object({ref, text: z.string(), clear: z.boolean().optional(), submit: z.boolean().optional()}),
    execute: async (a: {ref: string; text: string}) => page('type', a)});
  add('set', {description: 'Выбрать вариант в списке (value — текст варианта) или включить/выключить флажок (value — true/false).',
    inputSchema: z.object({ref, value: z.union([z.string(), z.boolean()])}), execute: async (a: {ref: string; value: string}) => page('set', a)});
  add('press', {description: 'Нажать клавишу: Enter, Tab, Escape, Backspace, ArrowUp/Down/Left/Right, Space, PageDown, PageUp. Для Enter и Space нужен ref.',
    inputSchema: z.object({key: z.string(), ref: ref.optional()}), execute: async (a: {key: string}) => page('press', a)});
  add('wait', {description: 'Подождать появления (или исчезновения, gone=true) текста или элемента; без условий — пока страница успокоится.',
    inputSchema: z.object({text: z.string().optional(), ref: ref.optional(), gone: z.boolean().optional(), timeoutMs: z.number().optional()}),
    execute: async (a: object) => page('wait', a)});
  add('navigate', {description: 'Перейти по адресу в текущей вкладке, или назад/вперёд/обновить (action).',
    inputSchema: z.object({url: z.string().optional(), action: z.enum(['back', 'forward', 'reload']).optional()}), execute: async (a: object) => page('navigate', a)});
  add('handle_dialog', {description: 'Ответить на диалог страницы (alert/confirm): accept=true — OK, false — Отмена.',
    inputSchema: z.object({accept: z.boolean(), text: z.string().optional()}), execute: async (a: {accept: boolean}) => page('handleDialog', a)});
  add('highlight', {description: 'Подсветить на странице фрагмент текста (text) или элемент (ref) цветом: yellow, green, blue, red, orange.',
    inputSchema: z.object({text: z.string().optional(), ref: ref.optional(), color: z.enum(['yellow', 'green', 'blue', 'red', 'orange']).optional()}),
    execute: async (a: object) => page('highlight', a)});
  add('clear_highlights', {description: 'Снять подсветку на текущей странице.', inputSchema: z.object({}), execute: async () => page('clearHighlights', undefined as never)});
  add('tabs', {description: 'Вкладки задачи: list — список, open — открыть адрес в новой вкладке, switch/close — по tabId из списка.',
    inputSchema: z.object({action: z.enum(['list', 'open', 'switch', 'close']), url: z.string().optional(), tabId: z.number().optional()}),
    execute: async (a: {action: string; url?: string; tabId?: number}) => text(() => a.action === 'open' ? ctx.tabs.open(a.url ?? '')
      : a.action === 'switch' ? ctx.tabs.switch(a.tabId ?? -1) : a.action === 'close' ? ctx.tabs.close(a.tabId ?? -1) : ctx.tabs.list())});
  add('ask_user', {description: 'Спросить пользователя (kind="input") или передать ему шаг, который он должен сделать сам (kind="takeover": вход, оплата, капча).',
    inputSchema: z.object({question: z.string(), kind: z.enum(['input', 'takeover'])}),
    execute: async (a: {question: string; kind: 'input' | 'takeover'}) => text(() => ctx.ask(a))});
  add('notes_create', {description: 'Создать заметку пользователя (folder — путь папки вида «Работа/QA», необязательно).',
    inputSchema: z.object({title: z.string(), body: z.string(), folder: z.string().optional()}),
    execute: async (a: {title: string; body: string; folder?: string}) => text(() => ctx.notes.create(a.title, a.body, a.folder))});
  add('notes_append', {description: 'Дописать текст в конец заметки пользователя по id.', inputSchema: z.object({id: z.string(), text: z.string()}),
    execute: async (a: {id: string; text: string}) => text(async () => {
      if (!await ctx.confirmNotes(`Дописать в заметку ${a.id}?`)) return 'ошибка USER_DECLINED: пользователь не разрешил менять заметку.';
      return ctx.notes.append(a.id, a.text);
    })});
  add('done', {description: 'Закончить задачу: outcome — success, partial или failed; summary — ответ пользователю.',
    inputSchema: z.object({outcome: z.enum(['success', 'partial', 'failed']), summary: z.string()}),
    execute: async (a: {summary: string}) => a.summary});
  // The model may call several tools in one turn; one page cannot take two actions at once, so they run in order.
  let queue: Promise<unknown> = Promise.resolve();
  for (const def of Object.values(tools)) {
    const execute = def.execute;
    if (!execute) continue;
    def.execute = (input: unknown, options: unknown) => {
      const run = queue.then(() => (execute as (i: unknown, o: unknown) => unknown)(input, options));
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
