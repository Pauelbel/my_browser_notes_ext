// The layer's tools on one tab, for the agent and for the e2e harness. Each returns text for the model; page text
// sits between page-content markers, and a layer error becomes a result the model can act on, never an exception.
import {Observer} from './observe.ts';
import {RefRegistry} from './refs.ts';
import type {PageSession} from './session.ts';
import {PageError} from './errors.ts';
import type {OutlineMode, WindowMode} from './render.ts';
import {callOn, resolveTarget, type Target} from './resolve.ts';
import {waitActionable, type Actionable} from './actionability.ts';
import {startWatch, type Evidence} from './evidence.ts';
import {click, hover, pressKey, wheel, watchDialog, KEYS, type DialogInfo, type KeyName} from './input.ts';
import {focusTarget, isChecked, isFocused, isSelect, selectOption, targetFacts, typeInto} from './act.ts';
import {diffLines, renderDiff} from './diff.ts';
import {render, renderLine} from './render.ts';
import {waitForReady} from './readiness.ts';
import {probeEval} from './probe.ts';
import {Diagnostics, summarizeConsole, summarizeNetwork} from './diagnostics.ts';
import {DANGEROUS_URL, findOverlaps, findUnnamed, shortUrl} from './checks.ts';
import type {Box} from './layout.ts';
import type {ONode} from './outline.ts';
import {classify, USER_STEP, type Category} from './classify.ts';
import {isSecretField} from './masking.ts';
import {siteOf} from './site.ts';
import {checkColor, Highlighter, type HighlightColor} from './highlight.ts';
import {locatorFunction, verifyCdpLocator, type ConcreteLocatorKind, type LocatorCandidate, type LocatorInfo} from './locator.ts';
import {locatorKindLabel, wrapLocatorAnswer, type LocatorKind} from '../agent/locator-intent.ts';
import {renderReceipt, type ActionReceipt, type EffectVerdict, type Expectation, type PageChange, type SemanticTarget} from './receipt.ts';

export interface ToolResult {
  text: string;
  ok: boolean;
  /** Present for actions; callers should use this instead of parsing the human explanation. */
  receipt?: ActionReceipt;
  error?: {code: string; retryable: boolean; dispatched: boolean | 'unknown'};
  /** A screenshot (base64 JPEG), for models that see images. */
  image?: string;
}

interface PageBlock {head: string; body: string; notices: string[]}
interface ActionOutput {
  body: string;
  receipt: ActionReceipt;
  error?: {code: 'POSTCONDITION_UNMET'; message: string};
}

export interface GateQuestion { action: string; ref: string; role: string; name: string; category: Category; site: string; url: string }
export type GateAnswer = {decision: 'allow'} | {decision: 'deny'} | {decision: 'user-did-it'} | {decision: 'cancel'};
/** What the agent above the layer decides about a dangerous action; the layer only asks and obeys. */
export interface Gate { check(q: GateQuestion): Promise<GateAnswer>; blocked(site: string): boolean | Promise<boolean> }

const CATEGORY_TEXT: Record<Category, string> = {
  pay: 'оплата', access: 'выдача доступа', secret: 'ввод секрета', captcha: 'капча', delete: 'удаление', logout: 'выход из аккаунта', send: 'отправка', submit: 'отправка формы',
};
const ORDER: Category[] = ['pay', 'access', 'secret', 'captcha', 'delete', 'logout', 'send', 'submit'];

export const PAGE_START = '<<<page-content>>>';
const NAVIGATION_TIMEOUT_MS = 15000;
const LINKS_MAX = 40;
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
    return {ok: false, text: `ошибка ${error.code}: ${neutralize(error.message)}${delivered}`,
      error: {code: error.code, retryable: !['USER_DECLINED', 'SITE_BLOCKED', 'PAGE_NOT_SUPPORTED', 'SESSION_DISPOSED'].includes(error.code), dispatched: error.delivered}};
  }
  return {ok: false, text: `ошибка INTERNAL: ${neutralize(error instanceof Error ? error.message : String(error))}`};
}

export class PageTools {
  readonly session: PageSession;
  readonly refs: RefRegistry;
  readonly observer: Observer;
  budget: number;
  readonly highlighter: Highlighter;
  readonly diagnostics: Diagnostics;
  /** Highlights made in this session, by page address, so going back to a page shows them again. */
  readonly #highlights: {url: string; text?: string; element?: {role: string; name: string}; color: HighlightColor}[] = [];
  /** A page dialog that is open now; while it is, the page answers nothing but handleDialog. */
  dialog: DialogInfo | undefined;
  #revision = 0;
  #disposed = false;
  readonly #offs: (() => void)[] = [];

  gate: Gate | undefined;

