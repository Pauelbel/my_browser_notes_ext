// The frames of a tab and the CDP session each lives in. Frames of the same site share the tab's session;
// an iframe from another site runs in its own process and is reached through a flat child session (auto-attach).
import type {Cdp} from './cdp.ts';

export interface FrameInfo {
  frameId: string;
  /** The child session of an out-of-process frame; undefined for frames in the tab's own session. */
  sessionId?: string;
  parentFrameId?: string;
  url: string;
  loaderId: string;
}

interface FrameTree { frame: {id: string; parentId?: string; url: string; loaderId: string}; childFrames?: FrameTree[] }

const DOMAINS = ['Page.enable', 'DOM.enable', 'Accessibility.enable', 'Runtime.enable', 'Network.enable'];

export class Frames {
  #cdp: Cdp;
  #frames = new Map<string, FrameInfo>();
  #listeners = new Set<() => void>();
  /** Child sessions being set up; start() waits for them so the first list() already has every frame. */
  #pending = new Set<Promise<void>>();

  private constructor(cdp: Cdp) {
    this.#cdp = cdp;
  }

  static async start(cdp: Cdp): Promise<Frames> {
    const frames = new Frames(cdp);
    cdp.on((method, params, sessionId) => frames.#event(method, params, sessionId));
    await frames.#setUpSession(undefined);
    while (frames.#pending.size) await Promise.all([...frames.#pending]);
    return frames;
  }

  list(): FrameInfo[] {
    return [...this.#frames.values()];
  }

  get(frameId: string): FrameInfo | undefined {
    return this.#frames.get(frameId);
  }

  main(): FrameInfo {
    return this.list().find(f => !f.parentFrameId)!;
  }

  /** The frame that is the root of `frameId`'s session: the nearest ancestor-or-self whose parent is in another session. */
  sessionRoot(frameId: string): FrameInfo {
    let current = this.#frames.get(frameId)!;
    for (;;) {
      const parent = current.parentFrameId ? this.#frames.get(current.parentFrameId) : undefined;
      if (!parent || parent.sessionId !== current.sessionId) return current;
      current = parent;
    }
  }

  onChange(callback: () => void): () => void {
    this.#listeners.add(callback);
    return () => this.#listeners.delete(callback);
  }

  async #setUpSession(sessionId: string | undefined, parentFrameId?: string): Promise<void> {
    await Promise.all(DOMAINS.map(method => this.#cdp.send(method, {}, sessionId)));
    const {frameTree} = await this.#cdp.send<{frameTree: FrameTree}>('Page.getFrameTree', {}, sessionId);
    this.#addTree(frameTree, sessionId, parentFrameId);
    await this.#cdp.send('Target.setAutoAttach', {autoAttach: true, waitForDebuggerOnStart: false, flatten: true}, sessionId);
    this.#changed();
  }

  #addTree(tree: FrameTree, sessionId: string | undefined, parentFrameId?: string): void {
    const {frame} = tree;
    const known = this.#frames.get(frame.id);
    this.#frames.set(frame.id, {
      frameId: frame.id, sessionId, url: frame.url, loaderId: frame.loaderId,
      parentFrameId: frame.parentId ?? parentFrameId ?? known?.parentFrameId,
    });
    for (const child of tree.childFrames ?? []) this.#addTree(child, sessionId, frame.id);
  }

  #changed(): void {
    this.#listeners.forEach(l => l());
  }

  #event(method: string, params: any, sessionId?: string): void {
    switch (method) {
      case 'Target.attachedToTarget':
        if (params.targetInfo?.type === 'iframe') {
          // The root frame of the child session is the iframe itself; its parent comes from the target info.
          const setup = this.#setUpSession(params.sessionId, params.targetInfo.parentFrameId).catch(() => {});
          this.#pending.add(setup);
          void setup.finally(() => this.#pending.delete(setup));
        }
        return;
      case 'Target.detachedFromTarget':
        for (const [id, frame] of this.#frames) if (frame.sessionId === params.sessionId) this.#frames.delete(id);
        this.#changed();
        return;
      case 'Page.frameAttached':
        if (!this.#frames.has(params.frameId)) {
          this.#frames.set(params.frameId, {frameId: params.frameId, sessionId, parentFrameId: params.parentFrameId, url: '', loaderId: ''});
          this.#changed();
        }
        return;
      case 'Page.frameNavigated': {
        const f = params.frame;
        const known = this.#frames.get(f.id);
        this.#frames.set(f.id, {frameId: f.id, sessionId: known && known.sessionId !== sessionId && !f.parentId ? known.sessionId : sessionId,
          parentFrameId: f.parentId ?? known?.parentFrameId, url: f.url, loaderId: f.loaderId});
        this.#changed();
        return;
      }
      case 'Page.frameDetached':
        if (params.reason !== 'swap') { this.#frames.delete(params.frameId); this.#changed(); }
        return;
    }
  }
}
