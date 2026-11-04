// When a page has settled enough to describe: the document parsed (some pages never reach `complete` because a
// resource keeps loading), no requests in flight for 500 ms
// (long-lived streams do not count), and no DOM mutations for 300 ms. Never longer than the cap.
import type {PageSession} from './session.ts';
import {probeEval} from './probe.ts';

const NETWORK_QUIET_MS = 500;
/** Right after attaching, requests already in flight are invisible; ask for a longer quiet spell then. */
const FRESH_TRACKER_MS = 1500;
const FRESH_QUIET_MS = 1000;
const DOM_QUIET_MS = 300;
const POLL_MS = 100;
/** A request pending longer than this is treated as long-polling, not as loading. */
const LONG_POLL_MS = 3000;

export class NetworkTracker {
  #pending = new Map<string, number>();
  #lastChange = Date.now();
  readonly createdAt = Date.now();
  readonly #off: () => void;

  constructor(session: PageSession) {
    this.#off = session.cdp.on((method, params, sessionId) => {
      const key = `${sessionId ?? ''}|${params.requestId}`;
      if (method === 'Network.requestWillBeSent') {
        if (params.type === 'EventSource' || params.type === 'WebSocket') return;
        this.#pending.set(key, Date.now());
        this.#lastChange = Date.now();
      } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
        if (this.#pending.delete(key)) this.#lastChange = Date.now();
      }
    });
  }

  /** Requests in flight that look like loading (not long-polling). */
  inflight(): number {
    const now = Date.now();
    let count = 0;
    for (const started of this.#pending.values()) if (now - started < LONG_POLL_MS) count++;
    return count;
  }

  /** How long no request has been in flight, in ms; 0 while one is. */
  quietFor(): number {
    return this.inflight() ? 0 : Date.now() - this.#lastChange;
  }

  stop(): void {
    this.#off();
  }
}

export async function waitForReady(session: PageSession, network: NetworkTracker, probes: Map<string, {loaderId: string; contextId: number}>, capMs = 5000):
  Promise<{ready: boolean; waitedMs: number; reason?: string}> {
  const started = Date.now();
  let lastMutations = -1, mutationsStableSince = Date.now();
  for (;;) {
    const main = session.frames.main();
    let readyState = 'loading', mutations = 0;
    try {
      [readyState, mutations] = await probeEval<[string, number]>(session, main.frameId, probes, '[__assistant.readyState(), __assistant.mutations()]');
    } catch {
      // The document is being replaced; try again on the next round.
    }
    if (mutations !== lastMutations) { lastMutations = mutations; mutationsStableSince = Date.now(); }
    const waited = Date.now() - started;
    const domQuiet = Date.now() - mutationsStableSince >= DOM_QUIET_MS;
    const needQuiet = Date.now() - network.createdAt < FRESH_TRACKER_MS ? FRESH_QUIET_MS : NETWORK_QUIET_MS;
    if (readyState !== 'loading' && network.quietFor() >= needQuiet && domQuiet) return {ready: true, waitedMs: waited};
    if (waited >= capMs) {
      const reason = readyState === 'loading' ? 'страница ещё загружается' : network.inflight() ? `идут запросы (${network.inflight()})` : 'страница продолжает меняться';
      return {ready: false, waitedMs: waited, reason};
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}
