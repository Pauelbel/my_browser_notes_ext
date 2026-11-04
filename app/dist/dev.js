// src/page/errors.ts
var PageError = class extends Error {
  code;
  delivered;
  constructor(code, message, delivered = false) {
    super(message);
    this.code = code;
    this.delivered = delivered;
  }
};
var NOT_SUPPORTED_TEXT = "\u042D\u0442\u0430 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0430 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430 \u0434\u043B\u044F \u043F\u043E\u043C\u043E\u0449\u043D\u0438\u043A\u0430 (\u0441\u043B\u0443\u0436\u0435\u0431\u043D\u0430\u044F \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0430 \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u0430).";

// src/page/cdp.ts
var DEFAULT_TIMEOUT_MS = 1e4;
function detachText(reason) {
  if (reason === "canceled_by_user") return "\u041E\u0442\u043B\u0430\u0434\u043A\u0430 \u043E\u0442\u043A\u043B\u044E\u0447\u0435\u043D\u0430 \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u0435\u043C (\u043A\u043D\u043E\u043F\u043A\u0430 \xAB\u041E\u0442\u043C\u0435\u043D\u0430\xBB \u043D\u0430 \u043F\u043B\u0430\u0448\u043A\u0435 Chrome).";
  if (reason === "target_closed") return "\u0412\u043A\u043B\u0430\u0434\u043A\u0430 \u0437\u0430\u043A\u0440\u044B\u0442\u0430.";
  return `\u041E\u0442\u043B\u0430\u0434\u0447\u0438\u043A \u043E\u0442\u043A\u043B\u044E\u0447\u0438\u043B\u0441\u044F (${reason}).`;
}
function attachError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/Cannot access|Cannot attach|chrome:\/\/|chrome-extension:\/\/|extensions gallery|webstore/i.test(message)) {
    return new PageError("PAGE_NOT_SUPPORTED", NOT_SUPPORTED_TEXT);
  }
  if (/No tab with given id/i.test(message)) return new PageError("DETACHED", "\u0412\u043A\u043B\u0430\u0434\u043A\u0430 \u0437\u0430\u043A\u0440\u044B\u0442\u0430.");
  return new PageError("INTERNAL", `\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0438\u0442\u044C\u0441\u044F \u043A \u0432\u043A\u043B\u0430\u0434\u043A\u0435: ${message}`);
}
async function attachTab(tabId, api = chrome.debugger) {
  try {
    await api.attach({ tabId }, "1.3");
  } catch (error) {
    if (!/already attached/i.test(error instanceof Error ? error.message : String(error))) throw attachError(error);
    await api.detach({ tabId }).catch(() => {
    });
    try {
      await api.attach({ tabId }, "1.3");
    } catch (again) {
      throw /already attached/i.test(String(again)) ? new PageError("INTERNAL", "\u041A \u0432\u043A\u043B\u0430\u0434\u043A\u0435 \u0443\u0436\u0435 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0451\u043D \u0434\u0440\u0443\u0433\u043E\u0439 \u043E\u0442\u043B\u0430\u0434\u0447\u0438\u043A.") : attachError(again);
    }
  }
  const handlers = /* @__PURE__ */ new Set();
  const detachCallbacks = [];
  let detached = null;
  const onEvent = (source, method, params) => {
    if (source.tabId !== tabId) return;
    for (const handler of handlers) handler(method, params ?? {}, source.sessionId);
  };
  const onDetach = (source, reason) => {
    if (source.tabId !== tabId || detached) return;
    detached = detachText(reason);
    cleanup();
    detachCallbacks.forEach((callback) => callback(detached));
  };
  const cleanup = () => {
    api.onEvent.removeListener(onEvent);
    api.onDetach.removeListener(onDetach);
  };
  api.onEvent.addListener(onEvent);
  api.onDetach.addListener(onDetach);
  return {
    get detached() {
      return detached;
    },
    on(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    onDetach(callback) {
      detachCallbacks.push(callback);
    },
    async send(method, params = {}, sessionId, timeoutMs = DEFAULT_TIMEOUT_MS) {
      if (detached) throw new PageError("DETACHED", detached, "unknown");
      const target = sessionId ? { tabId, sessionId } : { tabId };
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new PageError("TIMEOUT", `\u0421\u0442\u0440\u0430\u043D\u0438\u0446\u0430 \u043D\u0435 \u043E\u0442\u0432\u0435\u0442\u0438\u043B\u0430 \u043D\u0430 ${method} \u0437\u0430 ${timeoutMs} \u043C\u0441.`, "unknown")), timeoutMs);
      });
      try {
        return await Promise.race([api.sendCommand(target, method, params), timeout]);
      } catch (error) {
        if (error instanceof PageError) throw error;
        if (detached) throw new PageError("DETACHED", detached, "unknown");
        const message = error instanceof Error ? error.message : String(error);
        if (/not attached|Detached while handling/i.test(message)) throw new PageError("DETACHED", "\u041E\u0442\u043B\u0430\u0434\u0447\u0438\u043A \u043E\u0442\u043A\u043B\u044E\u0447\u0438\u043B\u0441\u044F.", "unknown");
        throw new PageError("INTERNAL", `${method}: ${message}`, "unknown");
      } finally {
        clearTimeout(timer);
      }
    },
    async detach() {
      if (detached) return;
      detached = "\u041E\u0442\u043B\u0430\u0434\u0447\u0438\u043A \u043E\u0442\u043A\u043B\u044E\u0447\u0451\u043D.";
      cleanup();
      await api.detach({ tabId }).catch(() => {
      });
    }
  };
}

