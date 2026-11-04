// Observing a tab: wait until it settles, capture, build the outline, render it within the budget.
import {capture, type Capture} from './capture.ts';
import {buildOutline, type ONode} from './outline.ts';
import {header, render, renderLine, type OutlineMode, type WindowMode} from './render.ts';
import type {RefRegistry} from './refs.ts';
import type {PageSession} from './session.ts';
import {NetworkTracker, waitForReady} from './readiness.ts';
import {PageError} from './errors.ts';
import {MASK} from './masking.ts';

export interface Observation {
  header: string;
  body: string;
  notices: string[];
  refs: string[];
  roots: ONode[];
  capture: Capture;
}

const FIND_MAX = 30;
const fold = (s: string) => s.toLocaleLowerCase('ru').replaceAll('ё', 'е');
const all = (nodes: ONode[]): ONode[] => nodes.flatMap(n => [n, ...all(n.children)]);

export class Observer {
  readonly session: PageSession;
  readonly refs: RefRegistry;
  readonly network: NetworkTracker;
  readonly probes = new Map<string, {loaderId: string; contextId: number}>();
  #last: Observation | null = null;

  constructor(session: PageSession, refs: RefRegistry) {
    this.session = session;
    this.refs = refs;
    this.network = new NetworkTracker(session);
  }

  last(): Observation | null {
    return this.#last;
  }

  /** A fresh capture after waiting for the page to settle; a page that does not settle is captured as it is. */
  async observe(): Promise<{capture: Capture; roots: ONode[]; notices: string[]}> {
    const ready = await waitForReady(this.session, this.network, this.probes);
    const raw = await capture(this.session);
    const {roots, notices} = buildOutline(raw);
    if (!ready.ready) notices.unshift(`Страница не успокоилась за ${Math.round(ready.waitedMs / 1000)} с (${ready.reason}): описание может быть неполным.`);
    return {capture: raw, roots, notices};
  }

  /** A capture without waiting for the page to settle, for polling. */
  async quick(): Promise<{capture: Capture; roots: ONode[]}> {
    const raw = await capture(this.session);
    return {capture: raw, roots: buildOutline(raw).roots};
  }

  async snapshot(opts: {mode?: OutlineMode; window?: WindowMode; budget: number}): Promise<Observation> {
    const {capture: raw, roots, notices} = await this.observe();
    const rendered = render(roots, this.refs, {mode: opts.mode ?? 'interactive', window: opts.window ?? 'near', budget: opts.budget, viewport: raw.viewport});
    this.#last = {header: header(raw), body: rendered.body, notices: [...notices, ...rendered.notices], refs: rendered.shown, roots, capture: raw};
    return this.#last;
  }

  async find(q: {role?: string; name?: string; text?: string}, budget: number): Promise<{header: string; body: string; notices: string[]}> {
    if (!q.role && !q.name && !q.text) throw new PageError('NOT_FOUND', 'Укажите хотя бы одно из: role, name, text.');
    const {capture: raw, roots, notices} = await this.observe();
    const name = q.name ? fold(q.name) : null, text = q.text ? fold(q.text) : null;
    const matches = all(roots).filter(n => (!q.role || n.role === q.role)
      && (!name || fold(n.name).includes(name))
      && (!text || fold(n.kind === 'text' ? n.name : `${n.name} ${n.value ?? ''}`).includes(text)));
    if (!matches.length) throw new PageError('NOT_FOUND', 'Ничего не найдено. Попробуйте другой запрос или snapshot.');
    const lines: string[] = [];
    let length = 0;
    for (const n of matches.slice(0, FIND_MAX)) {
      if (n.interactive && n.backendNodeId !== undefined) this.refs.assign(n);
      const line = renderLine(n);
      if (length + line.length > budget) break;
      lines.push(line);
      length += line.length + 1;
    }
    if (matches.length > lines.length) notices.push(`Показано ${lines.length} из ${matches.length} совпадений.`);
    return {header: header(raw), body: lines.join('\n'), notices};
  }

  async read(opts: {ref?: string; budget: number}): Promise<{header: string; body: string; notices: string[]}> {
    const {capture: raw, roots, notices} = await this.observe();
    let scope = roots;
    if (opts.ref) {
      const record = this.refs.get(opts.ref);
      const node = all(roots).find(n => n.backendNodeId === record.backendNodeId && n.loaderId === record.loaderId);
      if (!node) throw new PageError('REF_STALE', `Элемент ${opts.ref} больше не на странице: сделайте snapshot.`);
      scope = [node];
    }
    let body = toMarkdown(scope);
    if (body.length > opts.budget) {
      body = body.slice(0, opts.budget);
      notices.push(`Текст урезан до ${opts.budget} символов: прочитайте нужную часть через read с ref.`);
    }
    return {header: header(raw), body, notices};
  }
}

const inline = (nodes: ONode[]): string => nodes.map(n => (n.kind === 'text' ? n.name : n.role === 'link' ? link(n) : n.name || inline(n.children))).join(' ').replace(/\s+/g, ' ').trim();
const link = (n: ONode) => `[${n.name || inline(n.children)}](${n.href ?? ''})`;

/** The outline as Markdown for reading: headings, paragraphs, list items, links; controls as short brackets. */
export function toMarkdown(nodes: ONode[]): string {
  const out: string[] = [];
  const walk = (list: ONode[]) => {
    for (const n of list) {
      if (n.kind === 'text') out.push(n.name);
      else if (n.role === 'heading') out.push(`${'#'.repeat(Math.min(6, n.level ?? 2))} ${n.name || inline(n.children)}`);
      else if (n.role === 'link') out.push(link(n));
      else if (n.role === 'listitem') out.push(`- ${inline(n.children) || n.name}`);
      else if (n.role === 'image' || n.role === 'img') out.push(`[изображение: ${n.name}]`);
      else if (n.role === 'clickable') out.push(`[clickable] ${inline(n.children) || n.name}`);
      else if (n.interactive) out.push(`[${n.role} "${n.name}"${n.masked ? ` = "${MASK}"` : n.value !== undefined ? ` = "${n.value}"` : ''}]`);
      else walk(n.children);
    }
  };
  walk(nodes);
  return out.join('\n\n').trim();
}
