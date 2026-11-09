// Highlighting on the page without changing its markup: text through the CSS Custom Highlight API from the probe's
// isolated world, styled by an inspector style sheet (no node in the DOM); elements through a frame drawn in one
// overlay node with a closed shadow root that lets clicks through.
import {PageError} from './errors.ts';
import {probeEval} from './probe.ts';
import {callOn, type ProbeCache, type Target} from './resolve.ts';
import type {PageSession} from './session.ts';

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'red' | 'orange';
export const COLORS: Record<HighlightColor, {fill: string; line: string}> = {
  yellow: {fill: 'rgba(255, 230, 0, 0.6)', line: '#f5c400'},
  green: {fill: 'rgba(80, 220, 100, 0.45)', line: '#22a845'},
  blue: {fill: 'rgba(80, 160, 255, 0.4)', line: '#2f7de1'},
  red: {fill: 'rgba(255, 80, 80, 0.45)', line: '#e53935'},
  orange: {fill: 'rgba(255, 165, 0, 0.5)', line: '#f08c00'},
};

export class Highlighter {
  readonly #session: PageSession;
  readonly #probes: ProbeCache;
  /** Frames (by document) that already have the style sheet. */
  readonly #styled = new Set<string>();
  readonly #owner: string;

  constructor(session: PageSession, probes: ProbeCache, owner = '') {
    this.#session = session;
    this.#probes = probes;
    this.#owner = owner.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  }

  #name(color: HighlightColor): string { return `assistant-${this.#owner ? `${this.#owner}-` : ''}${color}`; }

  async #style(frameId: string): Promise<void> {
    const frame = this.#session.frames.get(frameId);
    if (!frame) return;
    const key = `${frameId}|${frame.loaderId}`;
    if (this.#styled.has(key)) return;
    await this.#session.cdp.send('CSS.enable', {}, frame.sessionId);
    const {styleSheetId} = await this.#session.cdp.send<{styleSheetId: string}>('CSS.createStyleSheet', {frameId}, frame.sessionId);
    const styles = Object.entries(COLORS).map(([name, c]) => `::highlight(${this.#name(name as HighlightColor)}) { background-color: ${c.fill}; color: inherit; }`).join('\n');
    await this.#session.cdp.send('CSS.setStyleSheetText', {styleSheetId, text: styles}, frame.sessionId);
    this.#styled.add(key);
  }

  /** Highlights every visible occurrence of the text in every frame; returns how many. */
  async text(text: string, color: HighlightColor): Promise<number> {
    let count = 0;
    for (const frame of this.#session.frames.list()) {
      try {
        await this.#style(frame.frameId);
        count += await probeEval<number>(this.#session, frame.frameId, this.#probes,
          `__assistant.highlightText(${JSON.stringify(text)}, ${JSON.stringify(this.#name(color))}, ${JSON.stringify(this.#owner)})`);
      } catch {
        // A frame that is gone or not scriptable has nothing to highlight.
      }
    }
    return count;
  }

  async element(target: Target, color: HighlightColor): Promise<void> {
    await callOn(this.#session, target.frame, target.objectId,
      `function (color, owner) { return __assistant.highlightElement(this.nodeType === 1 ? this : this.parentElement, color, owner); }`,
      [{value: COLORS[color].line}, {value: this.#owner}]);
  }

  async clear(): Promise<void> {
    for (const frame of this.#session.frames.list()) {
      await probeEval(this.#session, frame.frameId, this.#probes, `__assistant.clearHighlights(${JSON.stringify(this.#owner || undefined)})`).catch(() => {});
    }
  }
}

export function checkColor(color: string | undefined): HighlightColor {
  const c = (color ?? 'yellow') as HighlightColor;
  if (!(c in COLORS)) throw new PageError('NOT_FOUND', `Цвет ${color} не поддерживается. Есть: ${Object.keys(COLORS).join(', ')}.`);
  return c;
}
