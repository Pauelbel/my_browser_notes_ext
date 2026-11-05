// One debugger attachment per tab, shared by everyone working on it during a reply, detached when the last one is done.
import {attachTab, type AttachedCdp} from './cdp.ts';
import {Frames} from './frames.ts';
import {Diagnostics} from './diagnostics.ts';

export interface PageSession {
  readonly tabId: number;
  readonly cdp: AttachedCdp;
  readonly frames: Frames;
  /** The prefix of this session's element labels, so a label from an earlier session is never taken for a new one. */
  readonly epoch: string;
  /** Console and network collector, subscribed before the domains are enabled so Chrome's replay is caught. */
  readonly diagnostics: Diagnostics;
}

/** Persisted epochs as lowercase letters: 0 → a, 25 → z, 26 → ba. */
export function epochLabel(n: number): string {
  let out = '';
  let rest = n;
  do { out = String.fromCharCode(97 + (rest % 26)) + out; rest = Math.floor(rest / 26); } while (rest > 0);
  return out;
}

function randomLabel(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), b => String.fromCharCode(65 + (b % 26))).join('');
}

type StorageArea = Pick<chrome.storage.StorageArea, 'get' | 'set'>;

export function createSessionManager(deps: {debuggerApi?: typeof chrome.debugger; storage?: StorageArea | null} = {}) {
  type Entry = {session: Promise<PageSession>; users: number};
  const entries = new Map<number, Entry>();

  async function nextEpoch(): Promise<string> {
    const storage = deps.storage === undefined ? chrome.storage.session : deps.storage;
    if (!storage) return randomLabel();
    try {
      const current = Number((await storage.get('pageEpoch')).pageEpoch ?? 0);
      await storage.set({pageEpoch: current + 1});
      return epochLabel(current);
    } catch {
      return randomLabel();
    }
  }

  async function open(tabId: number, mine: Entry): Promise<PageSession> {
    const cdp = await attachTab(tabId, deps.debuggerApi);
    // A detach by the user or by Chrome ends this session; the next acquire attaches afresh.
    cdp.onDetach(() => { if (entries.get(tabId) === mine) entries.delete(tabId); });
    try {
      const diagnostics = new Diagnostics(cdp);
      const [frames, epoch] = await Promise.all([Frames.start(cdp), nextEpoch()]);
      return {tabId, cdp, frames, epoch, diagnostics};
    } catch (error) {
      await cdp.detach();
      throw error;
    }
  }

  return {
    async acquire(tabId: number): Promise<PageSession> {
      const existing = entries.get(tabId);
      if (existing) {
        const session = await existing.session;
        if (!session.cdp.detached) { existing.users++; return session; }
        entries.delete(tabId);
      }
      const mine = {users: 1} as Entry;
      mine.session = open(tabId, mine);
      entries.set(tabId, mine);
      try {
        return await mine.session;
      } catch (error) {
        if (entries.get(tabId) === mine) entries.delete(tabId);
        throw error;
      }
    },
    async release(session: PageSession): Promise<void> {
      const current = entries.get(session.tabId);
      if (!current || await current.session !== session) return;
      if (--current.users > 0) return;
      entries.delete(session.tabId);
      await session.cdp.detach();
    },
  };
}

let defaultManager: ReturnType<typeof createSessionManager> | null = null;
const manager = () => (defaultManager ??= createSessionManager());
export const acquire = (tabId: number) => manager().acquire(tabId);
export const release = (session: PageSession) => manager().release(session);
