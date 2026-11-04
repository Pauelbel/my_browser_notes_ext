// The layer's tools on one tab, for the agent and for the e2e harness. Each returns text for the model; page text
// sits between page-content markers, and a layer error becomes a result the model can act on, never an exception.
import {Observer} from './observe.ts';
import {RefRegistry} from './refs.ts';
import type {PageSession} from './session.ts';
import {PageError} from './errors.ts';
import type {OutlineMode, WindowMode} from './render.ts';
import {resolveTarget} from './resolve.ts';
import {waitActionable} from './actionability.ts';

export interface ToolResult {
  text: string;
  ok: boolean;
}

export const PAGE_START = '<<<page-content>>>';
export const PAGE_END = '<<<end-page-content>>>';

export function pageText(head: string, body: string, notices: string[], before = ''): string {
  return [before, head, PAGE_START, body, PAGE_END, ...notices].filter(Boolean).join('\n');
}

export function errorResult(error: unknown): ToolResult {
  if (error instanceof PageError) {
    const delivered = error.delivered === true ? ' Событие ввода было отправлено: проверьте страницу, прежде чем повторять.'
      : error.delivered === 'unknown' ? ' Неизвестно, дошло ли событие ввода: проверьте страницу, прежде чем повторять.' : '';
    return {ok: false, text: `ошибка ${error.code}: ${error.message}${delivered}`};
  }
  return {ok: false, text: `ошибка INTERNAL: ${error instanceof Error ? error.message : String(error)}`};
}

export class PageTools {
  readonly session: PageSession;
  readonly refs: RefRegistry;
  readonly observer: Observer;
  budget: number;

  constructor(session: PageSession, options: {budget: number}) {
    this.session = session;
    this.budget = options.budget;
    this.refs = new RefRegistry(session.epoch);
    this.observer = new Observer(session, this.refs);
    // A frame that loads a new document makes its labels stale.
    session.frames.onChange(() => { for (const f of session.frames.list()) this.refs.invalidateFrame(f.frameId, f.loaderId); });
  }

  protected async run(fn: () => Promise<string>): Promise<ToolResult> {
    try {
      return {ok: true, text: await fn()};
    } catch (error) {
      return errorResult(error);
    }
  }

  snapshot(args: {mode?: OutlineMode; window?: WindowMode} = {}): Promise<ToolResult> {
    return this.run(async () => {
      const o = await this.observer.snapshot({...args, budget: this.budget});
      return pageText(o.header, o.body, o.notices);
    });
  }

  find(args: {role?: string; name?: string; text?: string}): Promise<ToolResult> {
    return this.run(async () => {
      const r = await this.observer.find(args, this.budget);
      return pageText(r.header, r.body, r.notices);
    });
  }

  read(args: {ref?: string} = {}): Promise<ToolResult> {
    return this.run(async () => {
      const r = await this.observer.read({ref: args.ref, budget: this.budget});
      return pageText(r.header, r.body, r.notices);
    });
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
