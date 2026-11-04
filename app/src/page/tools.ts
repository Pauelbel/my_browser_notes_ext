// The layer's tools on one tab, for the agent and for the e2e harness. Each returns text for the model; page text
// sits between page-content markers, and a layer error becomes a result the model can act on, never an exception.
import {Observer} from './observe.ts';
import {RefRegistry} from './refs.ts';
import type {PageSession} from './session.ts';
import {PageError} from './errors.ts';
import type {OutlineMode, WindowMode} from './render.ts';
import {resolveTarget, type Target} from './resolve.ts';
import {waitActionable, type Actionable} from './actionability.ts';
import {startWatch, type Evidence} from './evidence.ts';
import {click, hover, pressKey, wheel, watchDialog, KEYS, type DialogInfo, type KeyName} from './input.ts';
import {focusTarget, isChecked, isFocused, isSelect, selectOption, targetFacts, typeInto} from './act.ts';
import {diffLines, renderDiff} from './diff.ts';
import {render} from './render.ts';
import {waitForReady} from './readiness.ts';
import {probeEval} from './probe.ts';
import type {ONode} from './outline.ts';
import {classify, USER_STEP, type Category} from './classify.ts';
import {isSecretField} from './masking.ts';
import {siteOf} from './site.ts';
import {checkColor, Highlighter, type HighlightColor} from './highlight.ts';

export interface ToolResult {
  text: string;
  ok: boolean;
}

export interface GateQuestion { action: string; ref: string; role: string; name: string; category: Category; site: string; url: string }
export type GateAnswer = {decision: 'allow'} | {decision: 'deny'} | {decision: 'user-did-it'} | {decision: 'cancel'};
/** What the agent above the layer decides about a dangerous action; the layer only asks and obeys. */
export interface Gate { check(q: GateQuestion): Promise<GateAnswer>; blocked(site: string): boolean }

const CATEGORY_TEXT: Record<Category, string> = {
  pay: 'оплата', access: 'выдача доступа', secret: 'ввод секрета', delete: 'удаление', logout: 'выход из аккаунта', send: 'отправка', submit: 'отправка формы',
};
const ORDER: Category[] = ['pay', 'access', 'secret', 'delete', 'logout', 'send', 'submit'];

export const PAGE_START = '<<<page-content>>>';
const NAVIGATION_TIMEOUT_MS = 15000;
const WAIT_POLL_MS = 250;
const fold = (s: string) => s.toLocaleLowerCase('ru').replaceAll('ё', 'е');
const flat = (nodes: ONode[]): ONode[] => nodes.flatMap(n => [n, ...flat(n.children)]);

/** Adds https:// to a bare address; refuses schemes that are not web pages. */
export function normalizeUrl(input: string): string {
  const url = input.trim();
  if (!url) throw new PageError('NOT_FOUND', 'Не указан адрес.');
  if (/^(javascript|file|chrome|chrome-extension|chrome-untrusted|devtools|view-source|data|about|blob):/i.test(url)) {
    throw new PageError('PAGE_NOT_SUPPORTED', `Адрес ${url.slice(0, 60)} не открывается помощником: только обычные страницы http и https.`);
  }
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}
export const PAGE_END = '<<<end-page-content>>>';

/** Page text can never close or open the data block: runs of three angle brackets are replaced. */
export function neutralize(text: string): string {
  return text.replace(/<{3,}/g, '‹‹‹').replace(/>{3,}/g, '›››');
}

/** A tool result: everything derived from the page (title, address, names, text) goes between the markers. */
export function pageText(head: string, body: string, notices: string[]): string {
  return [PAGE_START, ...[head, body].filter(Boolean).map(neutralize), PAGE_END, ...notices.map(neutralize)].join('\n');
}

