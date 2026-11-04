// What the page did after an action. The layer does not judge success: it compares a baseline taken just before
// dispatch with what it sees in a short window afterwards, and names the strongest signal.
import type {DialogInfo} from './input.ts';
import {probeEval} from './probe.ts';
import type {ProbeCache} from './resolve.ts';
import type {PageSession} from './session.ts';

export type Effect = 'navigated' | 'new_tab' | 'dialog' | 'changed' | 'requests' | 'none';
export interface Evidence {
  effect: Effect; url?: string; dialog?: DialogInfo; requests: number; mutations: number;
  /** The address changed without loading a new document (pushState, a #hash). */
  sameDocument?: string;
  /** A navigation was asked for but no new document came (a download, a 204, a cancel). */
  notCommitted?: string;
}

const POLL_MS = 100;
const CAP_MS = 1500;
const QUIET_MS = 500;
const NAVIGATION_LOAD_MS = 5000;

export function classifyEvidence(s: {dialog?: boolean; newTab?: boolean; navigated?: boolean; mutations: number; requests: number}): Effect {
  if (s.dialog) return 'dialog';
  if (s.newTab) return 'new_tab';
  if (s.navigated) return 'navigated';
  if (s.mutations > 0) return 'changed';
  if (s.requests > 0) return 'requests';
  return 'none';
}

export interface Watch { settle(dialog: () => DialogInfo | undefined): Promise<Evidence>; stop(): void }

export async function startWatch(session: PageSession, probes: ProbeCache, frameIds: string[]): Promise<Watch> {
  const frames = [...new Set([session.frames.main().frameId, ...frameIds])];
  const readMutations = async () => {
    let sum = 0;
    for (const id of frames) sum += await probeEval<number>(session, id, probes, '__assistant.mutations()').catch(() => 0);
    return sum;
  };
  const baseMutations = await readMutations();
  const mainId = session.frames.main().frameId;
  let requests = 0, lastSignal = Date.now(), navigated = false, loaded = false, newTabUrl: string | undefined, navUrl: string | undefined;
  let requestedUrl: string | undefined, sameDocumentUrl: string | undefined;
  const pending = new Set<string>();
  const off = session.cdp.on((method, params, sessionId) => {
    const key = `${sessionId ?? ''}|${params.requestId}`;
    if (method === 'Network.requestWillBeSent' && params.type !== 'EventSource') { requests++; pending.add(key); lastSignal = Date.now(); }
    else if ((method === 'Network.loadingFinished' || method === 'Network.loadingFailed') && pending.delete(key)) lastSignal = Date.now();
    else if (method === 'Page.windowOpen') { newTabUrl = params.url; lastSignal = Date.now(); }
    // A request alone is not a navigation (a download or a 204 never commits); a new document is.
    else if (!sessionId && method === 'Page.frameRequestedNavigation' && params.frameId === mainId) { requestedUrl = params.url; lastSignal = Date.now(); }
    else if (!sessionId && method === 'Page.frameNavigated' && !params.frame.parentId) { navigated = true; navUrl = params.frame.url; lastSignal = Date.now(); }
    else if (!sessionId && method === 'Page.navigatedWithinDocument' && params.frameId === mainId) { sameDocumentUrl = params.url; lastSignal = Date.now(); }
    else if (!sessionId && method === 'Page.loadEventFired') loaded = true;
  });

  return {
    stop: off,
    async settle(dialog) {
      const started = Date.now();
      let mutations = 0;
      for (;;) {
        await new Promise(r => setTimeout(r, POLL_MS));
        const d = dialog();
        if (d) { off(); return {effect: 'dialog', dialog: d, requests, mutations}; }
        if (!navigated) {
          const now = await readMutations();
          if (now - baseMutations !== mutations) { mutations = Math.max(0, now - baseMutations); lastSignal = Date.now(); }
        }
        const elapsed = Date.now() - started;
        if (navigated) {
          // A navigation gets time to load; readiness is checked by the next description.
          if (loaded || elapsed > NAVIGATION_LOAD_MS) break;
          continue;
        }
        // A requested navigation gets time to commit before the window closes.
        const waitingForCommit = requestedUrl !== undefined && elapsed < NAVIGATION_LOAD_MS && pending.size > 0;
        if (!waitingForCommit && (elapsed >= CAP_MS || (Date.now() - lastSignal >= QUIET_MS && pending.size === 0))) break;
      }
      off();
      const effect = classifyEvidence({dialog: false, newTab: Boolean(newTabUrl), navigated, mutations, requests});
      return {effect, url: effect === 'new_tab' ? newTabUrl : effect === 'navigated' ? navUrl : undefined, requests, mutations,
        sameDocument: navigated ? undefined : sameDocumentUrl, notCommitted: navigated || newTabUrl ? undefined : requestedUrl};
    },
  };
}