// src/page/frames.ts
var DOMAINS = ["Page.enable", "DOM.enable", "Accessibility.enable", "Runtime.enable", "Network.enable"];
var Frames = class _Frames {
  #cdp;
  #frames = /* @__PURE__ */ new Map();
  #listeners = /* @__PURE__ */ new Set();
  /** Child sessions being set up; start() waits for them so the first list() already has every frame. */
  #pending = /* @__PURE__ */ new Set();
  constructor(cdp) {
    this.#cdp = cdp;
  }
  static async start(cdp) {
    const frames = new _Frames(cdp);
    cdp.on((method, params, sessionId) => frames.#event(method, params, sessionId));
    await frames.#setUpSession(void 0);
    while (frames.#pending.size) await Promise.all([...frames.#pending]);
    return frames;
  }
  list() {
    return [...this.#frames.values()];
  }
  get(frameId) {
    return this.#frames.get(frameId);
  }
  main() {
    return this.list().find((f) => !f.parentFrameId);
  }
  /** The frame that is the root of `frameId`'s session: the nearest ancestor-or-self whose parent is in another session. */
  sessionRoot(frameId) {
    let current = this.#frames.get(frameId);
    for (; ; ) {
      const parent = current.parentFrameId ? this.#frames.get(current.parentFrameId) : void 0;
      if (!parent || parent.sessionId !== current.sessionId) return current;
      current = parent;
    }
  }
  onChange(callback) {
    this.#listeners.add(callback);
    return () => this.#listeners.delete(callback);
  }
  async #setUpSession(sessionId, parentFrameId) {
    await Promise.all(DOMAINS.map((method) => this.#cdp.send(method, {}, sessionId)));
    const { frameTree } = await this.#cdp.send("Page.getFrameTree", {}, sessionId);
    this.#addTree(frameTree, sessionId, parentFrameId);
    await this.#cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
    this.#changed();
  }
  #addTree(tree, sessionId, parentFrameId) {
    const { frame } = tree;
    const known = this.#frames.get(frame.id);
    this.#frames.set(frame.id, {
      frameId: frame.id,
      sessionId,
      url: frame.url,
      loaderId: frame.loaderId,
      parentFrameId: frame.parentId ?? parentFrameId ?? known?.parentFrameId
    });
    for (const child of tree.childFrames ?? []) this.#addTree(child, sessionId, frame.id);
  }
  #changed() {
    this.#listeners.forEach((l) => l());
  }
  #event(method, params, sessionId) {
    switch (method) {
      case "Target.attachedToTarget":
        if (params.targetInfo?.type === "iframe") {
          const setup = this.#setUpSession(params.sessionId, params.targetInfo.parentFrameId).catch(() => {
          });
          this.#pending.add(setup);
          void setup.finally(() => this.#pending.delete(setup));
        }
        return;
      case "Target.detachedFromTarget":
        for (const [id, frame] of this.#frames) if (frame.sessionId === params.sessionId) this.#frames.delete(id);
        this.#changed();
        return;
      case "Page.frameAttached":
        if (!this.#frames.has(params.frameId)) {
          this.#frames.set(params.frameId, { frameId: params.frameId, sessionId, parentFrameId: params.parentFrameId, url: "", loaderId: "" });
          this.#changed();
        }
        return;
      case "Page.frameNavigated": {
        const f = params.frame;
        const known = this.#frames.get(f.id);
        this.#frames.set(f.id, {
          frameId: f.id,
          sessionId: known && known.sessionId !== sessionId && !f.parentId ? known.sessionId : sessionId,
          parentFrameId: f.parentId ?? known?.parentFrameId,
          url: f.url,
          loaderId: f.loaderId
        });
        this.#changed();
        return;
      }
      case "Page.frameDetached":
        if (params.reason !== "swap") {
          this.#frames.delete(params.frameId);
          this.#changed();
        }
        return;
    }
  }
};