  constructor(session: PageSession, options: {budget: number; gate?: Gate; ownerId?: string}) {
    this.session = session;
    this.budget = options.budget;
    this.gate = options.gate;
    this.refs = new RefRegistry(session.epoch);
    this.observer = new Observer(session, this.refs);
    this.highlighter = new Highlighter(session, this.observer.probes, options.ownerId);
    this.diagnostics = session.diagnostics;
    this.#offs.push(session.cdp.on((method, _params, sessionId) => { if (method === 'Page.loadEventFired' && !sessionId) setTimeout(() => void this.#restoreHighlights(), 300); }));
    this.#offs.push(session.cdp.on(method => { if (method === 'Page.javascriptDialogClosed') this.dialog = undefined; }));
    this.#offs.push(session.cdp.on((method, params) => { if (method === 'Page.javascriptDialogOpening') this.dialog = {type: params.type, message: params.message}; }));
    this.#offs.push(session.cdp.on((method, _params, sessionId) => {
      if (!sessionId && (method === 'Page.frameNavigated' || method === 'Page.navigatedWithinDocument' || method === 'DOM.documentUpdated')) this.#revision++;
    }));
    // A frame that loads a new document makes its labels stale.
    this.#offs.push(session.frames.onChange(() => { for (const f of session.frames.list()) this.refs.invalidateFrame(f.frameId, f.loaderId); }));
  }

  get revision(): number { return this.#revision; }

  /** Runs a tool. A plain string result is page-derived text (a receipt names page elements) and goes inside the markers. */
  protected async run(fn: () => Promise<string | PageBlock | ActionOutput>, allowDuringDialog = false, allowOnBlocked = false): Promise<ToolResult> {
    try {
      if (this.#disposed) throw new PageError('SESSION_DISPOSED', 'Сессия страницы уже закрыта: откройте страницу заново.');
      // Wherever the tab ended up (a redirect, back, a script), a blocked site is not worked on; only leaving it is.
      if (this.gate && !allowOnBlocked) {
        const site = siteOf(this.session.frames.main().url);
        if (site && await this.gate.blocked(site)) throw new PageError('SITE_BLOCKED', `Вкладка открыта на сайте ${site}, который пользователь заблокировал: здесь помощник ничего не делает. Уйдите со страницы (navigate) или закончите задачу.`);
      }
      if (this.dialog && !allowDuringDialog) {
        throw new PageError('DIALOG_OPEN', `На странице открыт диалог ${this.dialog.type}: «${this.dialog.message}». Ответьте на него (handle_dialog), если этот инструмент есть, иначе попросите пользователя закрыть диалог.`);
      }
      const out = await fn();
      if (typeof out === 'string') return {ok: true, text: pageText('', out, [])};
      if ('receipt' in out) {
        const receipt = renderReceipt(out.receipt);
        if (out.error) return {ok: false, text: `ошибка ${out.error.code}: ${neutralize(out.error.message)}\n${receipt}`, receipt: out.receipt,
          error: {code: out.error.code, retryable: true, dispatched: out.receipt.dispatched}};
        return {ok: true, text: `${pageText('', out.body, [])}\n${receipt}`, receipt: out.receipt};
      }
      return {ok: true, text: pageText(out.head, out.body, out.notices)};
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

  /** A fresh, independently verified locator for the current page revision. */
  locator(args: {ref: string; kind?: LocatorKind}): Promise<ToolResult> {
    return this.run(async () => ({head: `Локатор элемента · ${this.session.frames.main().url}`,
      body: await this.#locatorBlock(args.ref, args.kind ?? 'best'), notices: []}));
  }

  async #locatorBlock(ref: string, requested: LocatorKind): Promise<string> {
    const target = await resolveTarget(this.session, this.refs, ref, this.observer.probes);
    const info = await callOn<LocatorInfo>(this.session, target.frame, target.objectId, locatorFunction);
    const send = <T>(method: string, params?: object, sessionId?: string) => this.session.cdp.send<T>(method, params, sessionId);
    const verified: LocatorCandidate[] = [];
    for (const candidate of info.candidates) {
      // XPath has no representation that crosses a Shadow DOM boundary.
      if (candidate.kind === 'xpath' && info.scope === 'shadow-root') continue;
      if (await verifyCdpLocator(send, candidate.query, target.record.backendNodeId, target.frame.sessionId)) verified.push(candidate);
    }
    const rank: ConcreteLocatorKind[] = ['testid', 'id', 'css', 'xpath', 'aria', 'role', 'name', 'class', 'tag'];
    const score = (candidate: LocatorCandidate) => ({high: 0, medium: 10, low: 20})[candidate.stability]
      + rank.indexOf(candidate.kind);
    verified.sort((a, b) => score(a) - score(b));
    const exact = requested === 'best' ? verified[0] : verified.find(candidate => candidate.kind === requested);
    const chosen = exact ?? verified.find(candidate => candidate.kind !== requested);
    const scope = info.scope === 'shadow-root'
      ? 'Область: Shadow DOM; применять внутри соответствующего shadowRoot.'
      : target.frame.parentFrameId ? 'Область: document соответствующего iframe.' : 'Область: основной document.';
    const stability = {high: 'высокая', medium: 'средняя', low: 'низкая'} as const;
    let answer: string;
    if (!chosen) {
      const label = requested === 'best' ? 'локатор' : locatorKindLabel(requested);
      answer = `Не удалось построить проверенный уникальный ${label} для этого элемента. Подтверждённых альтернатив тоже нет.`;
    } else {
      const label = locatorKindLabel(chosen.kind);
      const prefix = exact ? '' : `Не удалось построить проверенный уникальный ${locatorKindLabel(requested as Exclude<LocatorKind, 'best'>)} для этого элемента.\n\nБлижайший проверенный вариант — ${label}:\n`;
      const language = chosen.kind === 'xpath' ? 'xpath'
        : ['css', 'testid', 'aria', 'name', 'class', 'role'].includes(chosen.kind) ? 'css' : 'text';
      answer = `${prefix}${exact ? `${label}:\n` : ''}\`\`\`${language}\n${chosen.value}\n\`\`\``
        + `\n\nПроверено: ровно 1 совпадение и тот же DOM-элемент. Стабильность: ${stability[chosen.stability]}. ${scope} page.rev=${this.#revision}.`;
    }
    return wrapLocatorAnswer(answer);
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
    actions: ('activate' | 'enter' | 'type')[] = [], expect?: Expectation, forcedConsequential = false): Promise<ActionOutput | string> {
    let target = await resolveTarget(this.session, this.refs, ref, this.observer.probes);
    let actionable = await waitActionable(this.session, target, needs, this.observer.probes);
    const verdict = await this.#gate(verb, ref, target, actions);
    if (verdict === 'user-did-it') return `${verb} [${ref}] ${target.record.role} "${target.record.name}": шаг выполнен пользователем сам, событие помощником не отправлено`;
    if (verdict === 'asked') {
      // The page may have changed while the user decided: the target is checked again from scratch.
      target = await resolveTarget(this.session, this.refs, ref, this.observer.probes);
      actionable = await waitActionable(this.session, target, needs, this.observer.probes);
    }
    // Actionability may scroll and wait for several seconds. A reactive application can replace or rename the node
    // during that time, so identity and geometry are checked once more immediately before any input is dispatched.
    target = await resolveTarget(this.session, this.refs, ref, this.observer.probes);
    actionable = await waitActionable(this.session, target, needs, this.observer.probes);
    // The baseline comes after the checks, which may have scrolled the target into view: scrolling is not a reaction.
    const before = await this.#describe();
    return this.#dispatchAndReport(`${verb} [${ref}] ${target.record.role} "${target.record.name}"`, before, [target.frame.frameId],
      dialog => dispatch(target, actionable, dialog), target.record.proxy === 'label' ? ` (клик по связанной подписи "${target.record.name}")` : '',
      verb, ref, expect, forcedConsequential || verdict === 'asked');
  }

  /** Classifies the action and asks the gate. 'go' when nothing needed asking. */
  async #gate(verb: string, ref: string, target: Target, actions: ('activate' | 'enter' | 'type')[]): Promise<'go' | 'asked' | 'user-did-it'> {
    if (!actions.length) return 'go';
    const facts = await targetFacts(this.session, target);
    if (facts.href && await this.gate?.blocked(siteOf(facts.href))) throw new PageError('SITE_BLOCKED', `Сайт ${siteOf(facts.href)} заблокирован пользователем: ссылку не открываю.`);
    if (!this.gate) return 'go';
    const found = actions.map(action => classify({action, role: target.record.role, name: target.record.name, tag: facts.tag, type: facts.type,
      inForm: facts.inForm, formHasPassword: facts.formHasPassword, secretField: isSecretField(facts.attrs), nearbyText: facts.nearby, contentEditable: facts.contentEditable}))
      .filter((c): c is Category => c !== null);
    if (!found.length) return 'go';
    const category = ORDER.find(c => found.includes(c))!;
    const url = this.session.frames.main().url;
    const answer = await this.gate.check({action: verb, ref, role: target.record.role, name: target.record.name, category, site: siteOf(url), url});
    if (answer.decision === 'allow') return 'asked';
    if (answer.decision === 'user-did-it') return 'user-did-it';
    throw new PageError('USER_DECLINED', `Пользователь не разрешил: ${verb} «${target.record.name}» (${CATEGORY_TEXT[category]}). Событие не отправлено; не пытайтесь сделать это другим способом.`);
  }

  /** Gates an action whose side effects cannot be inferred from an element label. */
  async #gateCategory(verb: string, category: Category): Promise<'go' | 'asked' | 'user-did-it'> {
    if (!this.gate) return 'go';
    const url = this.session.frames.main().url;
    const answer = await this.gate.check({action: verb, ref: '', role: '', name: verb, category, site: siteOf(url), url});
    if (answer.decision === 'allow') return 'asked';
    if (answer.decision === 'user-did-it') return 'user-did-it';
    throw new PageError('USER_DECLINED', `Пользователь не разрешил: ${verb} (${CATEGORY_TEXT[category]}). Действие не выполнено.`);
  }

  async #dispatchAndReport(what: string, before: string[], frameIds: string[],
    dispatch: (dialog: Promise<DialogInfo>) => Promise<{dialog?: DialogInfo; note?: string} | void>, suffix = '',
    action = what.split(' ', 1)[0], targetRef?: string, expect?: Expectation, consequential = false): Promise<ActionOutput> {
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
    let effect: {text: string; verdict: EffectVerdict; signals: string[]; changed: PageChange};
    try {
      effect = await this.#effectText(evidence, before);
    } catch (error) {
      // A dialog that opened after the reaction window is still this action's reaction.
      if (!(error instanceof PageError && error.code === 'DIALOG_OPEN') || !this.dialog) throw error;
      effect = {text: `открыт диалог ${this.dialog.type}: «${this.dialog.message}». Ответьте через handle_dialog.`,
        verdict: 'changed', signals: ['dialog'], changed: 'diff'};
    }
    if (effect.verdict !== 'none') this.#revision++;
    const postcondition = await this.#checkExpectation(expect, targetRef);
    const receipt: ActionReceipt = {action, target: targetRef, dispatched: true, consequential,
      effect: {verdict: effect.verdict, signals: effect.signals}, postcondition,
      page: {revision: this.#revision, url: this.session.frames.main().url, changed: effect.changed}};
    const body = `${what}${suffix}: событие отправлено${note ? ` · ${note}` : ''} · реакция: ${effect.text}`;
    return postcondition.verdict === 'unmet'
      ? {body, receipt, error: {code: 'POSTCONDITION_UNMET', message: `Действие отправлено, но ожидаемый результат не достигнут: ${postcondition.details ?? 'условие не выполнено'}. Сначала сделайте новый snapshot; не повторяйте действие вслепую.`}}
      : {body, receipt};
  }

  async #effectText(e: Evidence, before: string[]): Promise<{text: string; verdict: EffectVerdict; signals: string[]; changed: PageChange}> {
    const counts = `мутаций ${e.mutations}, запросов ${e.requests}`;
    if (e.effect === 'dialog') {
      this.dialog = e.dialog;
      return {text: `открыт диалог ${e.dialog!.type}: «${e.dialog!.message}». Ответьте через handle_dialog.`, verdict: 'changed', signals: ['dialog'], changed: 'diff'};
    }
    if (e.effect === 'new_tab') return {text: `открыта новая вкладка ${e.url ?? ''}`.trim(), verdict: 'changed', signals: ['new_tab'], changed: 'full'};
    if (e.effect === 'navigated') {
      const o = await this.observer.snapshot({budget: this.budget});
      return {text: `переход на ${e.url ?? o.capture.url}\nновая страница: ${o.header}\nСделайте snapshot, чтобы увидеть её элементы.`,
        verdict: 'changed', signals: ['navigation'], changed: 'full'};
    }
    const diff = renderDiff(diffLines(before, await this.#describe()));
    let head = e.effect === 'changed' ? `страница изменилась (${counts})` : e.effect === 'requests' ? `ушли запросы (${e.requests}), описание около экрана не изменилось` : 'видимой реакции нет';
    if (e.sameDocument) head = `адрес изменился на ${e.sameDocument} (без перезагрузки) · ${head}`;
    if (e.notCommitted) head = `переход на ${e.notCommitted} запрошен, но не произошёл (загрузка файла, пустой ответ или отмена) · ${head}`;
    const signals = [e.sameDocument ? 'same_document_navigation' : '', diff ? 'visible_diff' : '', e.mutations ? 'mutations' : '', e.requests ? 'network' : '', e.notCommitted ? 'navigation_not_committed' : ''].filter(Boolean);
    const verdict: EffectVerdict = e.sameDocument || diff ? 'changed' : e.effect === 'none' ? 'none' : 'unattributable';
    return {text: diff ? `${head}\nизменения:\n${diff}` : head, verdict, signals, changed: diff || e.sameDocument ? 'diff' : 'none'};
  }

  async #checkExpectation(expect: Expectation | undefined, actionRef?: string): Promise<ActionReceipt['postcondition']> {
    if (!expect || Object.values(expect).every(v => v === undefined)) return {verdict: 'not_checked'};
    const failed: string[] = [];
    const url = this.session.frames.main().url;
    if (expect.url !== undefined && !url.includes(expect.url)) failed.push(`URL не содержит «${expect.url}»`);
    if (expect.text !== undefined || expect.textGone !== undefined) {
      const {roots} = await this.observer.quick();
      const page = fold(flat(roots).map(n => `${n.name} ${n.value ?? ''}`).join(' '));
      if (expect.text !== undefined && !page.includes(fold(expect.text))) failed.push(`текст «${expect.text}» не появился`);
      if (expect.textGone !== undefined && page.includes(fold(expect.textGone))) failed.push(`текст «${expect.textGone}» не исчез`);
    }
    const ref = expect.ref ?? actionRef;
    if (expect.gone !== undefined || expect.value !== undefined || expect.checked !== undefined) {
      if (!ref) failed.push('для проверки элемента не указан ref');
      else {
        let target: Target | null = null;
        try { target = await resolveTarget(this.session, this.refs, ref, this.observer.probes); } catch (error) {
          if (!(expect.gone === true && error instanceof PageError && error.code === 'REF_STALE')) failed.push(`элемент ${ref} недоступен`);
        }
        if (expect.gone === true && target) failed.push(`элемент ${ref} не исчез`);
        if (expect.gone === false && !target) failed.push(`элемент ${ref} отсутствует`);
        if (target && expect.value !== undefined) {
          const value = await callOn<string>(this.session, target.frame, target.objectId,
            'function () { const c = this.control || this; return typeof c.value === "string" ? c.value : (c.innerText || ""); }');
          if (value.replace(/\s+/g, ' ').trim() !== expect.value.replace(/\s+/g, ' ').trim()) failed.push(`значение элемента ${ref} не совпало`);
        }
        if (target && expect.checked !== undefined && await isChecked(this.session, target) !== expect.checked) failed.push(`состояние checked элемента ${ref} не совпало`);
      }
    }
    return failed.length ? {verdict: 'unmet', details: failed.join('; ')} : {verdict: 'met'};
  }

  async #refOf(args: {ref?: string; target?: SemanticTarget}): Promise<string> {
    if (args.ref && args.target) throw new PageError('AMBIGUOUS_TARGET', 'Укажите либо ref, либо semantic target, но не оба сразу.');
    if (args.ref) return args.ref;
    if (args.target) return this.observer.semanticRef(args.target);
    throw new PageError('NOT_FOUND', 'Укажите ref из snapshot или точную semantic target: role и name.');
  }

  click(args: {ref?: string; target?: SemanticTarget; expect?: Expectation}): Promise<ToolResult> {
    return this.run(async () => {
      const ref = await this.#refOf(args);
      return this.#act('click', ref, {pointer: true}, (_t, a, dialog) => click(this.session, a.point, dialog), ['activate'], args.expect);
    });
  }

  hover(args: {ref?: string; target?: SemanticTarget; expect?: Expectation}): Promise<ToolResult> {
    return this.run(async () => {
      const ref = await this.#refOf(args);
      return this.#act('hover', ref, {pointer: true}, async (_t, a) => { await hover(this.session, a.point); }, [], args.expect);
    });
  }

  type(args: {ref?: string; target?: SemanticTarget; text: string; clear?: boolean; submit?: boolean; expect?: Expectation}): Promise<ToolResult> {
    return this.run(async () => {
      const ref = await this.#refOf(args);
      return this.#act('type', ref, {pointer: false, editable: true}, async (t, a, dialog) => {
      await focusTarget(this.session, t, a.point, dialog);
      await typeInto(this.session, t, args.text, Boolean(args.clear), dialog);
      if (args.submit) { const r = await pressKey(this.session, 'Enter', dialog); if (r.dialog) return r; }
      return {note: `введено символов: ${args.text.length}${args.submit ? ', нажат Enter' : ''}`};
      }, args.submit ? ['type', 'enter'] : ['type'], args.expect);
    });
  }

  set(args: {ref?: string; target?: SemanticTarget; value: string | boolean; expect?: Expectation}): Promise<ToolResult> {
    return this.run(async () => {
      const ref = await this.#refOf(args);
      const probe = await resolveTarget(this.session, this.refs, ref, this.observer.probes);
      if (await isSelect(this.session, probe)) {
        // A change handler may submit immediately, which cannot be inferred from the option's label.
        const verdict = await this.#gateCategory('изменить значение списка', 'submit');
        if (verdict === 'user-did-it') return `set [${args.ref}]: шаг выполнен пользователем сам`;
        return this.#act('set', ref, {pointer: false}, async t => ({note: `выбрано «${await selectOption(this.session, t, String(args.value))}»`}), [], args.expect, verdict === 'asked');
      }
      const want = args.value === true || args.value === 'true' || args.value === 'on';
      return this.#act('set', ref, {pointer: true}, async (t, a, dialog) => {
        if (await isChecked(this.session, t) === want) return {note: `уже ${want ? 'включено' : 'выключено'}`};
        const r = await click(this.session, a.point, dialog);
        if (r.dialog) return r;
        if (await isChecked(this.session, t) !== want) throw new PageError('VALUE_MISMATCH', `Состояние элемента ${ref} не изменилось после клика.`, true);
        return {note: want ? 'включено' : 'выключено'};
      }, ['activate'], args.expect);
    });
  }

  press(args: {key: KeyName; ref?: string; target?: SemanticTarget; expect?: Expectation}): Promise<ToolResult> {
    return this.run(async () => {
      if (!(args.key in KEYS)) throw new PageError('NOT_FOUND', `Клавиша ${args.key} не поддерживается. Есть: ${Object.keys(KEYS).join(', ')}.`);
      const chosenRef = args.ref || args.target ? await this.#refOf(args) : undefined;
      let consequential = false;
      if (!chosenRef && (args.key === 'Enter' || args.key === 'Space')) {
        throw new PageError('NOT_FOUND', `Для ${args.key} укажите ref элемента: так помощник знает, что именно нажимается.`);
      }
      if (chosenRef) {
        // The gate comes first; then the target is checked and focused right before the key, since the key goes to
        // whatever has focus and the page may have moved on while the user decided.
        let target = await resolveTarget(this.session, this.refs, chosenRef, this.observer.probes);
        if (args.key === 'Enter' || args.key === 'Space') {
          const control = ['button', 'link', 'checkbox', 'radio', 'switch', 'menuitem', 'tab', 'clickable'].includes(target.record.role);
          const verdict = await this.#gate(`press ${args.key}`, chosenRef, target, [control ? 'activate' : 'enter']);
          consequential = verdict === 'asked';
          if (verdict === 'user-did-it') return `press ${args.key} [${chosenRef}]: шаг выполнен пользователем сам, событие помощником не отправлено`;
          if (verdict === 'asked') target = await resolveTarget(this.session, this.refs, chosenRef, this.observer.probes);
        }
        await waitActionable(this.session, target, {pointer: false}, this.observer.probes);
        await this.session.cdp.send('DOM.focus', {backendNodeId: target.record.backendNodeId}, target.frame.sessionId).catch(() => {});
        if (!await isFocused(this.session, target)) {
          throw new PageError('NOT_EDITABLE', `Элемент ${args.ref} не принимает фокус клавиатуры: клавиша не отправлена. Для него используйте click.`);
        }
        const before = await this.#describe();
        return this.#dispatchAndReport(`press ${args.key} [${chosenRef}] ${target.record.role} "${target.record.name}"`, before, [target.frame.frameId],
          dialog => pressKey(this.session, args.key, dialog), '', `press ${args.key}`, chosenRef, args.expect, consequential);
      }
      return this.#dispatchAndReport(`press ${args.key}`, await this.#describe(), [], dialog => pressKey(this.session, args.key, dialog), '', `press ${args.key}`, undefined, args.expect);
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

  navigate(args: {url?: string; action?: 'back' | 'forward' | 'reload'; expect?: Expectation}): Promise<ToolResult> {
    return this.run(async () => {
      const {cdp} = this.session;
      let what: string;
      let status: number | undefined;
      let consequential = false;
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
          // Reloading a POST result can repeat the transaction, including when a QA tool requested the reload.
          const verdict = await this.#gateCategory('обновить страницу', 'submit');
          if (verdict === 'user-did-it') return 'обновление: шаг выполнен пользователем сам';
          consequential = verdict === 'asked';
          what = 'обновление';
          await cdp.send('Page.reload', {});
          await Promise.race([arrived, new Promise(r => setTimeout(r, NAVIGATION_TIMEOUT_MS))]);
        } else {
          const url = normalizeUrl(args.url ?? '');
          if (await this.gate?.blocked(siteOf(url))) throw new PageError('SITE_BLOCKED', `Сайт ${siteOf(url)} заблокирован пользователем.`);
          what = `переход на ${url}`;
          const r = await cdp.send<{errorText?: string}>('Page.navigate', {url});
          if (r.errorText) throw new PageError('NOT_FOUND', `Не удалось открыть ${url}: ${r.errorText}.`);
          await Promise.race([arrived, new Promise(r => setTimeout(r, NAVIGATION_TIMEOUT_MS))]);
        }
      } finally {
        off();
      }
      const o = await this.observer.snapshot({budget: this.budget});
      this.#revision++;
      const postcondition = await this.#checkExpectation(args.expect);
      const receipt: ActionReceipt = {action: 'navigate', dispatched: true, consequential,
        effect: {verdict: 'changed', signals: ['navigation']}, postcondition,
        page: {revision: this.#revision, url: this.session.frames.main().url, changed: 'full'}};
      const body = `${what}: ${status ? `HTTP ${status} · ` : ''}${o.header}\nСделайте snapshot, чтобы увидеть элементы страницы.`;
      return postcondition.verdict === 'unmet'
        ? {body, receipt, error: {code: 'POSTCONDITION_UNMET', message: `Переход выполнен, но ожидаемый результат не достигнут: ${postcondition.details}.`}}
        : {body, receipt};
    }, false, true);
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

  /** Optionally reloads the page so collection covers it from the start of loading. */
  async #fresh(reload?: boolean): Promise<void> {
    if (!reload) return;
    this.diagnostics.reset();
    const r = await this.navigate({action: 'reload'});
    if (!r.ok) throw new PageError('INTERNAL', `Не удалось перезагрузить страницу: ${r.text}`);
  }

  consoleLog(args: {level?: 'error' | 'warning' | 'all'; reload?: boolean} = {}): Promise<ToolResult> {
    return this.run(async () => {
      await this.#fresh(args.reload);
      return {head: `Консоль · ${this.session.frames.main().url}`, body: summarizeConsole({...this.diagnostics.console(), since: this.diagnostics.collectedSince}, args.level ?? 'all'), notices: []};
    });
  }

  networkLog(args: {reload?: boolean} = {}): Promise<ToolResult> {
    return this.run(async () => {
      await this.#fresh(args.reload);
      return {head: `Сеть · ${this.session.frames.main().url}`, body: summarizeNetwork({...this.diagnostics.network(), since: this.diagnostics.collectedSince}), notices: []};
    });
  }

  /** The visible part of the page as JPEG, at most 1280 px wide. */
  async screenshot(): Promise<ToolResult> {
    let image = '';
    const result = await this.run(async () => {
      const m = await this.session.cdp.send<{cssLayoutViewport: {pageX: number; pageY: number; clientWidth: number; clientHeight: number}}>('Page.getLayoutMetrics');
      const v = m.cssLayoutViewport;
      // The image comes out at clip × scale × devicePixelRatio: the scale accounts for HiDPI screens.
      const dpr = await probeEval<number>(this.session, this.session.frames.main().frameId, this.observer.probes, 'devicePixelRatio').catch(() => 1) || 1;
      const scale = Math.min(1, 1280 / Math.max(1, v.clientWidth * dpr));
      const {data} = await this.session.cdp.send<{data: string}>('Page.captureScreenshot',
        {format: 'jpeg', quality: 70, clip: {x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight, scale}}, undefined, 20000);
      image = data;
      return `скриншот сделан: ${Math.round(v.clientWidth * scale * dpr)}×${Math.round(v.clientHeight * scale * dpr)}, приложен к следующему сообщению`;
    });
    return image ? {...result, image} : result;
  }

  /** Checks of the visible page for common bugs; each section says what it found, or that it found nothing. */
  pageChecks(): Promise<ToolResult> {
    return this.run(async () => {
      const main = this.session.frames.main().frameId;
      const probe = <T>(expr: string, timeout?: number) => probeEval<T>(this.session, main, this.observer.probes, expr, timeout);
      const section = async <T>(title: string, fn: () => Promise<T>, show: (v: T) => string): Promise<string> => {
        try { return show(await fn()); } catch (error) { return `${title}: не удалось проверить (${error instanceof Error ? error.message : String(error)})`; }
      };
      const {roots} = await this.observer.observe();
      const linksSection = section('Ссылки этого сайта', async () => {
        // Links that say they change something are never requested: a HEAD to /logout logs many sites out.
        const candidates = await probe<{url: string; text: string; nearby: string}[]>(`__assistant.sameSiteLinks(${LINKS_MAX * 3})`);
        const dangerous = candidates.filter(c => DANGEROUS_URL.test(c.url) || ['logout', 'delete', 'access', 'pay', 'send', 'captcha'].includes(classify({
          action: 'activate', role: 'link', name: c.text, tag: 'a', type: '', inForm: false, formHasPassword: false, secretField: false, nearbyText: ''}) ?? ''));
        const safe = candidates.filter(c => !dangerous.includes(c)).slice(0, LINKS_MAX);
        this.diagnostics.mute(safe.map(c => c.url));
        try {
          const r = safe.length ? await probe<{bad: {url: string; status?: number; error?: string}[]; skipped: {url: string; why: string}[]}>(
            `__assistant.checkLinks(${JSON.stringify(safe.map(c => c.url))}, 6, 5000, 20000)`, 30000) : {bad: [], skipped: []};
          return {r, safe: safe.length, dangerous};
        } finally {
          this.diagnostics.unmute();
        }
      }, ({r, safe, dangerous}) => [
        r.bad.length ? `Ссылки этого сайта с ошибкой: ${r.bad.length} из ${safe} проверенных\n${r.bad.map(b => `- ${b.status ?? b.error} · ${shortUrl(b.url)}`).join('\n')}`
          : `Ссылки этого сайта: проверено ${safe}${safe >= LINKS_MAX ? ' (первые)' : ''}, ошибок нет`,
        r.skipped.length ? `Не проверены: ${r.skipped.length} (${[...new Set(r.skipped.map(s => s.why))].join(', ')})` : '',
        dangerous.length ? `Не проверялись (опасные — выход, удаление, отписка и т. п.): ${dangerous.slice(0, 10).map(d => `«${d.text || shortUrl(d.url)}»`).join(', ')}${dangerous.length > 10 ? ` и ещё ${dangerous.length - 10}` : ''}` : '',
      ].filter(Boolean).join('\n'));
      const parts = await Promise.all([
        section('Битые картинки', () => probe<{src: string; alt: string}[]>('__assistant.brokenImages()'),
          broken => (broken.length ? `Битые картинки: ${broken.length}\n${broken.map(b => `- ${shortUrl(b.src)}${b.alt ? ` (alt «${b.alt}»)` : ''}`).join('\n')}` : 'Битые картинки: нет')),
        linksSection,
        section('Элементы без подписи', async () => findUnnamed(roots), unnamed => (unnamed.length
          ? `Элементы без подписи (не прочитает экранный диктор и не поймёт модель): ${unnamed.length}\n${unnamed.slice(0, 20).map(n => { if (n.backendNodeId !== undefined) this.refs.assign(n); return `- ${renderLine(n)}`; }).join('\n')}`
          : 'Элементы без подписи: нет')),
        section('Картинки без alt', () => probe<string[]>('__assistant.imagesWithoutAlt()'),
          noAlt => (noAlt.length ? `Картинки без alt: ${noAlt.length}\n${noAlt.map(s => `- ${shortUrl(s)}`).join('\n')}` : 'Картинки без alt: нет')),
        section('Переполнение по ширине', () => probe<{pageOverflow: number; width: number; elements: {text: string; right: number}[]}>('__assistant.overflow()'),
          o => (o.pageOverflow > 1 ? `Переполнение по ширине: страница шире окна (${o.width} px) на ${o.pageOverflow} px\n${o.elements.map(e => `- «${e.text}» до ${e.right} px`).join('\n')}` : 'Переполнение по ширине: нет')),
        section('Перекрывающиеся элементы', () => probe<{label: string; box: Box; ancestors: string[]}[]>('__assistant.controls()'), controls => {
          const overlaps = findOverlaps(controls.map((c, i) => ({ref: String(i), label: c.label, box: c.box, ancestors: c.ancestors})));
          return overlaps.length ? `Перекрывающиеся элементы: ${overlaps.length}\n${overlaps.map(([a, b]) => `- «${controls[Number(a)].label}» и «${controls[Number(b)].label}»`).join('\n')}` : 'Перекрывающиеся элементы: нет';
        }),
      ]);
      let body = parts.join('\n\n');
      const notices: string[] = [];
      if (body.length > this.budget) { body = body.slice(0, this.budget); notices.push('Отчёт урезан до бюджета описания.'); }
      return {head: `Проверки страницы · ${this.session.frames.main().url}`, body, notices};
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

  handleDialog(args: {accept: boolean; text?: string; expect?: Expectation}): Promise<ToolResult> {
    return this.run(async () => {
      if (!this.dialog) throw new PageError('NOT_FOUND', 'Сейчас на странице нет диалога.');
      const was = this.dialog;
      let consequential = false;
      // Answering a page's prompt() is the user's own step: they may be asked for anything there.
      if (was.type === 'prompt' && this.gate) {
        const url = this.session.frames.main().url;
        const answer = await this.gate.check({action: 'handle_dialog', ref: '', role: 'dialog', name: was.message, category: 'secret', site: siteOf(url), url});
        if (answer.decision === 'user-did-it') { this.dialog = undefined; return `диалог «${was.message}»: пользователь ответил сам`; }
        // Left open, the dialog would block every tool: it is dismissed.
        await this.session.cdp.send('Page.handleJavaScriptDialog', {accept: false}).catch(() => {});
        this.dialog = undefined;
        throw new PageError('USER_DECLINED', 'Ответ на диалог страницы — шаг пользователя; он не ответил, диалог закрыт отменой.');
      }
      // Accepting a confirm() completes what the page asks («Удалить запись?»): its message is classified like a button.
      if (was.type === 'confirm' && args.accept && this.gate) {
        const category = classify({action: 'activate', role: 'button', name: was.message, tag: 'button', type: '', inForm: false, formHasPassword: false, secretField: false, nearbyText: ''});
        if (category) {
          const url = this.session.frames.main().url;
          const answer = await this.gate.check({action: 'handle_dialog', ref: '', role: 'dialog', name: was.message, category, site: siteOf(url), url});
          if (answer.decision === 'user-did-it') return `диалог «${was.message}»: пользователь ответил сам`;
          if (answer.decision !== 'allow') throw new PageError('USER_DECLINED', `Пользователь не разрешил подтвердить «${was.message}». Ответьте на диалог отменой (accept=false).`);
          consequential = true;
        }
      }
      await this.session.cdp.send('Page.handleJavaScriptDialog', {accept: args.accept, promptText: args.text});
      this.dialog = undefined;
      await new Promise(r => setTimeout(r, 300));
      this.#revision++;
      const postcondition = await this.#checkExpectation(args.expect);
      const receipt: ActionReceipt = {action: 'handle_dialog', dispatched: true, consequential,
        effect: {verdict: args.accept ? 'unattributable' : 'changed', signals: ['dialog_closed']}, postcondition,
        page: {revision: this.#revision, url: this.session.frames.main().url, changed: 'diff'}};
      const body = `диалог ${was.type} «${was.message}»: ${args.accept ? 'принят' : 'отклонён'}`;
      return postcondition.verdict === 'unmet'
        ? {body, receipt, error: {code: 'POSTCONDITION_UNMET', message: `Диалог закрыт, но ожидаемый результат не достигнут: ${postcondition.details}.`}}
        : {body, receipt};
    }, true, true);
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
    if (this.#disposed) return;
    this.#disposed = true;
    for (const off of this.#offs.splice(0)) off();
    this.observer.network.stop();
  }
}