export function errorResult(error: unknown): ToolResult {
  if (error instanceof PageError) {
    const delivered = error.delivered === true ? ' Событие ввода было отправлено: проверьте страницу, прежде чем повторять.'
      : error.delivered === 'unknown' ? ' Неизвестно, дошло ли событие ввода: проверьте страницу, прежде чем повторять.' : '';
    return {ok: false, text: `ошибка ${error.code}: ${neutralize(error.message)}${delivered}`};
  }
  return {ok: false, text: `ошибка INTERNAL: ${neutralize(error instanceof Error ? error.message : String(error))}`};
}

export class PageTools {
  readonly session: PageSession;
  readonly refs: RefRegistry;
  readonly observer: Observer;
  budget: number;
  readonly highlighter: Highlighter;
  /** Highlights made in this session, by page address, so going back to a page shows them again. */
  readonly #highlights: {url: string; text?: string; element?: {role: string; name: string}; color: HighlightColor}[] = [];
  /** A page dialog that is open now; while it is, the page answers nothing but handleDialog. */
  dialog: DialogInfo | undefined;

  gate: Gate | undefined;

  constructor(session: PageSession, options: {budget: number; gate?: Gate}) {
    this.session = session;
    this.budget = options.budget;
    this.gate = options.gate;
    this.refs = new RefRegistry(session.epoch);
    this.observer = new Observer(session, this.refs);
    this.highlighter = new Highlighter(session, this.observer.probes);
    session.cdp.on((method, _params, sessionId) => { if (method === 'Page.loadEventFired' && !sessionId) setTimeout(() => void this.#restoreHighlights(), 300); });
    session.cdp.on(method => { if (method === 'Page.javascriptDialogClosed') this.dialog = undefined; });
    session.cdp.on((method, params) => { if (method === 'Page.javascriptDialogOpening') this.dialog = {type: params.type, message: params.message}; });
    // A frame that loads a new document makes its labels stale.
    session.frames.onChange(() => { for (const f of session.frames.list()) this.refs.invalidateFrame(f.frameId, f.loaderId); });
  }

  /** Runs a tool. A plain string result is page-derived text (a receipt names page elements) and goes inside the markers. */
  protected async run(fn: () => Promise<string | {head: string; body: string; notices: string[]}>, allowDuringDialog = false): Promise<ToolResult> {
    try {
      if (this.dialog && !allowDuringDialog) {
        throw new PageError('DIALOG_OPEN', `На странице открыт диалог ${this.dialog.type}: «${this.dialog.message}». Ответьте на него (handle_dialog), если этот инструмент есть, иначе попросите пользователя закрыть диалог.`);
      }
      const out = await fn();
      return {ok: true, text: typeof out === 'string' ? pageText('', out, []) : pageText(out.head, out.body, out.notices)};
    } catch (error) {
      return errorResult(error);
    }
  }

  snapshot(args: {mode?: OutlineMode; window?: WindowMode} = {}): Promise<ToolResult> {
    return this.run(async () => {
      const o = await this.observer.snapshot({...args, budget: this.budget});
      return {head: o.header, body: o.body, notices: o.notices};
    });
  }

  find(args: {role?: string; name?: string; text?: string}): Promise<ToolResult> {
    return this.run(async () => {
      const r = await this.observer.find(args, this.budget);
      return {head: r.header, body: r.body, notices: r.notices};
    });
  }

  read(args: {ref?: string} = {}): Promise<ToolResult> {
    return this.run(async () => {
      const r = await this.observer.read({ref: args.ref, budget: this.budget});
      return {head: r.header, body: r.body, notices: r.notices};
    });
  }

  /** The page around the screen as full lines (text included), for the diff in a receipt. */
  async #describe(): Promise<string[]> {
    const {capture, roots} = await this.observer.observe();
    return render(roots, this.refs, {mode: 'all', window: 'near', budget: this.budget, viewport: capture.viewport}).body.split('\n');
  }

  /**
   * One action on one label: resolve, check, watch, dispatch, settle, describe again. Retries happen only before
   * dispatch; after it, a failure says the event was sent.
   */
  async #act(verb: string, ref: string, needs: {pointer: boolean; editable?: boolean},
    dispatch: (t: Target, a: Actionable, dialog: Promise<DialogInfo>) => Promise<{dialog?: DialogInfo; note?: string} | void>,
    actions: ('activate' | 'enter' | 'type')[] = []): Promise<string> {
    let target = await resolveTarget(this.session, this.refs, ref, this.observer.probes);
    let actionable = await waitActionable(this.session, target, needs, this.observer.probes);
    const verdict = await this.#gate(verb, ref, target, actions);
    if (verdict === 'user-did-it') return `${verb} [${ref}] ${target.record.role} "${target.record.name}": шаг выполнен пользователем сам, событие помощником не отправлено`;
    if (verdict === 'asked') {
      // The page may have changed while the user decided: the target is checked again from scratch.
      target = await resolveTarget(this.session, this.refs, ref, this.observer.probes);
      actionable = await waitActionable(this.session, target, needs, this.observer.probes);
    }
    // The baseline comes after the checks, which may have scrolled the target into view: scrolling is not a reaction.
    const before = await this.#describe();
    return this.#dispatchAndReport(`${verb} [${ref}] ${target.record.role} "${target.record.name}"`, before, [target.frame.frameId],
      dialog => dispatch(target, actionable, dialog), target.record.proxy === 'label' ? ` (клик по связанной подписи "${target.record.name}")` : '');
  }