// src/page/session.ts
function epochLabel(n) {
  let out = "";
  let rest = n;
  do {
    out = String.fromCharCode(97 + rest % 26) + out;
    rest = Math.floor(rest / 26);
  } while (rest > 0);
  return out;
}
function randomLabel() {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => String.fromCharCode(65 + b % 26)).join("");
}
function createSessionManager(deps = {}) {
  const entries = /* @__PURE__ */ new Map();
  async function nextEpoch() {
    const storage = deps.storage === void 0 ? chrome.storage.session : deps.storage;
    if (!storage) return randomLabel();
    try {
      const current = Number((await storage.get("pageEpoch")).pageEpoch ?? 0);
      await storage.set({ pageEpoch: current + 1 });
      return epochLabel(current);
    } catch {
      return randomLabel();
    }
  }
  async function open(tabId, mine) {
    const cdp = await attachTab(tabId, deps.debuggerApi);
    cdp.onDetach(() => {
      if (entries.get(tabId) === mine) entries.delete(tabId);
    });
    try {
      const [frames, epoch] = await Promise.all([Frames.start(cdp), nextEpoch()]);
      return { tabId, cdp, frames, epoch };
    } catch (error) {
      await cdp.detach();
      throw error;
    }
  }
  return {
    async acquire(tabId) {
      const existing = entries.get(tabId);
      if (existing) {
        const session = await existing.session;
        if (!session.cdp.detached) {
          existing.users++;
          return session;
        }
        entries.delete(tabId);
      }
      const mine = { users: 1 };
      mine.session = open(tabId, mine);
      entries.set(tabId, mine);
      try {
        return await mine.session;
      } catch (error) {
        if (entries.get(tabId) === mine) entries.delete(tabId);
        throw error;
      }
    },
    async release(session) {
      const current = entries.get(session.tabId);
      if (!current || await current.session !== session) return;
      if (--current.users > 0) return;
      entries.delete(session.tabId);
      await session.cdp.detach();
    }
  };
}
var defaultManager = null;
var manager = () => defaultManager ??= createSessionManager();
var acquire = (tabId) => manager().acquire(tabId);
var release = (session) => manager().release(session);

// src/page/capture.ts
var LAYOUT_STYLES = ["display", "visibility", "opacity", "cursor", "pointer-events", "overflow-x", "overflow-y"];
var COMMAND_TIMEOUT_MS = 8e3;
async function capture(session) {
  const { cdp, frames } = session;
  const list = frames.list().filter((f) => f.url && !f.url.startsWith("about:blank") || !f.parentFrameId);
  const sessions = [...new Set(list.map((f) => f.sessionId ?? ""))];
  const layoutPromise = Promise.all(sessions.map(async (key) => {
    const snapshot = await cdp.send("DOMSnapshot.captureSnapshot", { computedStyles: LAYOUT_STYLES, includeDOMRects: true }, key || void 0, COMMAND_TIMEOUT_MS);
    return [key, snapshot];
  })).then((entries) => ({ layout: Object.fromEntries(entries) }), (error) => ({ layout: {}, layoutError: error instanceof Error ? error.message : String(error) }));
  const captured = await Promise.all(list.map(async (frame) => {
    const base = { frameId: frame.frameId, sessionId: frame.sessionId, parentFrameId: frame.parentFrameId, url: frame.url, loaderId: frame.loaderId };
    try {
      const { nodes } = await cdp.send("Accessibility.getFullAXTree", { frameId: frame.frameId }, frame.sessionId, COMMAND_TIMEOUT_MS);
      return { ...base, nodes, status: "captured" };
    } catch (error) {
      return { ...base, nodes: [], status: "failed", reason: error instanceof Error ? error.message : String(error) };
    }
  }));
  const metrics = await cdp.send("Page.getLayoutMetrics");
  const { layout, layoutError } = await layoutPromise;
  const main = captured.find((f) => !f.parentFrameId) ?? captured[0];
  const root = main?.nodes.find((n) => n.role?.value === "RootWebArea");
  return {
    url: main?.url ?? "",
    title: typeof root?.name?.value === "string" ? root.name.value : "",
    frames: captured,
    layout,
    layoutError,
    viewport: {
      width: Math.round(metrics.cssLayoutViewport.clientWidth),
      height: Math.round(metrics.cssLayoutViewport.clientHeight),
      scrollY: Math.round(metrics.cssLayoutViewport.pageY),
      pageHeight: Math.round(metrics.cssContentSize.height)
    }
  };
}

// src/dev/harness.ts
async function withSession(tabId, fn) {
  const session = await acquire(tabId);
  try {
    return await fn(session);
  } finally {
    await release(session);
  }
}
var layer = {
  ping: () => "pong",
  async openTab(url) {
    const win = await chrome.windows.create({ url, width: 1e3, height: 760 });
    return win.tabs[0].id;
  },
  frames: (tabId) => withSession(tabId, async (session) => session.frames.list()),
  capture: (tabId) => withSession(tabId, capture)
};
Object.assign(window, { layer });