  /** Classifies the action and asks the gate. 'go' when nothing needed asking. */
  async #gate(verb: string, ref: string, target: Target, actions: ('activate' | 'enter' | 'type')[]): Promise<'go' | 'asked' | 'user-did-it'> {
    if (!actions.length) return 'go';
    const facts = await targetFacts(this.session, target);
    if (facts.href && this.gate?.blocked(siteOf(facts.href))) throw new PageError('SITE_BLOCKED', `Сайт ${siteOf(facts.href)} заблокирован пользователем: ссылку не открываю.`);
    if (!this.gate) return 'go';
    const found = actions.map(action => classify({action, role: target.record.role, name: target.record.name, tag: facts.tag, type: facts.type,
      inForm: facts.inForm, formHasPassword: facts.formHasPassword, secretField: isSecretField(facts.attrs), nearbyText: facts.nearby}))
      .filter((c): c is Category => c !== null);
    if (!found.length) return 'go';
    const category = ORDER.find(c => found.includes(c))!;
    const url = this.session.frames.main().url;
    const answer = await this.gate.check({action: verb, ref, role: target.record.role, name: target.record.name, category, site: siteOf(url), url});
    if (answer.decision === 'allow') return 'asked';
    if (answer.decision === 'user-did-it') return 'user-did-it';
    throw new PageError('USER_DECLINED', `Пользователь не разрешил: ${verb} «${target.record.name}» (${CATEGORY_TEXT[category]}). Событие не отправлено; не пытайтесь сделать это другим способом.`);
  }

  async #dispatchAndReport(what: string, before: string[], frameIds: string[],
    dispatch: (dialog: Promise<DialogInfo>) => Promise<{dialog?: DialogInfo; note?: string} | void>, suffix = ''): Promise<string> {
    const watch = await startWatch(this.session, this.observer.probes, frameIds);
    const dialog = watchDialog(this.session);
    let note = '';
    try {
      const result = await dispatch(dialog.opened);
      note = result?.note ?? '';
    } catch (error) {
      watch.stop(); dialog.off();
      if (error instanceof PageError && error.delivered === false) error.delivered = 'unknown';
      throw error;
    }
    const evidence = await watch.settle(() => dialog.current());
    dialog.off();
    let effect: string;
    try {
      effect = await this.#effectText(evidence, before);
    } catch (error) {
      // A dialog that opened after the reaction window is still this action's reaction.
      if (!(error instanceof PageError && error.code === 'DIALOG_OPEN') || !this.dialog) throw error;
      effect = `открыт диалог ${this.dialog.type}: «${this.dialog.message}». Ответьте через handle_dialog.`;
    }
    return `${what}${suffix}: событие отправлено${note ? ` · ${note}` : ''} · реакция: ${effect}`;
  }

  async #effectText(e: Evidence, before: string[]): Promise<string> {
    const counts = `мутаций ${e.mutations}, запросов ${e.requests}`;
    if (e.effect === 'dialog') {
      this.dialog = e.dialog;
      return `открыт диалог ${e.dialog!.type}: «${e.dialog!.message}». Ответьте через handle_dialog.`;
    }
    if (e.effect === 'new_tab') return `открыта новая вкладка ${e.url ?? ''}`.trim();
    if (e.effect === 'navigated') {
      const o = await this.observer.snapshot({budget: this.budget});
      return `переход на ${e.url ?? o.capture.url}\nновая страница: ${o.header}\nСделайте snapshot, чтобы увидеть её элементы.`;
    }
    const diff = renderDiff(diffLines(before, await this.#describe()));
    let head = e.effect === 'changed' ? `страница изменилась (${counts})` : e.effect === 'requests' ? `ушли запросы (${e.requests}), описание около экрана не изменилось` : 'видимой реакции нет';
    if (e.sameDocument) head = `адрес изменился на ${e.sameDocument} (без перезагрузки) · ${head}`;
    if (e.notCommitted) head = `переход на ${e.notCommitted} запрошен, но не произошёл (загрузка файла, пустой ответ или отмена) · ${head}`;
    return diff ? `${head}\nизменения:\n${diff}` : head;
  }

  click(args: {ref: string}): Promise<ToolResult> {
    return this.run(() => this.#act('click', args.ref, {pointer: true}, (_t, a, dialog) => click(this.session, a.point, dialog), ['activate']));
  }

  hover(args: {ref: string}): Promise<ToolResult> {
    return this.run(() => this.#act('hover', args.ref, {pointer: true}, async (_t, a) => { await hover(this.session, a.point); }));
  }

  type(args: {ref: string; text: string; clear?: boolean; submit?: boolean}): Promise<ToolResult> {
    return this.run(() => this.#act('type', args.ref, {pointer: false, editable: true}, async (t, a, dialog) => {
      await focusTarget(this.session, t, a.point, dialog);
      await typeInto(this.session, t, args.text, Boolean(args.clear), dialog);
      if (args.submit) { const r = await pressKey(this.session, 'Enter', dialog); if (r.dialog) return r; }
      return {note: `введено символов: ${args.text.length}${args.submit ? ', нажат Enter' : ''}`};
    }, args.submit ? ['type', 'enter'] : ['type']));
  }

  set(args: {ref: string; value: string | boolean}): Promise<ToolResult> {
    return this.run(async () => {
      const probe = await resolveTarget(this.session, this.refs, args.ref, this.observer.probes);
      if (await isSelect(this.session, probe)) {
        return this.#act('set', args.ref, {pointer: false}, async t => ({note: `выбрано «${await selectOption(this.session, t, String(args.value))}»`}));
      }
      const want = args.value === true || args.value === 'true' || args.value === 'on';
      return this.#act('set', args.ref, {pointer: true}, async (t, a, dialog) => {
        if (await isChecked(this.session, t) === want) return {note: `уже ${want ? 'включено' : 'выключено'}`};
        const r = await click(this.session, a.point, dialog);
        if (r.dialog) return r;
        if (await isChecked(this.session, t) !== want) throw new PageError('VALUE_MISMATCH', `Состояние элемента ${args.ref} не изменилось после клика.`, true);
        return {note: want ? 'включено' : 'выключено'};
      }, ['activate']);
    });
  }

  press(args: {key: KeyName; ref?: string}): Promise<ToolResult> {
    return this.run(async () => {
      if (!(args.key in KEYS)) throw new PageError('NOT_FOUND', `Клавиша ${args.key} не поддерживается. Есть: ${Object.keys(KEYS).join(', ')}.`);
      if (!args.ref && (args.key === 'Enter' || args.key === 'Space')) {
        throw new PageError('NOT_FOUND', `Для ${args.key} укажите ref элемента: так помощник знает, что именно нажимается.`);
      }
      if (args.ref) {
        // The key goes to whatever has focus, so the target must hold it before anything is sent.
        const target = await resolveTarget(this.session, this.refs, args.ref, this.observer.probes);
        await waitActionable(this.session, target, {pointer: false}, this.observer.probes);
        await this.session.cdp.send('DOM.focus', {backendNodeId: target.record.backendNodeId}, target.frame.sessionId).catch(() => {});
        if (!await isFocused(this.session, target)) {
          throw new PageError('NOT_EDITABLE', `Элемент ${args.ref} не принимает фокус клавиатуры: клавиша не отправлена. Для него используйте click.`);
        }
        if (args.key === 'Enter' || args.key === 'Space') {
          const control = ['button', 'link', 'checkbox', 'radio', 'switch', 'menuitem', 'tab', 'clickable'].includes(target.record.role);
          const verdict = await this.#gate(`press ${args.key}`, args.ref, target, [control ? 'activate' : 'enter']);
          if (verdict === 'user-did-it') return `press ${args.key} [${args.ref}]: шаг выполнен пользователем сам, событие помощником не отправлено`;
        }
        const before = await this.#describe();
        return this.#dispatchAndReport(`press ${args.key} [${args.ref}] ${target.record.role} "${target.record.name}"`, before, [target.frame.frameId],
          dialog => pressKey(this.session, args.key, dialog));
      }
      return this.#dispatchAndReport(`press ${args.key}`, await this.#describe(), [], dialog => pressKey(this.session, args.key, dialog));
    });
  }

  scroll(args: {ref?: string; direction: 'down' | 'up'; amount?: 'page' | 'half'}): Promise<ToolResult> {
    return this.run(async () => {
      const {capture} = await this.observer.observe();
      const delta = Math.round(capture.viewport.height * (args.amount === 'half' ? 0.5 : 0.85)) * (args.direction === 'up' ? -1 : 1);
      let point = {x: capture.viewport.width / 2, y: capture.viewport.height / 2};
      let what = `scroll ${args.direction}`;
      if (args.ref) {
        const target = await resolveTarget(this.session, this.refs, args.ref, this.observer.probes);
        point = (await waitActionable(this.session, target, {pointer: false}, this.observer.probes)).point;
        what += ` в [${args.ref}]`;
      }
      await wheel(this.session, point, delta);
      await new Promise(r => setTimeout(r, 400));
      const o = await this.observer.snapshot({budget: this.budget});
      return `${what}: прокручено · ${o.header}`;
    });
  }

  navigate(args: {url?: string; action?: 'back' | 'forward' | 'reload'}): Promise<ToolResult> {
    return this.run(async () => {
      const {cdp} = this.session;
      let what: string;
      let status: number | undefined;
      const mainId = this.session.frames.main().frameId;
      let done!: () => void;
      const arrived = new Promise<void>(r => { done = r; });
      const off = cdp.on((method, params, sessionId) => {
        if (sessionId) return;
        if (method === 'Network.responseReceived' && params.type === 'Document' && params.frameId === mainId) status = params.response.status;
        if (method === 'Page.loadEventFired') done();
      });
      try {
        if (args.action === 'back' || args.action === 'forward') {
          const {currentIndex, entries} = await cdp.send<{currentIndex: number; entries: {id: number; url: string}[]}>('Page.getNavigationHistory');
          const entry = entries[currentIndex + (args.action === 'back' ? -1 : 1)];
          if (!entry) throw new PageError('NOT_FOUND', args.action === 'back' ? 'Назад некуда: это первая страница в истории вкладки.' : 'Вперёд некуда.');
          what = args.action === 'back' ? 'назад' : 'вперёд';
          // A page restored from the back-forward cache fires no load event; its navigation is enough.
          const restored = cdp.on((method, params, sessionId) => { if (!sessionId && method === 'Page.frameNavigated' && !params.frame.parentId) setTimeout(done, 300); });
          await cdp.send('Page.navigateToHistoryEntry', {entryId: entry.id});
          await Promise.race([arrived, new Promise(r => setTimeout(r, NAVIGATION_TIMEOUT_MS))]);
          restored();
        } else if (args.action === 'reload') {
          what = 'обновление';
          await cdp.send('Page.reload', {});
          await Promise.race([arrived, new Promise(r => setTimeout(r, NAVIGATION_TIMEOUT_MS))]);
        } else {
          const url = normalizeUrl(args.url ?? '');
          if (this.gate?.blocked(siteOf(url))) throw new PageError('SITE_BLOCKED', `Сайт ${siteOf(url)} заблокирован пользователем.`);
          what = `переход на ${url}`;
          const r = await cdp.send<{errorText?: string}>('Page.navigate', {url});
          if (r.errorText) throw new PageError('NOT_FOUND', `Не удалось открыть ${url}: ${r.errorText}.`);
          await Promise.race([arrived, new Promise(r => setTimeout(r, NAVIGATION_TIMEOUT_MS))]);
        }
      } finally {
        off();
      }
      const o = await this.observer.snapshot({budget: this.budget});
      return `${what}: ${status ? `HTTP ${status} · ` : ''}${o.header}\nСделайте snapshot, чтобы увидеть элементы страницы.`;
    });
  }

  wait(args: {text?: string; ref?: string; gone?: boolean; timeoutMs?: number}): Promise<ToolResult> {
    return this.run(async () => {
      const timeout = Math.min(30000, Math.max(100, args.timeoutMs ?? 5000));
      if (!args.text && !args.ref) {
        const r = await waitForReady(this.session, this.observer.network, this.observer.probes, timeout);
        if (!r.ready) throw new PageError('TIMEOUT', `Страница не успокоилась за ${timeout} мс (${r.reason}).`);
        return `страница готова за ${r.waitedMs} мс`;
      }
      const record = args.ref ? this.refs.get(args.ref) : undefined;
      const want = args.text ? fold(args.text) : '';
      const started = Date.now();
      for (;;) {
        const {roots} = await this.observer.quick();
        const nodes = flat(roots);
        const present = record
          ? nodes.some(n => n.backendNodeId === record.backendNodeId && n.loaderId === record.loaderId)
          : nodes.some(n => fold(`${n.name} ${n.value ?? ''}`).includes(want));
        if (present !== Boolean(args.gone)) {
          const subject = args.text ? `текст «${args.text}»` : `элемент ${args.ref}`;
          return `${subject} ${args.gone ? 'исчез' : 'появился'} через ${Date.now() - started} мс`;
        }
        if (Date.now() - started >= timeout) {
          const subject = args.text ? `текста «${args.text}»` : `элемента ${args.ref}`;
          throw new PageError('TIMEOUT', `Не дождался ${args.gone ? 'исчезновения' : 'появления'} ${subject} за ${timeout} мс.`);
        }
        await new Promise(r => setTimeout(r, WAIT_POLL_MS));
      }
    });
  }

  highlight(args: {ref?: string; text?: string; color?: string}): Promise<ToolResult> {
    return this.run(async () => {
      const color = checkColor(args.color);
      if (Boolean(args.ref) === Boolean(args.text)) throw new PageError('NOT_FOUND', 'Укажите ровно одно: ref (элемент) или text (фрагмент текста).');
      const url = this.session.frames.main().url;
      if (args.text) {
        const count = await this.highlighter.text(args.text, color);
        if (!count) throw new PageError('NOT_FOUND', `Текст «${args.text}» не найден среди видимого текста страницы.`);
        this.#highlights.push({url, text: args.text, color});
        return `выделено мест: ${count} (цвет ${color})`;
      }
      const target = await resolveTarget(this.session, this.refs, args.ref!, this.observer.probes);
      await this.highlighter.element(target, color);
      this.#highlights.push({url, element: {role: target.record.role, name: target.record.name}, color});
      return `элемент [${args.ref}] ${target.record.role} "${target.record.name}" обведён (цвет ${color})`;
    });
  }

  /** The frame around a page the agent works on; best effort, a page that is gone has nothing to frame. */
  async border(on: boolean): Promise<void> {
    await probeEval(this.session, this.session.frames.main().frameId, this.observer.probes, `__assistant.border(${on}, 'rgba(124, 92, 255, 0.85)')`).catch(() => {});
  }

  clearHighlights(): Promise<ToolResult> {
    return this.run(async () => {
      await this.highlighter.clear();
      const url = this.session.frames.main().url;
      for (let i = this.#highlights.length - 1; i >= 0; i--) if (this.#highlights[i].url === url) this.#highlights.splice(i, 1);
      return 'подсветка снята';
    });
  }

  async #restoreHighlights(): Promise<void> {
    const url = this.session.frames.main().url;
    const mine = this.#highlights.filter(h => h.url === url);
    if (!mine.length) return;
    try {
      for (const h of mine.filter(h => h.text)) await this.highlighter.text(h.text!, h.color);
      const wanted = mine.filter(h => h.element);
      if (!wanted.length) return;
      const {roots} = await this.observer.quick();
      for (const h of wanted) {
        const node = flat(roots).find(n => n.role === h.element!.role && n.name === h.element!.name && n.backendNodeId !== undefined);
        if (!node) continue;
        const target = await resolveTarget(this.session, this.refs, this.refs.assign(node), this.observer.probes);
        await this.highlighter.element(target, h.color);
      }
    } catch {
      // Restoring is best effort: the page may already be changing again.
    }
  }

  handleDialog(args: {accept: boolean; text?: string}): Promise<ToolResult> {
    return this.run(async () => {
      if (!this.dialog) throw new PageError('NOT_FOUND', 'Сейчас на странице нет диалога.');
      const was = this.dialog;
      // Answering a page's prompt() is the user's own step: they may be asked for anything there.
      if (was.type === 'prompt' && this.gate) {
        const url = this.session.frames.main().url;
        const answer = await this.gate.check({action: 'handle_dialog', ref: '', role: 'dialog', name: was.message, category: 'secret', site: siteOf(url), url});
        if (answer.decision === 'user-did-it') { this.dialog = undefined; return `диалог «${was.message}»: пользователь ответил сам`; }
        throw new PageError('USER_DECLINED', 'Ответ на диалог страницы — шаг пользователя; он не ответил.');
      }
      await this.session.cdp.send('Page.handleJavaScriptDialog', {accept: args.accept, promptText: args.text});
      this.dialog = undefined;
      await new Promise(r => setTimeout(r, 300));
      return `диалог ${was.type} «${was.message}»: ${args.accept ? 'принят' : 'отклонён'}`;
    }, true);
  }

  /** For the e2e harness: runs the checks before an action on a label, without acting. */
  async debugActionable(ref: string): Promise<{ok: true; point: {x: number; y: number}; ms: number} | {ok: false; code: string; message: string; ms: number}> {
    const started = Date.now();
    try {
      const target = await resolveTarget(this.session, this.refs, ref, this.observer.probes);
      const {point} = await waitActionable(this.session, target, {pointer: true}, this.observer.probes);
      return {ok: true, point, ms: Date.now() - started};
    } catch (error) {
      return {ok: false, code: error instanceof PageError ? error.code : 'INTERNAL', message: error instanceof Error ? error.message : String(error), ms: Date.now() - started};
    }
  }

  dispose(): void {
    this.observer.network.stop();
  }
}
