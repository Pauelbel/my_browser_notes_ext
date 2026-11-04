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
  let dialog = null;
  const waiting = /* @__PURE__ */ new Set();
  const detachCallbacks = [];
  let detached = null;
  const onEvent = (source, method, params) => {
    if (source.tabId !== tabId) return;
    if (method === "Page.javascriptDialogOpening") {
      const p = params;
      dialog = `\u041D\u0430 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0435 \u043E\u0442\u043A\u0440\u044B\u0442 \u0434\u0438\u0430\u043B\u043E\u0433 ${p.type ?? ""}: \xAB${p.message ?? ""}\xBB.`;
      const error = new PageError("DIALOG_OPEN", dialog, "unknown");
      for (const reject of waiting) reject(error);
      waiting.clear();
    } else if (method === "Page.javascriptDialogClosed") {
      dialog = null;
    }
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
      const answersDialog = method === "Page.handleJavaScriptDialog";
      if (dialog && !answersDialog) throw new PageError("DIALOG_OPEN", dialog);
      const target = sessionId ? { tabId, sessionId } : { tabId };
      let timer;
      let release2;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new PageError("TIMEOUT", `\u0421\u0442\u0440\u0430\u043D\u0438\u0446\u0430 \u043D\u0435 \u043E\u0442\u0432\u0435\u0442\u0438\u043B\u0430 \u043D\u0430 ${method} \u0437\u0430 ${timeoutMs} \u043C\u0441.`, "unknown")), timeoutMs);
        if (!answersDialog) {
          release2 = reject;
          waiting.add(reject);
        }
      });
      const command = api.sendCommand(target, method, params);
      command.catch(() => {
      });
      try {
        return await Promise.race([command, timeout]);
      } catch (error) {
        if (error instanceof PageError) throw error;
        if (detached) throw new PageError("DETACHED", detached, "unknown");
        const message = error instanceof Error ? error.message : String(error);
        if (/not attached|Detached while handling/i.test(message)) throw new PageError("DETACHED", "\u041E\u0442\u043B\u0430\u0434\u0447\u0438\u043A \u043E\u0442\u043A\u043B\u044E\u0447\u0438\u043B\u0441\u044F.", "unknown");
        throw new PageError("INTERNAL", `${method}: ${message}`, "unknown");
      } finally {
        clearTimeout(timer);
        if (release2) waiting.delete(release2);
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
  async function open2(tabId, mine) {
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
      mine.session = open2(tabId, mine);
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
  const layoutPromise = Promise.allSettled(sessions.map(async (key) => {
    const snapshot = await cdp.send("DOMSnapshot.captureSnapshot", { computedStyles: LAYOUT_STYLES, includeDOMRects: true }, key || void 0, COMMAND_TIMEOUT_MS);
    return [key, snapshot];
  })).then((results) => {
    const layout2 = {};
    const errors = [];
    for (const r of results) {
      if (r.status === "fulfilled") layout2[r.value[0]] = r.value[1];
      else errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
    }
    return { layout: layout2, layoutError: errors.length ? errors.join("; ") : void 0 };
  });
  const captured = await Promise.all(list.map(async (frame) => {
    const base = { frameId: frame.frameId, sessionId: frame.sessionId, parentFrameId: frame.parentFrameId, url: frame.url, loaderId: frame.loaderId };
    try {
      const { nodes } = await cdp.send("Accessibility.getFullAXTree", { frameId: frame.frameId }, frame.sessionId, COMMAND_TIMEOUT_MS);
      let ownerBackendNodeId;
      if (frame.parentFrameId) {
        const parent = frames.get(frame.parentFrameId);
        ownerBackendNodeId = await cdp.send("DOM.getFrameOwner", { frameId: frame.frameId }, parent?.sessionId, COMMAND_TIMEOUT_MS).then((r) => r.backendNodeId, () => void 0);
      }
      return { ...base, ownerBackendNodeId, nodes, status: "captured" };
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

// src/page/ax.ts
var roleOf = (n) => typeof n.role?.value === "string" ? n.role.value : "";
var nameOf = (n) => typeof n.name?.value === "string" ? n.name.value : "";
function valueOf(n) {
  const v = n.value?.value;
  return v === void 0 || v === null ? void 0 : String(v);
}
function property(n, name) {
  return n.properties?.find((p) => p.name === name)?.value.value;
}
function cleanText(input) {
  return input.replace(/[-]/g, "").replace(/\s+/g, " ").trim();
}

// src/page/layout.ts
var STYLE = Object.fromEntries(LAYOUT_STYLES.map((name, i) => [name, i]));
function decodeSnapshot(raw) {
  const out = /* @__PURE__ */ new Map();
  const snapshot = raw;
  if (!snapshot?.documents) return out;
  const str = (i) => i >= 0 ? snapshot.strings[i] : "";
  for (const doc of snapshot.documents) {
    const n = doc.nodes;
    const layoutOf = /* @__PURE__ */ new Map();
    doc.layout.nodeIndex.forEach((nodeIndex, li) => layoutOf.set(nodeIndex, li));
    const clickListener = new Set(n.isClickable?.index ?? []);
    const pointer = [];
    for (let i = 0; i < n.backendNodeId.length; i++) {
      const li = layoutOf.get(i);
      const styles = li === void 0 ? void 0 : doc.layout.styles[li];
      const style = (name) => styles ? str(styles[STYLE[name]]) : "";
      const b = li === void 0 ? void 0 : doc.layout.bounds[li];
      const bounds = b ? { x: b[0], y: b[1], width: b[2], height: b[3] } : void 0;
      pointer[i] = style("cursor") === "pointer";
      const attrs = {};
      const list = n.attributes[i] ?? [];
      for (let a = 0; a + 1 < list.length; a += 2) attrs[str(list[a]).toLowerCase()] = str(list[a + 1]);
      const parentIndex = n.parentIndex[i];
      const rendered = Boolean(bounds && bounds.width * bounds.height > 0) && style("display") !== "none" && !["hidden", "collapse"].includes(style("visibility")) && style("opacity") !== "0";
      const isElement = n.nodeType[i] === 1;
      out.set(n.backendNodeId[i], {
        backendNodeId: n.backendNodeId[i],
        tag: str(n.nodeName[i]).toLowerCase(),
        attrs,
        parent: parentIndex >= 0 ? n.backendNodeId[parentIndex] : -1,
        bounds,
        rendered,
        clickable: isElement && (clickListener.has(i) || pointer[i] && !(parentIndex >= 0 && pointer[parentIndex])),
        text: n.nodeType[i] === 3 ? str(n.nodeValue[i]) : void 0
      });
    }
  }
  return out;
}

// src/page/masking.ts
var MASK = "\u2022\u2022\u2022\u2022";
var SECRET_AUTOCOMPLETE = /\b(cc-number|cc-csc|cc-exp|one-time-code|current-password|new-password)\b/i;
function isSecretField(attrs) {
  if ((attrs.type ?? "").toLowerCase() === "password") return true;
  return SECRET_AUTOCOMPLETE.test(attrs.autocomplete ?? "");
}

// src/page/outline.ts
var INTERACTIVE_ROLES = /* @__PURE__ */ new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "treeitem",
  "DisclosureTriangle"
]);
var VALUE_ROLES = /* @__PURE__ */ new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider"]);
var TEXT_FIELDS = /* @__PURE__ */ new Set(["textbox", "searchbox", "spinbutton", "combobox"]);
var TRANSPARENT = /* @__PURE__ */ new Set([
  "generic",
  "none",
  "presentation",
  "group",
  "LabelText",
  "cell",
  "gridcell",
  "paragraph",
  "Section",
  "Div",
  "rowgroup",
  "Abbr",
  "Ruby",
  "time",
  "emphasis",
  "strong",
  "subscript",
  "superscript",
  "Pre",
  "code",
  "mark",
  "blockquote"
]);
var SKIP = /* @__PURE__ */ new Set(["InlineTextBox", "LineBreak", "ListMarker"]);
var OVERLAY_ATTR = "data-assistant-overlay";
var CLICKABLE_NAME_MAX = 80;
function states(ax) {
  const out = [];
  if (property(ax, "disabled") === true) out.push("disabled");
  const checked = property(ax, "checked");
  if (checked === "true" || checked === true) out.push("checked");
  if (checked === "mixed") out.push("mixed");
  if (property(ax, "selected") === true) out.push("selected");
  const expanded = property(ax, "expanded");
  if (expanded === true) out.push("expanded");
  if (expanded === false) out.push("collapsed");
  if (property(ax, "focused") === true && roleOf(ax) !== "RootWebArea") out.push("focused");
  if (property(ax, "required") === true) out.push("required");
  if (property(ax, "readonly") === true) out.push("readonly");
  return out;
}
var hasInteractive = (nodes) => nodes.some((n) => n.interactive || hasInteractive(n.children));
function textOf(nodes) {
  return cleanText(nodes.map((n) => n.kind === "text" ? n.name : n.name || textOf(n.children)).join(" "));
}
function tidy(children, parentName) {
  const out = [];
  for (const child of children) {
    if (child.kind === "text" && child.name === parentName) continue;
    const last = out[out.length - 1];
    if (child.kind === "text" && last?.kind === "text") last.name = cleanText(`${last.name} ${child.name}`);
    else out.push(child);
  }
  return out.filter((node, i) => node.kind !== "text" || ![out[i - 1], out[i + 1]].some((next) => next?.kind === "element" && next.interactive && next.name === node.name));
}
function buildFrame(frame, offsetY, ctx) {
  if (frame.status !== "captured") {
    ctx.notices.push(`\u0424\u0440\u0435\u0439\u043C ${frame.url} \u043D\u0435 \u0441\u043D\u044F\u0442: ${frame.reason ?? "\u043D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u0430\u044F \u043F\u0440\u0438\u0447\u0438\u043D\u0430"}.`);
    return [];
  }
  const layout = ctx.layouts.get(frame.sessionId ?? "");
  const byId = new Map(frame.nodes.map((n) => [n.nodeId, n]));
  const lay = (ax) => ax.backendDOMNodeId !== void 0 ? layout?.get(ax.backendDOMNodeId) : void 0;
  const labelFor = /* @__PURE__ */ new Map();
  const consumedLabels = /* @__PURE__ */ new Set();
  if (layout) {
    const labelsById = /* @__PURE__ */ new Map();
    for (const node of layout.values()) if (node.tag === "label" && node.attrs.for && node.rendered) labelsById.set(node.attrs.for, node);
    for (const ax of frame.nodes) {
      const role = roleOf(ax);
      const own = lay(ax);
      if (role !== "checkbox" && role !== "radio" || !own || own.rendered) continue;
      let label = own.attrs.id ? labelsById.get(own.attrs.id) : void 0;
      for (let p = own.parent; !label && p >= 0; p = layout.get(p)?.parent ?? -1) {
        const ancestor = layout.get(p);
        if (ancestor?.tag === "label" && ancestor.rendered) label = ancestor;
      }
      if (label) {
        labelFor.set(own.backendNodeId, label);
        consumedLabels.add(label.backendNodeId);
      }
    }
  }
  const base = (ax) => ({ frameId: frame.frameId, sessionId: frame.sessionId, loaderId: frame.loaderId, backendNodeId: ax.backendDOMNodeId });
  const yOf = (node) => node?.bounds ? Math.round(node.bounds.y + offsetY) : void 0;
  function convert(ax, insideInteractive) {
    const own = lay(ax);
    if (own?.attrs[OVERLAY_ATTR] !== void 0) return [];
    const role = roleOf(ax);
    if (SKIP.has(role)) return [];
    const kids = (inside) => (ax.childIds ?? []).flatMap((id) => {
      const child = byId.get(id);
      return child ? convert(child, inside) : [];
    });
    if (ax.ignored) return kids(insideInteractive);
    if (role === "StaticText") {
      if (own && !own.rendered) return [];
      const text = cleanText(nameOf(ax));
      return text ? [{ ...base(ax), kind: "text", role: "text", name: text, states: [], children: [], interactive: false, y: yOf(own) }] : [];
    }
    if (role === "Iframe") {
      const child = ctx.capture.frames.find((f) => f.ownerBackendNodeId === ax.backendDOMNodeId && f.parentFrameId && (ctx.capture.frames.find((p) => p.frameId === f.parentFrameId)?.sessionId ?? "") === (frame.sessionId ?? ""));
      if (child) ctx.stitched.add(child.frameId);
      const children2 = child ? buildFrame(child, yOf(own) ?? offsetY, ctx) : [];
      return [{ ...base(ax), kind: "element", role: "Iframe", name: cleanText(nameOf(ax)), states: [], children: children2, interactive: false, y: yOf(own) }];
    }
    if (consumedLabels.has(ax.backendDOMNodeId ?? -1)) return [];
    const label = own ? labelFor.get(own.backendNodeId) : void 0;
    if (own && !own.rendered && !label) return [];
    const name = cleanText(nameOf(ax));
    const interactiveRole = INTERACTIVE_ROLES.has(role);
    const children = kids(insideInteractive || interactiveRole);
    if (!own && children.length === 0 && !interactiveRole) return [];
    const becomesClickable = !interactiveRole && !insideInteractive && Boolean(own?.clickable) && role !== "RootWebArea" && !["html", "body"].includes(own?.tag ?? "") && !hasInteractive(children);
    if (becomesClickable) {
      const full = name || textOf(children);
      const short = full.length > CLICKABLE_NAME_MAX ? `${full.slice(0, CLICKABLE_NAME_MAX - 1).trimEnd()}\u2026` : full;
      return [{ ...base(ax), kind: "element", role: "clickable", name: short, states: [], children: tidy(children, short), interactive: true, y: yOf(own) }];
    }
    const node = { ...base(ax), kind: "element", role, name, states: states(ax), children, interactive: interactiveRole, y: yOf(own) };
    if (role === "link" && own?.attrs.href) node.href = own.attrs.href;
    if (role === "heading") node.level = Number(property(ax, "level")) || 2;
    if (label) {
      node.backendNodeId = label.backendNodeId;
      node.proxy = "label";
      node.y = yOf(label);
    }
    if (VALUE_ROLES.has(role)) {
      node.children = [];
      const value = valueOf(ax);
      if (TEXT_FIELDS.has(role) && (!own || isSecretField(own.attrs))) {
        node.masked = true;
        node.value = value ? MASK : void 0;
      } else if (value !== void 0) {
        node.value = value;
      }
      return [node];
    }
    if (TRANSPARENT.has(role) && !name) return tidy(children, "");
    node.children = tidy(children, name);
    return [node];
  }
  const root = frame.nodes.find((n) => roleOf(n) === "RootWebArea" && !n.parentId) ?? frame.nodes[0];
  if (!root) return [];
  const rootChildren = (root.childIds ?? []).flatMap((id) => {
    const child = byId.get(id);
    return child ? convert(child, false) : [];
  });
  return tidy(rootChildren, cleanText(nameOf(root)));
}
function buildOutline(capture2) {
  const layouts = new Map(Object.entries(capture2.layout ?? {}).map(([key, raw]) => [key, decodeSnapshot(raw)]));
  const ctx = { capture: capture2, layouts, notices: [], stitched: /* @__PURE__ */ new Set() };
  if (capture2.layoutError) ctx.notices.push(`\u0413\u0435\u043E\u043C\u0435\u0442\u0440\u0438\u044F \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u044B \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430 (${capture2.layoutError}): \u0432\u0438\u0434\u0438\u043C\u043E\u0441\u0442\u044C \u044D\u043B\u0435\u043C\u0435\u043D\u0442\u043E\u0432 \u043D\u0435 \u043F\u0440\u043E\u0432\u0435\u0440\u0435\u043D\u0430.`);
  const main = capture2.frames.find((f) => !f.parentFrameId) ?? capture2.frames[0];
  if (!main) return { roots: [], notices: ["\u0421\u0442\u0440\u0430\u043D\u0438\u0446\u0430 \u043D\u0435 \u0441\u043D\u044F\u0442\u0430."] };
  const roots = buildFrame(main, 0, ctx);
  for (const frame of capture2.frames) {
    if (frame === main || ctx.stitched.has(frame.frameId)) continue;
    const children = buildFrame(frame, 0, ctx);
    if (children.length) roots.push({ kind: "element", role: "Iframe", name: frame.url, states: [], children, interactive: false, frameId: frame.frameId, sessionId: frame.sessionId, loaderId: frame.loaderId });
  }
  return { roots, notices: ctx.notices };
}

// src/page/render.ts
var VALUE_MAX = 200;
var KEEP_IN_INTERACTIVE = /* @__PURE__ */ new Set(["heading", "Iframe", "dialog", "alertdialog"]);
function quote(text, max = Infinity) {
  const cut = text.length > max ? `${text.slice(0, max)}\u2026` : text;
  return `"${cut.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}
function renderLine(n) {
  if (n.kind === "text") return `text ${quote(n.name)}`;
  let line = n.ref ? `[${n.ref}] ${n.role}` : n.role;
  if (n.name) line += ` ${quote(n.name)}`;
  if (n.states.length) line += ` (${n.states.join(", ")})`;
  if (n.masked) line += n.value ? ` = ${quote(n.value)} (\u0441\u043A\u0440\u044B\u0442\u043E)` : " (\u0441\u043A\u0440\u044B\u0442\u043E)";
  else if (n.value !== void 0) line += ` = ${quote(n.value, VALUE_MAX)}`;
  return line;
}
function header(capture2) {
  const { scrollY, height, pageHeight } = capture2.viewport;
  return `${capture2.title} \xB7 ${capture2.url} \xB7 \u0432\u0438\u0434\u043D\u043E ${scrollY}\u2013${scrollY + height} \u0438\u0437 ${pageHeight} px`;
}
function flatten(roots, mode) {
  const rows = [];
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      const keep = mode === "all" || n.interactive || KEEP_IN_INTERACTIVE.has(n.role);
      if (keep) rows.push({ node: n, depth });
      walk(n.children, keep ? depth + 1 : depth);
    }
  };
  walk(roots, 0);
  return rows;
}
function render(roots, refs, opts) {
  const { scrollY, height } = opts.viewport;
  const notices = [];
  let rows = flatten(roots, opts.mode);
  if (opts.window === "near") {
    const start = scrollY - height, end = scrollY + 2 * height;
    let above = 0, below = 0;
    rows = rows.filter(({ node }) => {
      if (node.y === void 0 || node.y >= start && node.y <= end) return true;
      if (node.y < start) above++;
      else below++;
      return false;
    });
    if (above) notices.push(`\u0412\u044B\u0448\u0435 \u0435\u0449\u0451 ${above} \u044D\u043B\u0435\u043C\u0435\u043D\u0442\u043E\u0432: \u043F\u0440\u043E\u043A\u0440\u0443\u0442\u0438\u0442\u0435 \u0432\u0432\u0435\u0440\u0445 \u0438\u043B\u0438 \u0432\u044B\u0437\u043E\u0432\u0438\u0442\u0435 snapshot \u0441 window="all".`);
    if (below) notices.push(`\u041D\u0438\u0436\u0435 \u0435\u0449\u0451 ${below} \u044D\u043B\u0435\u043C\u0435\u043D\u0442\u043E\u0432: \u043F\u0440\u043E\u043A\u0440\u0443\u0442\u0438\u0442\u0435 \u0432\u043D\u0438\u0437 \u0438\u043B\u0438 \u0432\u044B\u0437\u043E\u0432\u0438\u0442\u0435 snapshot \u0441 window="all".`);
  }
  const distance = (n) => n.y === void 0 ? 0 : n.y < scrollY ? scrollY - n.y : Math.max(0, n.y - (scrollY + height));
  const lengthOf = ({ node, depth }) => depth * 2 + renderLine({ ...node, ref: node.interactive ? `${refs.epoch}0000` : void 0 }).length + 1;
  let total = rows.reduce((sum, row) => sum + lengthOf(row), 0);
  if (total > opts.budget) {
    const all2 = rows.length;
    const byDistance = [...rows].sort((a, b) => distance(b.node) - distance(a.node) || (b.node.y ?? 0) - (a.node.y ?? 0));
    const dropped = /* @__PURE__ */ new Set();
    for (const row of byDistance) {
      if (total <= opts.budget) break;
      dropped.add(row);
      total -= lengthOf(row);
    }
    rows = rows.filter((row) => !dropped.has(row));
    notices.push(`\u041E\u043F\u0438\u0441\u0430\u043D\u0438\u0435 \u0443\u0440\u0435\u0437\u0430\u043D\u043E \u0434\u043E \u0431\u044E\u0434\u0436\u0435\u0442\u0430: \u043F\u043E\u043A\u0430\u0437\u0430\u043D\u043E ${rows.length} \u0438\u0437 ${all2} \u0441\u0442\u0440\u043E\u043A. \u0423\u0442\u043E\u0447\u043D\u0438\u0442\u0435 \u0437\u0430\u043F\u0440\u043E\u0441 \u0447\u0435\u0440\u0435\u0437 find \u0438\u043B\u0438 read.`);
  }
  const shown = [];
  const lines = rows.map(({ node, depth }) => {
    if (node.interactive && node.backendNodeId !== void 0) shown.push(refs.assign(node));
    return `${"  ".repeat(depth)}${renderLine(node)}`;
  });
  return { body: lines.join("\n"), notices, shown };
}

// src/page/probe.ts
var WORLD = "assistant";
var OVERLAY_ATTR2 = "data-assistant-overlay";
var PROBE_SOURCE = `(() => {
  if (globalThis.__assistant) return;
  const OVERLAY = '[${OVERLAY_ATTR2}]';
  const state = {mutations: 0};
  const inOverlay = node => { const el = node && (node.nodeType === 1 ? node : node.parentElement); return Boolean(el && el.closest && el.closest(OVERLAY)); };
  const observe = () => new MutationObserver(records => {
    for (const r of records) if (!inOverlay(r.target)) state.mutations++;
  }).observe(document, {subtree: true, childList: true, attributes: true, characterData: true});
  if (document.documentElement) observe(); else document.addEventListener('DOMContentLoaded', observe, {once: true});
  const fold = s => s.toLowerCase().replace(/\u0451/g, '\u0435');
  const highlights = new Map();
  let layer = null;
  const ensureLayer = () => {
    if (layer && layer.host.isConnected) return layer;
    const host = document.createElement('div');
    host.setAttribute('${OVERLAY_ATTR2}', '');
    for (const [k, v] of [['position', 'fixed'], ['inset', '0'], ['pointer-events', 'none'], ['z-index', '2147483647'], ['display', 'block']]) host.style.setProperty(k, v, 'important');
    const root = host.attachShadow({mode: 'closed'});
    document.documentElement.append(host);
    layer = {host, root, boxes: []};
    const place = () => { for (const {el, box, color} of layer.boxes) { const r = el.getBoundingClientRect();
      box.style.cssText = 'position:fixed;box-sizing:content-box;border-radius:4px;pointer-events:none;border:3px solid ' + color
        + ';left:' + (r.left - 3) + 'px;top:' + (r.top - 3) + 'px;width:' + r.width + 'px;height:' + r.height + 'px;display:' + (el.isConnected ? 'block' : 'none'); } };
    layer.place = place;
    let queued = false;
    const later = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; place(); }); } };
    addEventListener('scroll', later, {capture: true, passive: true});
    addEventListener('resize', later, {passive: true});
    return layer;
  };
  globalThis.__assistant = {
    highlightText(query, name) {
      const want = fold(query); if (!want) return 0;
      const ranges = [];
      const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
      for (let node; (node = walker.nextNode());) {
        const parent = node.parentElement;
        if (!parent || inOverlay(node) || !parent.getClientRects().length || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(parent.tagName)) continue;
        const text = fold(node.data);
        for (let i = text.indexOf(want); i >= 0; i = text.indexOf(want, i + want.length)) {
          const r = new Range(); r.setStart(node, i); r.setEnd(node, i + want.length); ranges.push(r);
        }
      }
      if (!ranges.length) return 0;
      const h = highlights.get(name) || new Highlight();
      for (const r of ranges) h.add(r);
      highlights.set(name, h);
      CSS.highlights.set(name, h);
      return ranges.length;
    },
    highlightElement(el, color) {
      const l = ensureLayer();
      const box = document.createElement('div');
      l.root.append(box);
      l.boxes.push({el, box, color});
      l.place();
      return 1;
    },
    clearHighlights() {
      for (const name of highlights.keys()) CSS.highlights.delete(name);
      highlights.clear();
      if (layer) { layer.host.remove(); layer = null; }
    },
    state,
    readyState: () => document.readyState,
    mutations: () => state.mutations,
    focusInfo: () => { let el = document.activeElement; while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement; return el; },
    elementState(el) {
      const style = getComputedStyle(el);
      const disabled = Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true' || Boolean(el.closest && el.closest('fieldset[disabled]'));
      const editable = el.isContentEditable || (el.tagName === 'TEXTAREA') || (el.tagName === 'INPUT' && !['checkbox','radio','button','submit','reset','image','file','range','color','hidden'].includes((el.type || '').toLowerCase()));
      return {disabled, readonly: Boolean(el.readOnly) || el.getAttribute('aria-readonly') === 'true', editable,
        visible: style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0',
        checked: 'checked' in el ? el.checked : el.getAttribute('aria-checked') === 'true', tag: el.tagName.toLowerCase(), type: (el.type || '').toLowerCase()};
    },
  };
})()`;
async function ensureProbe(session, frameId, cache) {
  const frame = session.frames.get(frameId);
  if (!frame) throw new Error(`\u0424\u0440\u0435\u0439\u043C ${frameId} \u0438\u0441\u0447\u0435\u0437`);
  const cached = cache.get(frameId);
  if (cached && cached.loaderId === frame.loaderId) return cached.contextId;
  const { executionContextId } = await session.cdp.send("Page.createIsolatedWorld", { frameId, worldName: WORLD, grantUniveralAccess: false }, frame.sessionId);
  await session.cdp.send("Runtime.evaluate", { expression: PROBE_SOURCE, contextId: executionContextId }, frame.sessionId);
  cache.set(frameId, { loaderId: frame.loaderId, contextId: executionContextId });
  return executionContextId;
}
async function probeEval(session, frameId, cache, expression) {
  const contextId = await ensureProbe(session, frameId, cache);
  const frame = session.frames.get(frameId);
  const result = await session.cdp.send(
    "Runtime.evaluate",
    { expression, contextId, returnByValue: true, awaitPromise: true },
    frame?.sessionId
  );
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

// src/page/readiness.ts
var NETWORK_QUIET_MS = 500;
var FRESH_TRACKER_MS = 1500;
var FRESH_QUIET_MS = 1e3;
var DOM_QUIET_MS = 300;
var POLL_MS = 100;
var LONG_POLL_MS = 3e3;
var NetworkTracker = class {
  #pending = /* @__PURE__ */ new Map();
  #lastChange = Date.now();
  createdAt = Date.now();
  #off;
  constructor(session) {
    this.#off = session.cdp.on((method, params, sessionId) => {
      const key = `${sessionId ?? ""}|${params.requestId}`;
      if (method === "Network.requestWillBeSent") {
        if (params.type === "EventSource" || params.type === "WebSocket") return;
        this.#pending.set(key, Date.now());
        this.#lastChange = Date.now();
      } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
        if (this.#pending.delete(key)) this.#lastChange = Date.now();
      }
    });
  }
  /** Requests in flight that look like loading (not long-polling). */
  inflight() {
    const now = Date.now();
    let count = 0;
    for (const started of this.#pending.values()) if (now - started < LONG_POLL_MS) count++;
    return count;
  }
  /** How long no request has been in flight, in ms; 0 while one is. */
  quietFor() {
    return this.inflight() ? 0 : Date.now() - this.#lastChange;
  }
  stop() {
    this.#off();
  }
};
async function waitForReady(session, network, probes, capMs = 5e3) {
  const started = Date.now();
  let lastMutations = -1, mutationsStableSince = Date.now();
  for (; ; ) {
    const main = session.frames.main();
    let readyState = "loading", mutations = 0;
    try {
      [readyState, mutations] = await probeEval(session, main.frameId, probes, "[__assistant.readyState(), __assistant.mutations()]");
    } catch (error) {
      const code = error?.code;
      if (code === "DIALOG_OPEN" || code === "DETACHED") throw error;
    }
    if (mutations !== lastMutations) {
      lastMutations = mutations;
      mutationsStableSince = Date.now();
    }
    const waited = Date.now() - started;
    const domQuiet = Date.now() - mutationsStableSince >= DOM_QUIET_MS;
    const needQuiet = Date.now() - network.createdAt < FRESH_TRACKER_MS ? FRESH_QUIET_MS : NETWORK_QUIET_MS;
    if (readyState !== "loading" && network.quietFor() >= needQuiet && domQuiet) return { ready: true, waitedMs: waited };
    if (waited >= capMs) {
      const reason = readyState === "loading" ? "\u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0430 \u0435\u0449\u0451 \u0437\u0430\u0433\u0440\u0443\u0436\u0430\u0435\u0442\u0441\u044F" : network.inflight() ? `\u0438\u0434\u0443\u0442 \u0437\u0430\u043F\u0440\u043E\u0441\u044B (${network.inflight()})` : "\u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0430 \u043F\u0440\u043E\u0434\u043E\u043B\u0436\u0430\u0435\u0442 \u043C\u0435\u043D\u044F\u0442\u044C\u0441\u044F";
      return { ready: false, waitedMs: waited, reason };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

// src/page/observe.ts
var FIND_MAX = 30;
var fold = (s) => s.toLocaleLowerCase("ru").replaceAll("\u0451", "\u0435");
var all = (nodes) => nodes.flatMap((n) => [n, ...all(n.children)]);
var Observer = class {
  session;
  refs;
  network;
  probes = /* @__PURE__ */ new Map();
  #last = null;
  constructor(session, refs) {
    this.session = session;
    this.refs = refs;
    this.network = new NetworkTracker(session);
  }
  last() {
    return this.#last;
  }
  /** A fresh capture after waiting for the page to settle; a page that does not settle is captured as it is. */
  async observe() {
    const ready = await waitForReady(this.session, this.network, this.probes);
    const raw = await capture(this.session);
    const { roots, notices } = buildOutline(raw);
    if (!ready.ready) notices.unshift(`\u0421\u0442\u0440\u0430\u043D\u0438\u0446\u0430 \u043D\u0435 \u0443\u0441\u043F\u043E\u043A\u043E\u0438\u043B\u0430\u0441\u044C \u0437\u0430 ${Math.round(ready.waitedMs / 1e3)} \u0441 (${ready.reason}): \u043E\u043F\u0438\u0441\u0430\u043D\u0438\u0435 \u043C\u043E\u0436\u0435\u0442 \u0431\u044B\u0442\u044C \u043D\u0435\u043F\u043E\u043B\u043D\u044B\u043C.`);
    return { capture: raw, roots, notices };
  }
  /** A capture without waiting for the page to settle, for polling. */
  async quick() {
    const raw = await capture(this.session);
    return { capture: raw, roots: buildOutline(raw).roots };
  }
  async snapshot(opts) {
    const { capture: raw, roots, notices } = await this.observe();
    const rendered = render(roots, this.refs, { mode: opts.mode ?? "interactive", window: opts.window ?? "near", budget: opts.budget, viewport: raw.viewport });
    this.#last = { header: header(raw), body: rendered.body, notices: [...notices, ...rendered.notices], refs: rendered.shown, roots, capture: raw };
    return this.#last;
  }
  async find(q, budget) {
    if (!q.role && !q.name && !q.text) throw new PageError("NOT_FOUND", "\u0423\u043A\u0430\u0436\u0438\u0442\u0435 \u0445\u043E\u0442\u044F \u0431\u044B \u043E\u0434\u043D\u043E \u0438\u0437: role, name, text.");
    const { capture: raw, roots, notices } = await this.observe();
    const name = q.name ? fold(q.name) : null, text = q.text ? fold(q.text) : null;
    const matches = all(roots).filter((n) => (!q.role || n.role === q.role) && (!name || fold(n.name).includes(name)) && (!text || fold(n.kind === "text" ? n.name : `${n.name} ${n.value ?? ""}`).includes(text)));
    if (!matches.length) throw new PageError("NOT_FOUND", "\u041D\u0438\u0447\u0435\u0433\u043E \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D\u043E. \u041F\u043E\u043F\u0440\u043E\u0431\u0443\u0439\u0442\u0435 \u0434\u0440\u0443\u0433\u043E\u0439 \u0437\u0430\u043F\u0440\u043E\u0441 \u0438\u043B\u0438 snapshot.");
    const lines = [];
    let length = 0;
    for (const n of matches.slice(0, FIND_MAX)) {
      if (n.interactive && n.backendNodeId !== void 0) this.refs.assign(n);
      const line = renderLine(n);
      if (length + line.length > budget) break;
      lines.push(line);
      length += line.length + 1;
    }
    if (matches.length > lines.length) notices.push(`\u041F\u043E\u043A\u0430\u0437\u0430\u043D\u043E ${lines.length} \u0438\u0437 ${matches.length} \u0441\u043E\u0432\u043F\u0430\u0434\u0435\u043D\u0438\u0439.`);
    return { header: header(raw), body: lines.join("\n"), notices };
  }
  async read(opts) {
    const { capture: raw, roots, notices } = await this.observe();
    let scope = roots;
    if (opts.ref) {
      const record = this.refs.get(opts.ref);
      const node = all(roots).find((n) => n.backendNodeId === record.backendNodeId && n.loaderId === record.loaderId);
      if (!node) throw new PageError("REF_STALE", `\u042D\u043B\u0435\u043C\u0435\u043D\u0442 ${opts.ref} \u0431\u043E\u043B\u044C\u0448\u0435 \u043D\u0435 \u043D\u0430 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0435: \u0441\u0434\u0435\u043B\u0430\u0439\u0442\u0435 snapshot.`);
      scope = [node];
    }
    let body = toMarkdown(scope);
    if (body.length > opts.budget) {
      body = body.slice(0, opts.budget);
      notices.push(`\u0422\u0435\u043A\u0441\u0442 \u0443\u0440\u0435\u0437\u0430\u043D \u0434\u043E ${opts.budget} \u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432: \u043F\u0440\u043E\u0447\u0438\u0442\u0430\u0439\u0442\u0435 \u043D\u0443\u0436\u043D\u0443\u044E \u0447\u0430\u0441\u0442\u044C \u0447\u0435\u0440\u0435\u0437 read \u0441 ref.`);
    }
    return { header: header(raw), body, notices };
  }
};
var inline = (nodes) => nodes.map((n) => n.kind === "text" ? n.name : n.role === "link" ? link(n) : n.name || inline(n.children)).join(" ").replace(/\s+/g, " ").trim();
var link = (n) => `[${n.name || inline(n.children)}](${n.href ?? ""})`;
function toMarkdown(nodes) {
  const out = [];
  const walk = (list) => {
    for (const n of list) {
      if (n.kind === "text") out.push(n.name);
      else if (n.role === "heading") out.push(`${"#".repeat(Math.min(6, n.level ?? 2))} ${n.name || inline(n.children)}`);
      else if (n.role === "link") out.push(link(n));
      else if (n.role === "listitem") out.push(`- ${inline(n.children) || n.name}`);
      else if (n.role === "image" || n.role === "img") out.push(`[\u0438\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u0435: ${n.name}]`);
      else if (n.role === "clickable") out.push(`[clickable] ${inline(n.children) || n.name}`);
      else if (n.interactive) out.push(`[${n.role} "${n.name}"${n.masked ? ` = "${MASK}"` : n.value !== void 0 ? ` = "${n.value}"` : ""}]`);
      else walk(n.children);
    }
  };
  walk(nodes);
  return out.join("\n\n").trim();
}

// src/page/refs.ts
var RefRegistry = class {
  epoch;
  #counter = 0;
  #byRef = /* @__PURE__ */ new Map();
  #byKey = /* @__PURE__ */ new Map();
  constructor(epoch) {
    this.epoch = epoch;
  }
  /** The node's label: the existing one for this node in this document, else a new one. Sets `node.ref`. */
  assign(node) {
    const key = `${node.sessionId ?? ""}|${node.loaderId}|${node.backendNodeId}`;
    let record = this.#byKey.get(key);
    if (!record || record.stale) {
      record = {
        ref: `${this.epoch}${++this.#counter}`,
        frameId: node.frameId,
        sessionId: node.sessionId,
        backendNodeId: node.backendNodeId ?? -1,
        loaderId: node.loaderId,
        role: node.role,
        name: node.name,
        proxy: node.proxy
      };
      this.#byKey.set(key, record);
      this.#byRef.set(record.ref, record);
    } else {
      record.role = node.role;
      record.name = node.name;
    }
    node.ref = record.ref;
    return record.ref;
  }
  get(ref) {
    const record = this.#byRef.get(ref.trim().replace(/^\[|\]$/g, ""));
    if (!record) throw new PageError("REF_UNKNOWN", `\u041C\u0435\u0442\u043A\u0430 ${ref} \u043D\u0435 \u0438\u0437 \u044D\u0442\u043E\u0433\u043E \u0441\u043D\u0438\u043C\u043A\u0430: \u0441\u0434\u0435\u043B\u0430\u0439\u0442\u0435 snapshot \u0438 \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0439\u0442\u0435 \u043C\u0435\u0442\u043A\u0438 \u0438\u0437 \u043D\u0435\u0433\u043E.`);
    if (record.stale) throw new PageError("REF_STALE", `\u041C\u0435\u0442\u043A\u0430 ${ref} \u0443\u0441\u0442\u0430\u0440\u0435\u043B\u0430: \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0430 \u0438\u043B\u0438 \u0444\u0440\u0435\u0439\u043C \u043F\u0435\u0440\u0435\u0437\u0430\u0433\u0440\u0443\u0437\u0438\u043B\u0438\u0441\u044C. \u0421\u0434\u0435\u043B\u0430\u0439\u0442\u0435 snapshot.`);
    return record;
  }
  /** A frame loaded a new document: every label from its old documents goes stale. */
  invalidateFrame(frameId, loaderId) {
    for (const record of this.#byRef.values()) if (record.frameId === frameId && record.loaderId !== loaderId) record.stale = true;
  }
};

// src/page/resolve.ts
var staleText = (ref, why) => `\u042D\u043B\u0435\u043C\u0435\u043D\u0442 ${ref} ${why}: \u0441\u0434\u0435\u043B\u0430\u0439\u0442\u0435 snapshot \u0438 \u0432\u043E\u0437\u044C\u043C\u0438\u0442\u0435 \u043D\u043E\u0432\u0443\u044E \u043C\u0435\u0442\u043A\u0443.`;
async function callOn(session, frame, objectId, fn, args = []) {
  const r = await session.cdp.send(
    "Runtime.callFunctionOn",
    { objectId, functionDeclaration: fn, arguments: args, returnByValue: true, awaitPromise: true },
    frame.sessionId
  );
  if (r.exceptionDetails) throw new PageError("INTERNAL", r.exceptionDetails.text);
  return r.result.value;
}
async function resolveNode(session, frame, backendNodeId, probes) {
  const executionContextId = await ensureProbe(session, frame.frameId, probes);
  try {
    const { object } = await session.cdp.send("DOM.resolveNode", { backendNodeId, executionContextId }, frame.sessionId);
    return object.objectId;
  } catch {
    return null;
  }
}
async function resolveTarget(session, refs, ref, probes) {
  const record = refs.get(ref);
  const frame = session.frames.get(record.frameId);
  if (!frame || frame.loaderId !== record.loaderId) {
    refs.invalidateFrame(record.frameId, frame?.loaderId ?? "");
    throw new PageError("REF_STALE", staleText(ref, "\u0431\u044B\u043B \u043D\u0430 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0435, \u043A\u043E\u0442\u043E\u0440\u0430\u044F \u0443\u0436\u0435 \u0441\u043C\u0435\u043D\u0438\u043B\u0430\u0441\u044C"));
  }
  const objectId = await resolveNode(session, frame, record.backendNodeId, probes);
  if (!objectId) throw new PageError("REF_STALE", staleText(ref, "\u0438\u0441\u0447\u0435\u0437 \u0441\u043E \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u044B"));
  const connected = await callOn(session, frame, objectId, "function () { return this.isConnected; }");
  if (!connected) throw new PageError("REF_STALE", staleText(ref, "\u0438\u0441\u0447\u0435\u0437 \u0441\u043E \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u044B (\u0435\u0451 \u043F\u0435\u0440\u0435\u0440\u0438\u0441\u043E\u0432\u0430\u043B\u0438)"));
  if (!record.proxy && record.role !== "clickable") {
    const { nodes } = await session.cdp.send(
      "Accessibility.getPartialAXTree",
      { backendNodeId: record.backendNodeId, fetchRelatives: false },
      frame.sessionId
    );
    const role = nodes[0]?.role?.value ?? "", name = cleanText(String(nodes[0]?.name?.value ?? ""));
    if (role !== record.role || name !== record.name) {
      throw new PageError("REF_STALE", staleText(ref, `\u0438\u0437\u043C\u0435\u043D\u0438\u043B\u0441\u044F (\u0431\u044B\u043B ${record.role} "${record.name}", \u0441\u0442\u0430\u043B ${role} "${name}")`));
    }
  }
  return { record, frame, objectId };
}

// src/page/geometry.ts
function quadArea(q) {
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    area += q[i * 2] * q[j * 2 + 1] - q[j * 2] * q[i * 2 + 1];
  }
  return Math.abs(area / 2);
}
function visibleCenter(q, viewport) {
  const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
  const left = Math.max(0, Math.min(...xs)), right = Math.min(viewport.width, Math.max(...xs));
  const top = Math.max(0, Math.min(...ys)), bottom = Math.min(viewport.height, Math.max(...ys));
  if (right <= left || bottom <= top) return null;
  return { x: (left + right) / 2, y: (top + bottom) / 2 };
}
function toParent(p, ownerContent, childViewport) {
  const fx = p.x / Math.max(1, childViewport.width), fy = p.y / Math.max(1, childViewport.height);
  const c = ownerContent;
  return { x: c[0] + (c[2] - c[0]) * fx + (c[6] - c[0]) * fy, y: c[1] + (c[3] - c[1]) * fx + (c[7] - c[1]) * fy };
}

// src/page/actionability.ts
var ACTIONABILITY_BUDGET_MS = 5e3;
var SCHEDULE = [0, 20, 100, 100, 500];
var STABLE_GAP_MS = 50;
var STABLE_TOLERANCE_PX = 2;
var TERMINAL = /* @__PURE__ */ new Set(["REF_STALE", "NOT_EDITABLE", "DETACHED", "PAGE_NOT_SUPPORTED", "REF_UNKNOWN"]);
var sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function scrollOffset(session, sessionId) {
  const m = await session.cdp.send("Page.getLayoutMetrics", {}, sessionId);
  return { x: m.cssLayoutViewport.pageX, y: m.cssLayoutViewport.pageY };
}
async function firstQuad(session, frame, backendNodeId) {
  try {
    const { quads } = await session.cdp.send("DOM.getContentQuads", { backendNodeId }, frame.sessionId);
    return quads.find((q) => quadArea(q) > 1) ?? null;
  } catch {
    return null;
  }
}
function sessionChain(session, frame) {
  const chain = [];
  let root = session.frames.sessionRoot(frame.frameId);
  for (; ; ) {
    const parent = root.parentFrameId ? session.frames.get(root.parentFrameId) : void 0;
    chain.push({ root, parent });
    if (!parent) return chain;
    root = session.frames.sessionRoot(parent.frameId);
  }
}
async function describe(session, frame, objectId) {
  return callOn(session, frame, objectId, `function () {
    let el = this.nodeType === 1 ? this : this.parentElement;
    for (let n = el; n; n = n.parentElement) { const t = (n.getAttribute('aria-label') || n.innerText || '').trim(); if (t) return t.replace(/\\s+/g, ' ').slice(0, 80); }
    return el ? el.tagName.toLowerCase() : '\u043D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u044B\u0439 \u044D\u043B\u0435\u043C\u0435\u043D\u0442';
  }`).catch(() => "\u0434\u0440\u0443\u0433\u043E\u0439 \u044D\u043B\u0435\u043C\u0435\u043D\u0442");
}
async function hitTest(session, target, local, probes) {
  const chain = sessionChain(session, target.frame);
  let point = local;
  for (let level = 0; level < chain.length; level++) {
    const { root, parent } = chain[level];
    const offset = await scrollOffset(session, root.sessionId);
    const hit = await session.cdp.send(
      "DOM.getNodeForLocation",
      { x: Math.round(point.x + offset.x), y: Math.round(point.y + offset.y), includeUserAgentShadowDOM: true, ignorePointerEventsNone: false },
      root.sessionId
    ).catch(() => null);
    if (!hit) throw new PageError("NOT_VISIBLE", `\u042D\u043B\u0435\u043C\u0435\u043D\u0442 ${target.record.ref} \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D \u0432 \u0442\u043E\u0447\u043A\u0435 \u043A\u043B\u0438\u043A\u0430.`);
    const hitFrame = session.frames.get(hit.frameId) ?? root;
    let expectedObject = target.objectId, expectedFrame = target.frame;
    if (level > 0) {
      const child = chain[level - 1].root;
      const owner = await session.cdp.send("DOM.getFrameOwner", { frameId: child.frameId }, root.sessionId);
      const ownerFrame = session.frames.get(child.parentFrameId) ?? root;
      const ownerObject = await resolveNode(session, ownerFrame, owner.backendNodeId, probes);
      if (!ownerObject) throw new PageError("NOT_VISIBLE", "\u0424\u0440\u0435\u0439\u043C \u0441 \u044D\u043B\u0435\u043C\u0435\u043D\u0442\u043E\u043C \u0438\u0441\u0447\u0435\u0437.");
      expectedObject = ownerObject;
      expectedFrame = ownerFrame;
    }
    const hitObject = hitFrame.frameId === expectedFrame.frameId ? await resolveNode(session, hitFrame, hit.backendNodeId, probes) : null;
    const inside = hitObject ? await callOn(
      session,
      expectedFrame,
      expectedObject,
      "function (other) { for (let n = other; n; n = n.parentNode || n.host) if (n === this) return true; return false; }",
      [{ objectId: hitObject }]
    ) : false;
    if (!inside) {
      const blockerObject = hitObject ?? await resolveNode(session, hitFrame, hit.backendNodeId, probes);
      const blocker = blockerObject ? await describe(session, hitFrame, blockerObject) : "\u0434\u0440\u0443\u0433\u043E\u0439 \u044D\u043B\u0435\u043C\u0435\u043D\u0442";
      throw new PageError("COVERED", `\u042D\u043B\u0435\u043C\u0435\u043D\u0442 ${target.record.ref} \u0437\u0430\u043A\u0440\u044B\u0442 \u0434\u0440\u0443\u0433\u0438\u043C \u044D\u043B\u0435\u043C\u0435\u043D\u0442\u043E\u043C: \xAB${blocker}\xBB. \u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u0437\u0430\u043A\u0440\u043E\u0439\u0442\u0435 \u0438\u043B\u0438 \u0443\u0431\u0435\u0440\u0438\u0442\u0435 \u0435\u0433\u043E.`);
    }
    if (!parent) return point;
    const { model } = await session.cdp.send(
      "DOM.getBoxModel",
      { backendNodeId: (await session.cdp.send("DOM.getFrameOwner", { frameId: root.frameId }, parent.sessionId)).backendNodeId },
      parent.sessionId
    );
    const [width, height] = await probeEval(session, root.frameId, probes, "[innerWidth, innerHeight]");
    point = toParent(point, model.content, { width, height });
  }
  return point;
}
async function toTop(session, frame, quad, probes) {
  let q = quad;
  for (const { root, parent } of sessionChain(session, frame)) {
    if (!parent) return q;
    const owner = await session.cdp.send("DOM.getFrameOwner", { frameId: root.frameId }, parent.sessionId);
    const { model } = await session.cdp.send("DOM.getBoxModel", { backendNodeId: owner.backendNodeId }, parent.sessionId);
    const [width, height] = await probeEval(session, root.frameId, probes, "[innerWidth, innerHeight]");
    const points = [0, 1, 2, 3].map((i) => toParent({ x: q[i * 2], y: q[i * 2 + 1] }, model.content, { width, height }));
    q = points.flatMap((p) => [p.x, p.y]);
  }
  return q;
}
async function checkOnce(session, target, needs, probes) {
  const { frame, objectId, record } = target;
  const connected = await callOn(session, frame, objectId, "function () { return this.isConnected; }");
  if (!connected) throw new PageError("REF_STALE", `\u042D\u043B\u0435\u043C\u0435\u043D\u0442 ${record.ref} \u0438\u0441\u0447\u0435\u0437 \u0441\u043E \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u044B: \u0441\u0434\u0435\u043B\u0430\u0439\u0442\u0435 snapshot.`);
  const state = await callOn(session, frame, objectId, "function () { return __assistant.elementState(this.nodeType === 1 ? this : this.parentElement); }");
  if (!state.visible) throw new PageError("NOT_VISIBLE", `\u042D\u043B\u0435\u043C\u0435\u043D\u0442 ${record.ref} \u0441\u043A\u0440\u044B\u0442.`);
  if (state.disabled) throw new PageError("NOT_ENABLED", `\u042D\u043B\u0435\u043C\u0435\u043D\u0442 ${record.ref} \u043D\u0435\u0430\u043A\u0442\u0438\u0432\u0435\u043D (disabled).`);
  if (needs.editable && (!state.editable || state.readonly)) throw new PageError("NOT_EDITABLE", `\u0412 \u044D\u043B\u0435\u043C\u0435\u043D\u0442 ${record.ref} \u043D\u0435\u043B\u044C\u0437\u044F \u0432\u0432\u043E\u0434\u0438\u0442\u044C \u0442\u0435\u043A\u0441\u0442.`);
  await session.cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: record.backendNodeId }, frame.sessionId).catch(() => {
  });
  const first = await firstQuad(session, frame, record.backendNodeId);
  if (!first) throw new PageError("NOT_VISIBLE", `\u0423 \u044D\u043B\u0435\u043C\u0435\u043D\u0442\u0430 ${record.ref} \u043D\u0435\u0442 \u0432\u0438\u0434\u0438\u043C\u043E\u0439 \u043E\u0431\u043B\u0430\u0441\u0442\u0438.`);
  await sleep(STABLE_GAP_MS);
  const second = await firstQuad(session, frame, record.backendNodeId);
  if (!second || first.some((v, i) => Math.abs(v - second[i]) > STABLE_TOLERANCE_PX)) {
    throw new PageError("NOT_STABLE", `\u042D\u043B\u0435\u043C\u0435\u043D\u0442 ${record.ref} \u0435\u0449\u0451 \u0434\u0432\u0438\u0433\u0430\u0435\u0442\u0441\u044F.`);
  }
  const root = session.frames.sessionRoot(frame.frameId);
  const [width, height] = await probeEval(session, root.frameId, probes, "[document.documentElement.clientWidth || innerWidth, document.documentElement.clientHeight || innerHeight]");
  const local = visibleCenter(second, { width, height });
  if (!local) throw new PageError("NOT_VISIBLE", `\u042D\u043B\u0435\u043C\u0435\u043D\u0442 ${record.ref} \u0437\u0430 \u043F\u0440\u0435\u0434\u0435\u043B\u0430\u043C\u0438 \u044D\u043A\u0440\u0430\u043D\u0430.`);
  const point = needs.pointer ? await hitTest(session, target, local, probes) : local;
  return { point, quad: await toTop(session, frame, second, probes) };
}
async function waitActionable(session, target, needs, probes) {
  const started = performance.now();
  for (let attempt = 0; ; attempt++) {
    try {
      return await checkOnce(session, target, needs, probes);
    } catch (error) {
      if (!(error instanceof PageError) || TERMINAL.has(error.code)) throw error;
      const wait = SCHEDULE[Math.min(attempt + 1, SCHEDULE.length - 1)];
      if (performance.now() - started + wait > ACTIONABILITY_BUDGET_MS) throw error;
      await sleep(wait);
    }
  }
}

// src/page/evidence.ts
var POLL_MS2 = 100;
var CAP_MS = 1500;
var QUIET_MS = 500;
var NAVIGATION_LOAD_MS = 5e3;
function classifyEvidence(s) {
  if (s.dialog) return "dialog";
  if (s.newTab) return "new_tab";
  if (s.navigated) return "navigated";
  if (s.mutations > 0) return "changed";
  if (s.requests > 0) return "requests";
  return "none";
}
async function startWatch(session, probes, frameIds) {
  const frames = [.../* @__PURE__ */ new Set([session.frames.main().frameId, ...frameIds])];
  const readMutations = async () => {
    let sum = 0;
    for (const id of frames) sum += await probeEval(session, id, probes, "__assistant.mutations()").catch(() => 0);
    return sum;
  };
  const baseMutations = await readMutations();
  const mainId = session.frames.main().frameId;
  let requests = 0, lastSignal = Date.now(), navigated = false, loaded = false, newTabUrl, navUrl;
  let requestedUrl, sameDocumentUrl;
  const pending = /* @__PURE__ */ new Set();
  const off = session.cdp.on((method, params, sessionId) => {
    const key = `${sessionId ?? ""}|${params.requestId}`;
    if (method === "Network.requestWillBeSent" && params.type !== "EventSource") {
      requests++;
      pending.add(key);
      lastSignal = Date.now();
    } else if ((method === "Network.loadingFinished" || method === "Network.loadingFailed") && pending.delete(key)) lastSignal = Date.now();
    else if (method === "Page.windowOpen") {
      newTabUrl = params.url;
      lastSignal = Date.now();
    } else if (!sessionId && method === "Page.frameRequestedNavigation" && params.frameId === mainId) {
      requestedUrl = params.url;
      lastSignal = Date.now();
    } else if (!sessionId && method === "Page.frameNavigated" && !params.frame.parentId) {
      navigated = true;
      navUrl = params.frame.url;
      lastSignal = Date.now();
    } else if (!sessionId && method === "Page.navigatedWithinDocument" && params.frameId === mainId) {
      sameDocumentUrl = params.url;
      lastSignal = Date.now();
    } else if (!sessionId && method === "Page.loadEventFired") loaded = true;
  });
  return {
    stop: off,
    async settle(dialog) {
      const started = Date.now();
      let mutations = 0;
      for (; ; ) {
        await new Promise((r) => setTimeout(r, POLL_MS2));
        const d = dialog();
        if (d) {
          off();
          return { effect: "dialog", dialog: d, requests, mutations };
        }
        if (!navigated) {
          const now = await readMutations();
          if (now - baseMutations !== mutations) {
            mutations = Math.max(0, now - baseMutations);
            lastSignal = Date.now();
          }
        }
        const elapsed = Date.now() - started;
        if (navigated) {
          if (loaded || elapsed > NAVIGATION_LOAD_MS) break;
          continue;
        }
        const waitingForCommit = requestedUrl !== void 0 && elapsed < NAVIGATION_LOAD_MS && pending.size > 0;
        if (!waitingForCommit && (elapsed >= CAP_MS || Date.now() - lastSignal >= QUIET_MS && pending.size === 0)) break;
      }
      off();
      const effect = classifyEvidence({ dialog: false, newTab: Boolean(newTabUrl), navigated, mutations, requests });
      return {
        effect,
        url: effect === "new_tab" ? newTabUrl : effect === "navigated" ? navUrl : void 0,
        requests,
        mutations,
        sameDocument: navigated ? void 0 : sameDocumentUrl,
        notCommitted: navigated || newTabUrl ? void 0 : requestedUrl
      };
    }
  };
}

// src/page/input.ts
function watchDialog(session) {
  let info;
  let resolve;
  const opened = new Promise((r) => {
    resolve = r;
  });
  const off = session.cdp.on((method, params) => {
    if (method === "Page.javascriptDialogOpening" && !info) {
      info = { type: params.type, message: params.message };
      resolve(info);
    }
  });
  return { opened, current: () => info, off };
}
async function sendRaced(session, method, params, dialog) {
  const command = session.cdp.send(method, params).then(() => ({}), (error) => {
    if (error?.code === "DIALOG_OPEN") return dialog.then((d) => ({ dialog: d }));
    throw error;
  });
  return Promise.race([command, dialog.then((d) => ({ dialog: d }))]);
}
async function click(session, point, dialog, count = 1) {
  const base = { x: point.x, y: point.y, button: "left" };
  const moved = await sendRaced(session, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y }, dialog);
  if (moved.dialog) return moved;
  for (let clickCount = 1; clickCount <= count; clickCount++) {
    const pressed = await sendRaced(session, "Input.dispatchMouseEvent", { ...base, type: "mousePressed", clickCount }, dialog);
    if (pressed.dialog) return pressed;
    const released = await sendRaced(session, "Input.dispatchMouseEvent", { ...base, type: "mouseReleased", clickCount }, dialog);
    if (released.dialog) return released;
  }
  return {};
}
function hover(session, point) {
  return session.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
}
function wheel(session, point, deltaY) {
  return session.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX: 0, deltaY });
}
var KEYS = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 }
};
async function pressKey(session, name, dialog) {
  const k = KEYS[name];
  const common = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
  const down = await sendRaced(session, "Input.dispatchKeyEvent", { ...common, type: k.text ? "keyDown" : "rawKeyDown", text: k.text, unmodifiedText: k.text }, dialog);
  if (down.dialog) return down;
  return sendRaced(session, "Input.dispatchKeyEvent", { ...common, type: "keyUp" }, dialog);
}
function insertText(session, text) {
  return session.cdp.send("Input.insertText", { text });
}

// src/page/act.ts
var isFocused = (session, t) => callOn(
  session,
  t.frame,
  t.objectId,
  "function () { const f = __assistant.focusInfo(); return f === this || (f && this.contains(f)); }"
);
async function focusTarget(session, t, point, dialog) {
  await session.cdp.send("DOM.focus", { backendNodeId: t.record.backendNodeId }, t.frame.sessionId).catch(() => {
  });
  if (await isFocused(session, t)) return;
  await click(session, point, dialog);
  if (!await isFocused(session, t)) throw new PageError("NOT_EDITABLE", `\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u043E\u0441\u0442\u0430\u0432\u0438\u0442\u044C \u043A\u0443\u0440\u0441\u043E\u0440 \u0432 \u044D\u043B\u0435\u043C\u0435\u043D\u0442 ${t.record.ref}.`, true);
}
async function typeInto(session, t, text, clear, dialog) {
  if (clear) {
    await callOn(session, t.frame, t.objectId, `function () {
      if (typeof this.select === 'function') { this.select(); return; }
      const r = document.createRange(); r.selectNodeContents(this); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    }`);
    if (!text) await pressKey(session, "Backspace", dialog);
  } else {
    await callOn(session, t.frame, t.objectId, 'function () { if (typeof this.setSelectionRange === "function" && typeof this.value === "string") this.setSelectionRange(this.value.length, this.value.length); }').catch(() => {
    });
  }
  if (text) await insertText(session, text);
  const value = await callOn(session, t.frame, t.objectId, 'function () { return typeof this.value === "string" ? this.value : this.innerText; }');
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const ok = clear ? norm(value) === norm(text) : norm(value).endsWith(norm(text));
  if (!ok) throw new PageError("VALUE_MISMATCH", `\u041F\u043E\u0441\u043B\u0435 \u0432\u0432\u043E\u0434\u0430 \u0432 \u044D\u043B\u0435\u043C\u0435\u043D\u0442\u0435 ${t.record.ref} \u043E\u043A\u0430\u0437\u0430\u043B\u043E\u0441\u044C \u043D\u0435 \u0442\u043E \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435 (\u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0430 \u043C\u043E\u0433\u043B\u0430 \u0438\u0437\u043C\u0435\u043D\u0438\u0442\u044C \u0438\u043B\u0438 \u043E\u0433\u0440\u0430\u043D\u0438\u0447\u0438\u0442\u044C \u0432\u0432\u043E\u0434).`, true);
}
async function selectOption(session, t, value) {
  const r = await callOn(session, t.frame, t.objectId, `function (v) {
    const opts = [...this.options]; const want = String(v).trim().toLowerCase();
    const o = opts.find(o => o.text.trim().toLowerCase() === want) || opts.find(o => o.value.toLowerCase() === want)
      || opts.find(o => o.text.trim().toLowerCase().includes(want));
    if (!o) return {ok: false, options: opts.map(o => o.text.trim())};
    this.value = o.value;
    this.dispatchEvent(new Event('input', {bubbles: true}));
    this.dispatchEvent(new Event('change', {bubbles: true}));
    return {ok: true, text: o.text.trim()};
  }`, [{ value }]);
  if (!r.ok) throw new PageError("NOT_FOUND", `\u0412 \u0441\u043F\u0438\u0441\u043A\u0435 ${t.record.ref} \u043D\u0435\u0442 \u0432\u0430\u0440\u0438\u0430\u043D\u0442\u0430 \xAB${value}\xBB. \u0415\u0441\u0442\u044C: ${r.options.slice(0, 30).join(", ")}.`);
  return r.text;
}
var isChecked = (session, t) => callOn(
  session,
  t.frame,
  t.objectId,
  'function () { const c = this.control || this; return typeof c.checked === "boolean" ? c.checked : c.getAttribute("aria-checked") === "true"; }'
);
var isSelect = (session, t) => callOn(session, t.frame, t.objectId, 'function () { return this.tagName === "SELECT"; }');

// src/page/diff.ts
var unfocused = (line) => line.trim().replace(/ \(focused\)$/, "").replace(/, focused\)$/, ")").replace(/\(focused, /, "(");
function diffLines(prev, next) {
  const a = prev.map(unfocused), b = next.map(unfocused);
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i2 = a.length - 1; i2 >= 0; i2--) for (let j2 = b.length - 1; j2 >= 0; j2--) {
    dp[i2][j2] = a[i2] === b[j2] ? dp[i2 + 1][j2 + 1] + 1 : Math.max(dp[i2 + 1][j2], dp[i2][j2 + 1]);
  }
  const added = [], removed = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) removed.push(a[i++]);
    else added.push(b[j++]);
  }
  while (i < a.length) removed.push(a[i++]);
  while (j < b.length) added.push(b[j++]);
  return { added, removed };
}
function renderDiff(d, max = 30) {
  const count = d.added.length + d.removed.length;
  if (count === 0) return "";
  if (count > max) return `\u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0430 \u0441\u0438\u043B\u044C\u043D\u043E \u0438\u0437\u043C\u0435\u043D\u0438\u043B\u0430\u0441\u044C (${count} \u0441\u0442\u0440\u043E\u043A), \u0441\u0434\u0435\u043B\u0430\u0439\u0442\u0435 snapshot`;
  return [...d.added.map((l) => `+ ${l}`), ...d.removed.map((l) => `- ${l}`)].join("\n");
}

// src/page/highlight.ts
var COLORS = {
  yellow: { fill: "rgba(255, 230, 0, 0.6)", line: "#f5c400" },
  green: { fill: "rgba(80, 220, 100, 0.45)", line: "#22a845" },
  blue: { fill: "rgba(80, 160, 255, 0.4)", line: "#2f7de1" },
  red: { fill: "rgba(255, 80, 80, 0.45)", line: "#e53935" },
  orange: { fill: "rgba(255, 165, 0, 0.5)", line: "#f08c00" }
};
var STYLE_TEXT = Object.entries(COLORS).map(([name, c]) => `::highlight(assistant-${name}) { background-color: ${c.fill}; color: inherit; }`).join("\n");
var Highlighter = class {
  #session;
  #probes;
  /** Frames (by document) that already have the style sheet. */
  #styled = /* @__PURE__ */ new Set();
  constructor(session, probes) {
    this.#session = session;
    this.#probes = probes;
  }
  async #style(frameId) {
    const frame = this.#session.frames.get(frameId);
    if (!frame) return;
    const key = `${frameId}|${frame.loaderId}`;
    if (this.#styled.has(key)) return;
    await this.#session.cdp.send("CSS.enable", {}, frame.sessionId);
    const { styleSheetId } = await this.#session.cdp.send("CSS.createStyleSheet", { frameId }, frame.sessionId);
    await this.#session.cdp.send("CSS.setStyleSheetText", { styleSheetId, text: STYLE_TEXT }, frame.sessionId);
    this.#styled.add(key);
  }
  /** Highlights every visible occurrence of the text in every frame; returns how many. */
  async text(text, color) {
    let count = 0;
    for (const frame of this.#session.frames.list()) {
      try {
        await this.#style(frame.frameId);
        count += await probeEval(this.#session, frame.frameId, this.#probes, `__assistant.highlightText(${JSON.stringify(text)}, ${JSON.stringify(`assistant-${color}`)})`);
      } catch {
      }
    }
    return count;
  }
  async element(target, color) {
    await callOn(this.#session, target.frame, target.objectId, `function (color) { return __assistant.highlightElement(this.nodeType === 1 ? this : this.parentElement, color); }`, [{ value: COLORS[color].line }]);
  }
  async clear() {
    for (const frame of this.#session.frames.list()) {
      await probeEval(this.#session, frame.frameId, this.#probes, "__assistant.clearHighlights()").catch(() => {
      });
    }
  }
};
function checkColor(color) {
  const c = color ?? "yellow";
  if (!(c in COLORS)) throw new PageError("NOT_FOUND", `\u0426\u0432\u0435\u0442 ${color} \u043D\u0435 \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u0442\u0441\u044F. \u0415\u0441\u0442\u044C: ${Object.keys(COLORS).join(", ")}.`);
  return c;
}

// src/page/tools.ts
var PAGE_START = "<<<page-content>>>";
var NAVIGATION_TIMEOUT_MS = 15e3;
var WAIT_POLL_MS = 250;
var fold2 = (s) => s.toLocaleLowerCase("ru").replaceAll("\u0451", "\u0435");
var flat = (nodes) => nodes.flatMap((n) => [n, ...flat(n.children)]);
function normalizeUrl(input) {
  const url = input.trim();
  if (!url) throw new PageError("NOT_FOUND", "\u041D\u0435 \u0443\u043A\u0430\u0437\u0430\u043D \u0430\u0434\u0440\u0435\u0441.");
  if (/^(javascript|file|chrome|chrome-extension|chrome-untrusted|devtools|view-source|data|about|blob):/i.test(url)) {
    throw new PageError("PAGE_NOT_SUPPORTED", `\u0410\u0434\u0440\u0435\u0441 ${url.slice(0, 60)} \u043D\u0435 \u043E\u0442\u043A\u0440\u044B\u0432\u0430\u0435\u0442\u0441\u044F \u043F\u043E\u043C\u043E\u0449\u043D\u0438\u043A\u043E\u043C: \u0442\u043E\u043B\u044C\u043A\u043E \u043E\u0431\u044B\u0447\u043D\u044B\u0435 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u044B http \u0438 https.`);
  }
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}
var PAGE_END = "<<<end-page-content>>>";
function neutralize(text) {
  return text.replace(/<{3,}/g, "\u2039\u2039\u2039").replace(/>{3,}/g, "\u203A\u203A\u203A");
}
function pageText(head, body, notices) {
  return [PAGE_START, ...[head, body].filter(Boolean).map(neutralize), PAGE_END, ...notices.map(neutralize)].join("\n");
}
function errorResult(error) {
  if (error instanceof PageError) {
    const delivered = error.delivered === true ? " \u0421\u043E\u0431\u044B\u0442\u0438\u0435 \u0432\u0432\u043E\u0434\u0430 \u0431\u044B\u043B\u043E \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043E: \u043F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0443, \u043F\u0440\u0435\u0436\u0434\u0435 \u0447\u0435\u043C \u043F\u043E\u0432\u0442\u043E\u0440\u044F\u0442\u044C." : error.delivered === "unknown" ? " \u041D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u043E, \u0434\u043E\u0448\u043B\u043E \u043B\u0438 \u0441\u043E\u0431\u044B\u0442\u0438\u0435 \u0432\u0432\u043E\u0434\u0430: \u043F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0443, \u043F\u0440\u0435\u0436\u0434\u0435 \u0447\u0435\u043C \u043F\u043E\u0432\u0442\u043E\u0440\u044F\u0442\u044C." : "";
    return { ok: false, text: `\u043E\u0448\u0438\u0431\u043A\u0430 ${error.code}: ${neutralize(error.message)}${delivered}` };
  }
  return { ok: false, text: `\u043E\u0448\u0438\u0431\u043A\u0430 INTERNAL: ${neutralize(error instanceof Error ? error.message : String(error))}` };
}
var PageTools = class {
  session;
  refs;
  observer;
  budget;
  highlighter;
  /** Highlights made in this session, by page address, so going back to a page shows them again. */
  #highlights = [];
  /** A page dialog that is open now; while it is, the page answers nothing but handleDialog. */
  dialog;
  constructor(session, options) {
    this.session = session;
    this.budget = options.budget;
    this.refs = new RefRegistry(session.epoch);
    this.observer = new Observer(session, this.refs);
    this.highlighter = new Highlighter(session, this.observer.probes);
    session.cdp.on((method, _params, sessionId) => {
      if (method === "Page.loadEventFired" && !sessionId) setTimeout(() => void this.#restoreHighlights(), 300);
    });
    session.cdp.on((method) => {
      if (method === "Page.javascriptDialogClosed") this.dialog = void 0;
    });
    session.cdp.on((method, params) => {
      if (method === "Page.javascriptDialogOpening") this.dialog = { type: params.type, message: params.message };
    });
    session.frames.onChange(() => {
      for (const f of session.frames.list()) this.refs.invalidateFrame(f.frameId, f.loaderId);
    });
  }
  /** Runs a tool. A plain string result is page-derived text (a receipt names page elements) and goes inside the markers. */
  async run(fn, allowDuringDialog = false) {
    try {
      if (this.dialog && !allowDuringDialog) {
        throw new PageError("DIALOG_OPEN", `\u041D\u0430 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0435 \u043E\u0442\u043A\u0440\u044B\u0442 \u0434\u0438\u0430\u043B\u043E\u0433 ${this.dialog.type}: \xAB${this.dialog.message}\xBB. \u041E\u0442\u0432\u0435\u0442\u044C\u0442\u0435 \u043D\u0430 \u043D\u0435\u0433\u043E (handle_dialog), \u0435\u0441\u043B\u0438 \u044D\u0442\u043E\u0442 \u0438\u043D\u0441\u0442\u0440\u0443\u043C\u0435\u043D\u0442 \u0435\u0441\u0442\u044C, \u0438\u043D\u0430\u0447\u0435 \u043F\u043E\u043F\u0440\u043E\u0441\u0438\u0442\u0435 \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044F \u0437\u0430\u043A\u0440\u044B\u0442\u044C \u0434\u0438\u0430\u043B\u043E\u0433.`);
      }
      const out = await fn();
      return { ok: true, text: typeof out === "string" ? pageText("", out, []) : pageText(out.head, out.body, out.notices) };
    } catch (error) {
      return errorResult(error);
    }
  }
  snapshot(args = {}) {
    return this.run(async () => {
      const o = await this.observer.snapshot({ ...args, budget: this.budget });
      return { head: o.header, body: o.body, notices: o.notices };
    });
  }
  find(args) {
    return this.run(async () => {
      const r = await this.observer.find(args, this.budget);
      return { head: r.header, body: r.body, notices: r.notices };
    });
  }
  read(args = {}) {
    return this.run(async () => {
      const r = await this.observer.read({ ref: args.ref, budget: this.budget });
      return { head: r.header, body: r.body, notices: r.notices };
    });
  }
  /** The page around the screen as full lines (text included), for the diff in a receipt. */
  async #describe() {
    const { capture: capture2, roots } = await this.observer.observe();
    return render(roots, this.refs, { mode: "all", window: "near", budget: this.budget, viewport: capture2.viewport }).body.split("\n");
  }
  /**
   * One action on one label: resolve, check, watch, dispatch, settle, describe again. Retries happen only before
   * dispatch; after it, a failure says the event was sent.
   */
  async #act(verb, ref, needs, dispatch) {
    const target = await resolveTarget(this.session, this.refs, ref, this.observer.probes);
    const actionable = await waitActionable(this.session, target, needs, this.observer.probes);
    const before = await this.#describe();
    return this.#dispatchAndReport(
      `${verb} [${ref}] ${target.record.role} "${target.record.name}"`,
      before,
      [target.frame.frameId],
      (dialog) => dispatch(target, actionable, dialog),
      target.record.proxy === "label" ? ` (\u043A\u043B\u0438\u043A \u043F\u043E \u0441\u0432\u044F\u0437\u0430\u043D\u043D\u043E\u0439 \u043F\u043E\u0434\u043F\u0438\u0441\u0438 "${target.record.name}")` : ""
    );
  }
  async #dispatchAndReport(what, before, frameIds, dispatch, suffix = "") {
    const watch = await startWatch(this.session, this.observer.probes, frameIds);
    const dialog = watchDialog(this.session);
    let note = "";
    try {
      const result = await dispatch(dialog.opened);
      note = result?.note ?? "";
    } catch (error) {
      watch.stop();
      dialog.off();
      if (error instanceof PageError && error.delivered === false) error.delivered = "unknown";
      throw error;
    }
    const evidence = await watch.settle(() => dialog.current());
    dialog.off();
    let effect;
    try {
      effect = await this.#effectText(evidence, before);
    } catch (error) {
      if (!(error instanceof PageError && error.code === "DIALOG_OPEN") || !this.dialog) throw error;
      effect = `\u043E\u0442\u043A\u0440\u044B\u0442 \u0434\u0438\u0430\u043B\u043E\u0433 ${this.dialog.type}: \xAB${this.dialog.message}\xBB. \u041E\u0442\u0432\u0435\u0442\u044C\u0442\u0435 \u0447\u0435\u0440\u0435\u0437 handle_dialog.`;
    }
    return `${what}${suffix}: \u0441\u043E\u0431\u044B\u0442\u0438\u0435 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043E${note ? ` \xB7 ${note}` : ""} \xB7 \u0440\u0435\u0430\u043A\u0446\u0438\u044F: ${effect}`;
  }
  async #effectText(e, before) {
    const counts = `\u043C\u0443\u0442\u0430\u0446\u0438\u0439 ${e.mutations}, \u0437\u0430\u043F\u0440\u043E\u0441\u043E\u0432 ${e.requests}`;
    if (e.effect === "dialog") {
      this.dialog = e.dialog;
      return `\u043E\u0442\u043A\u0440\u044B\u0442 \u0434\u0438\u0430\u043B\u043E\u0433 ${e.dialog.type}: \xAB${e.dialog.message}\xBB. \u041E\u0442\u0432\u0435\u0442\u044C\u0442\u0435 \u0447\u0435\u0440\u0435\u0437 handle_dialog.`;
    }
    if (e.effect === "new_tab") return `\u043E\u0442\u043A\u0440\u044B\u0442\u0430 \u043D\u043E\u0432\u0430\u044F \u0432\u043A\u043B\u0430\u0434\u043A\u0430 ${e.url ?? ""}`.trim();
    if (e.effect === "navigated") {
      const o = await this.observer.snapshot({ budget: this.budget });
      return `\u043F\u0435\u0440\u0435\u0445\u043E\u0434 \u043D\u0430 ${e.url ?? o.capture.url}
\u043D\u043E\u0432\u0430\u044F \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0430: ${o.header}
\u0421\u0434\u0435\u043B\u0430\u0439\u0442\u0435 snapshot, \u0447\u0442\u043E\u0431\u044B \u0443\u0432\u0438\u0434\u0435\u0442\u044C \u0435\u0451 \u044D\u043B\u0435\u043C\u0435\u043D\u0442\u044B.`;
    }
    const diff = renderDiff(diffLines(before, await this.#describe()));
    let head = e.effect === "changed" ? `\u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0430 \u0438\u0437\u043C\u0435\u043D\u0438\u043B\u0430\u0441\u044C (${counts})` : e.effect === "requests" ? `\u0443\u0448\u043B\u0438 \u0437\u0430\u043F\u0440\u043E\u0441\u044B (${e.requests}), \u043E\u043F\u0438\u0441\u0430\u043D\u0438\u0435 \u043E\u043A\u043E\u043B\u043E \u044D\u043A\u0440\u0430\u043D\u0430 \u043D\u0435 \u0438\u0437\u043C\u0435\u043D\u0438\u043B\u043E\u0441\u044C` : "\u0432\u0438\u0434\u0438\u043C\u043E\u0439 \u0440\u0435\u0430\u043A\u0446\u0438\u0438 \u043D\u0435\u0442";
    if (e.sameDocument) head = `\u0430\u0434\u0440\u0435\u0441 \u0438\u0437\u043C\u0435\u043D\u0438\u043B\u0441\u044F \u043D\u0430 ${e.sameDocument} (\u0431\u0435\u0437 \u043F\u0435\u0440\u0435\u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0438) \xB7 ${head}`;
    if (e.notCommitted) head = `\u043F\u0435\u0440\u0435\u0445\u043E\u0434 \u043D\u0430 ${e.notCommitted} \u0437\u0430\u043F\u0440\u043E\u0448\u0435\u043D, \u043D\u043E \u043D\u0435 \u043F\u0440\u043E\u0438\u0437\u043E\u0448\u0451\u043B (\u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0430 \u0444\u0430\u0439\u043B\u0430, \u043F\u0443\u0441\u0442\u043E\u0439 \u043E\u0442\u0432\u0435\u0442 \u0438\u043B\u0438 \u043E\u0442\u043C\u0435\u043D\u0430) \xB7 ${head}`;
    return diff ? `${head}
\u0438\u0437\u043C\u0435\u043D\u0435\u043D\u0438\u044F:
${diff}` : head;
  }
  click(args) {
    return this.run(() => this.#act("click", args.ref, { pointer: true }, (_t, a, dialog) => click(this.session, a.point, dialog)));
  }
  hover(args) {
    return this.run(() => this.#act("hover", args.ref, { pointer: true }, async (_t, a) => {
      await hover(this.session, a.point);
    }));
  }
  type(args) {
    return this.run(() => this.#act("type", args.ref, { pointer: false, editable: true }, async (t, a, dialog) => {
      await focusTarget(this.session, t, a.point, dialog);
      await typeInto(this.session, t, args.text, Boolean(args.clear), dialog);
      if (args.submit) {
        const r = await pressKey(this.session, "Enter", dialog);
        if (r.dialog) return r;
      }
      return { note: `\u0432\u0432\u0435\u0434\u0435\u043D\u043E \u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432: ${args.text.length}${args.submit ? ", \u043D\u0430\u0436\u0430\u0442 Enter" : ""}` };
    }));
  }
  set(args) {
    return this.run(async () => {
      const probe = await resolveTarget(this.session, this.refs, args.ref, this.observer.probes);
      if (await isSelect(this.session, probe)) {
        return this.#act("set", args.ref, { pointer: false }, async (t) => ({ note: `\u0432\u044B\u0431\u0440\u0430\u043D\u043E \xAB${await selectOption(this.session, t, String(args.value))}\xBB` }));
      }
      const want = args.value === true || args.value === "true" || args.value === "on";
      return this.#act("set", args.ref, { pointer: true }, async (t, a, dialog) => {
        if (await isChecked(this.session, t) === want) return { note: `\u0443\u0436\u0435 ${want ? "\u0432\u043A\u043B\u044E\u0447\u0435\u043D\u043E" : "\u0432\u044B\u043A\u043B\u044E\u0447\u0435\u043D\u043E"}` };
        const r = await click(this.session, a.point, dialog);
        if (r.dialog) return r;
        if (await isChecked(this.session, t) !== want) throw new PageError("VALUE_MISMATCH", `\u0421\u043E\u0441\u0442\u043E\u044F\u043D\u0438\u0435 \u044D\u043B\u0435\u043C\u0435\u043D\u0442\u0430 ${args.ref} \u043D\u0435 \u0438\u0437\u043C\u0435\u043D\u0438\u043B\u043E\u0441\u044C \u043F\u043E\u0441\u043B\u0435 \u043A\u043B\u0438\u043A\u0430.`, true);
        return { note: want ? "\u0432\u043A\u043B\u044E\u0447\u0435\u043D\u043E" : "\u0432\u044B\u043A\u043B\u044E\u0447\u0435\u043D\u043E" };
      });
    });
  }
  press(args) {
    return this.run(async () => {
      if (!(args.key in KEYS)) throw new PageError("NOT_FOUND", `\u041A\u043B\u0430\u0432\u0438\u0448\u0430 ${args.key} \u043D\u0435 \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u0442\u0441\u044F. \u0415\u0441\u0442\u044C: ${Object.keys(KEYS).join(", ")}.`);
      if (args.ref) {
        const target = await resolveTarget(this.session, this.refs, args.ref, this.observer.probes);
        await waitActionable(this.session, target, { pointer: false }, this.observer.probes);
        await this.session.cdp.send("DOM.focus", { backendNodeId: target.record.backendNodeId }, target.frame.sessionId).catch(() => {
        });
        if (!await isFocused(this.session, target)) {
          throw new PageError("NOT_EDITABLE", `\u042D\u043B\u0435\u043C\u0435\u043D\u0442 ${args.ref} \u043D\u0435 \u043F\u0440\u0438\u043D\u0438\u043C\u0430\u0435\u0442 \u0444\u043E\u043A\u0443\u0441 \u043A\u043B\u0430\u0432\u0438\u0430\u0442\u0443\u0440\u044B: \u043A\u043B\u0430\u0432\u0438\u0448\u0430 \u043D\u0435 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u0430. \u0414\u043B\u044F \u043D\u0435\u0433\u043E \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0439\u0442\u0435 click.`);
        }
        const before = await this.#describe();
        return this.#dispatchAndReport(
          `press ${args.key} [${args.ref}] ${target.record.role} "${target.record.name}"`,
          before,
          [target.frame.frameId],
          (dialog) => pressKey(this.session, args.key, dialog)
        );
      }
      return this.#dispatchAndReport(`press ${args.key}`, await this.#describe(), [], (dialog) => pressKey(this.session, args.key, dialog));
    });
  }
  scroll(args) {
    return this.run(async () => {
      const { capture: capture2 } = await this.observer.observe();
      const delta = Math.round(capture2.viewport.height * (args.amount === "half" ? 0.5 : 0.85)) * (args.direction === "up" ? -1 : 1);
      let point = { x: capture2.viewport.width / 2, y: capture2.viewport.height / 2 };
      let what = `scroll ${args.direction}`;
      if (args.ref) {
        const target = await resolveTarget(this.session, this.refs, args.ref, this.observer.probes);
        point = (await waitActionable(this.session, target, { pointer: false }, this.observer.probes)).point;
        what += ` \u0432 [${args.ref}]`;
      }
      await wheel(this.session, point, delta);
      await new Promise((r) => setTimeout(r, 400));
      const o = await this.observer.snapshot({ budget: this.budget });
      return `${what}: \u043F\u0440\u043E\u043A\u0440\u0443\u0447\u0435\u043D\u043E \xB7 ${o.header}`;
    });
  }
  navigate(args) {
    return this.run(async () => {
      const { cdp } = this.session;
      let what;
      let status;
      const mainId = this.session.frames.main().frameId;
      let done;
      const arrived = new Promise((r) => {
        done = r;
      });
      const off = cdp.on((method, params, sessionId) => {
        if (sessionId) return;
        if (method === "Network.responseReceived" && params.type === "Document" && params.frameId === mainId) status = params.response.status;
        if (method === "Page.loadEventFired") done();
      });
      try {
        if (args.action === "back" || args.action === "forward") {
          const { currentIndex, entries } = await cdp.send("Page.getNavigationHistory");
          const entry = entries[currentIndex + (args.action === "back" ? -1 : 1)];
          if (!entry) throw new PageError("NOT_FOUND", args.action === "back" ? "\u041D\u0430\u0437\u0430\u0434 \u043D\u0435\u043A\u0443\u0434\u0430: \u044D\u0442\u043E \u043F\u0435\u0440\u0432\u0430\u044F \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0430 \u0432 \u0438\u0441\u0442\u043E\u0440\u0438\u0438 \u0432\u043A\u043B\u0430\u0434\u043A\u0438." : "\u0412\u043F\u0435\u0440\u0451\u0434 \u043D\u0435\u043A\u0443\u0434\u0430.");
          what = args.action === "back" ? "\u043D\u0430\u0437\u0430\u0434" : "\u0432\u043F\u0435\u0440\u0451\u0434";
          const restored = cdp.on((method, params, sessionId) => {
            if (!sessionId && method === "Page.frameNavigated" && !params.frame.parentId) setTimeout(done, 300);
          });
          await cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id });
          await Promise.race([arrived, new Promise((r) => setTimeout(r, NAVIGATION_TIMEOUT_MS))]);
          restored();
        } else if (args.action === "reload") {
          what = "\u043E\u0431\u043D\u043E\u0432\u043B\u0435\u043D\u0438\u0435";
          await cdp.send("Page.reload", {});
          await Promise.race([arrived, new Promise((r) => setTimeout(r, NAVIGATION_TIMEOUT_MS))]);
        } else {
          const url = normalizeUrl(args.url ?? "");
          what = `\u043F\u0435\u0440\u0435\u0445\u043E\u0434 \u043D\u0430 ${url}`;
          const r = await cdp.send("Page.navigate", { url });
          if (r.errorText) throw new PageError("NOT_FOUND", `\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043E\u0442\u043A\u0440\u044B\u0442\u044C ${url}: ${r.errorText}.`);
          await Promise.race([arrived, new Promise((r2) => setTimeout(r2, NAVIGATION_TIMEOUT_MS))]);
        }
      } finally {
        off();
      }
      const o = await this.observer.snapshot({ budget: this.budget });
      return `${what}: ${status ? `HTTP ${status} \xB7 ` : ""}${o.header}
\u0421\u0434\u0435\u043B\u0430\u0439\u0442\u0435 snapshot, \u0447\u0442\u043E\u0431\u044B \u0443\u0432\u0438\u0434\u0435\u0442\u044C \u044D\u043B\u0435\u043C\u0435\u043D\u0442\u044B \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u044B.`;
    });
  }
  wait(args) {
    return this.run(async () => {
      const timeout = Math.min(3e4, Math.max(100, args.timeoutMs ?? 5e3));
      if (!args.text && !args.ref) {
        const r = await waitForReady(this.session, this.observer.network, this.observer.probes, timeout);
        if (!r.ready) throw new PageError("TIMEOUT", `\u0421\u0442\u0440\u0430\u043D\u0438\u0446\u0430 \u043D\u0435 \u0443\u0441\u043F\u043E\u043A\u043E\u0438\u043B\u0430\u0441\u044C \u0437\u0430 ${timeout} \u043C\u0441 (${r.reason}).`);
        return `\u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0430 \u0433\u043E\u0442\u043E\u0432\u0430 \u0437\u0430 ${r.waitedMs} \u043C\u0441`;
      }
      const record = args.ref ? this.refs.get(args.ref) : void 0;
      const want = args.text ? fold2(args.text) : "";
      const started = Date.now();
      for (; ; ) {
        const { roots } = await this.observer.quick();
        const nodes = flat(roots);
        const present = record ? nodes.some((n) => n.backendNodeId === record.backendNodeId && n.loaderId === record.loaderId) : nodes.some((n) => fold2(`${n.name} ${n.value ?? ""}`).includes(want));
        if (present !== Boolean(args.gone)) {
          const subject = args.text ? `\u0442\u0435\u043A\u0441\u0442 \xAB${args.text}\xBB` : `\u044D\u043B\u0435\u043C\u0435\u043D\u0442 ${args.ref}`;
          return `${subject} ${args.gone ? "\u0438\u0441\u0447\u0435\u0437" : "\u043F\u043E\u044F\u0432\u0438\u043B\u0441\u044F"} \u0447\u0435\u0440\u0435\u0437 ${Date.now() - started} \u043C\u0441`;
        }
        if (Date.now() - started >= timeout) {
          const subject = args.text ? `\u0442\u0435\u043A\u0441\u0442\u0430 \xAB${args.text}\xBB` : `\u044D\u043B\u0435\u043C\u0435\u043D\u0442\u0430 ${args.ref}`;
          throw new PageError("TIMEOUT", `\u041D\u0435 \u0434\u043E\u0436\u0434\u0430\u043B\u0441\u044F ${args.gone ? "\u0438\u0441\u0447\u0435\u0437\u043D\u043E\u0432\u0435\u043D\u0438\u044F" : "\u043F\u043E\u044F\u0432\u043B\u0435\u043D\u0438\u044F"} ${subject} \u0437\u0430 ${timeout} \u043C\u0441.`);
        }
        await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
      }
    });
  }
  highlight(args) {
    return this.run(async () => {
      const color = checkColor(args.color);
      if (Boolean(args.ref) === Boolean(args.text)) throw new PageError("NOT_FOUND", "\u0423\u043A\u0430\u0436\u0438\u0442\u0435 \u0440\u043E\u0432\u043D\u043E \u043E\u0434\u043D\u043E: ref (\u044D\u043B\u0435\u043C\u0435\u043D\u0442) \u0438\u043B\u0438 text (\u0444\u0440\u0430\u0433\u043C\u0435\u043D\u0442 \u0442\u0435\u043A\u0441\u0442\u0430).");
      const url = this.session.frames.main().url;
      if (args.text) {
        const count = await this.highlighter.text(args.text, color);
        if (!count) throw new PageError("NOT_FOUND", `\u0422\u0435\u043A\u0441\u0442 \xAB${args.text}\xBB \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D \u0441\u0440\u0435\u0434\u0438 \u0432\u0438\u0434\u0438\u043C\u043E\u0433\u043E \u0442\u0435\u043A\u0441\u0442\u0430 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u044B.`);
        this.#highlights.push({ url, text: args.text, color });
        return `\u0432\u044B\u0434\u0435\u043B\u0435\u043D\u043E \u043C\u0435\u0441\u0442: ${count} (\u0446\u0432\u0435\u0442 ${color})`;
      }
      const target = await resolveTarget(this.session, this.refs, args.ref, this.observer.probes);
      await this.highlighter.element(target, color);
      this.#highlights.push({ url, element: { role: target.record.role, name: target.record.name }, color });
      return `\u044D\u043B\u0435\u043C\u0435\u043D\u0442 [${args.ref}] ${target.record.role} "${target.record.name}" \u043E\u0431\u0432\u0435\u0434\u0451\u043D (\u0446\u0432\u0435\u0442 ${color})`;
    });
  }
  clearHighlights() {
    return this.run(async () => {
      await this.highlighter.clear();
      const url = this.session.frames.main().url;
      for (let i = this.#highlights.length - 1; i >= 0; i--) if (this.#highlights[i].url === url) this.#highlights.splice(i, 1);
      return "\u043F\u043E\u0434\u0441\u0432\u0435\u0442\u043A\u0430 \u0441\u043D\u044F\u0442\u0430";
    });
  }
  async #restoreHighlights() {
    const url = this.session.frames.main().url;
    const mine = this.#highlights.filter((h) => h.url === url);
    if (!mine.length) return;
    try {
      for (const h of mine.filter((h2) => h2.text)) await this.highlighter.text(h.text, h.color);
      const wanted = mine.filter((h) => h.element);
      if (!wanted.length) return;
      const { roots } = await this.observer.quick();
      for (const h of wanted) {
        const node = flat(roots).find((n) => n.role === h.element.role && n.name === h.element.name && n.backendNodeId !== void 0);
        if (!node) continue;
        const target = await resolveTarget(this.session, this.refs, this.refs.assign(node), this.observer.probes);
        await this.highlighter.element(target, h.color);
      }
    } catch {
    }
  }
  handleDialog(args) {
    return this.run(async () => {
      if (!this.dialog) throw new PageError("NOT_FOUND", "\u0421\u0435\u0439\u0447\u0430\u0441 \u043D\u0430 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0435 \u043D\u0435\u0442 \u0434\u0438\u0430\u043B\u043E\u0433\u0430.");
      const was = this.dialog;
      await this.session.cdp.send("Page.handleJavaScriptDialog", { accept: args.accept, promptText: args.text });
      this.dialog = void 0;
      await new Promise((r) => setTimeout(r, 300));
      return `\u0434\u0438\u0430\u043B\u043E\u0433 ${was.type} \xAB${was.message}\xBB: ${args.accept ? "\u043F\u0440\u0438\u043D\u044F\u0442" : "\u043E\u0442\u043A\u043B\u043E\u043D\u0451\u043D"}`;
    }, true);
  }
  /** For the e2e harness: runs the checks before an action on a label, without acting. */
  async debugActionable(ref) {
    const started = Date.now();
    try {
      const target = await resolveTarget(this.session, this.refs, ref, this.observer.probes);
      const { point } = await waitActionable(this.session, target, { pointer: true }, this.observer.probes);
      return { ok: true, point, ms: Date.now() - started };
    } catch (error) {
      return { ok: false, code: error instanceof PageError ? error.code : "INTERNAL", message: error instanceof Error ? error.message : String(error), ms: Date.now() - started };
    }
  }
  dispose() {
    this.observer.network.stop();
  }
};

// src/dev/harness.ts
async function withSession(tabId, fn) {
  const session = await acquire(tabId);
  try {
    return await fn(session);
  } finally {
    await release(session);
  }
}
var open = /* @__PURE__ */ new Map();
function toolsFor(tabId, budget) {
  let tools = open.get(tabId);
  if (!tools) {
    tools = acquire(tabId).then((session) => new PageTools(session, { budget }));
    open.set(tabId, tools);
  }
  return tools;
}
var layer = {
  ping: () => "pong",
  async openTab(url) {
    const win = await chrome.windows.create({ url, width: 1e3, height: 760 });
    return win.tabs[0].id;
  },
  frames: (tabId) => withSession(tabId, async (session) => session.frames.list()),
  capture: (tabId) => withSession(tabId, capture),
  async call(tabId, method, args = {}, budget = 26214) {
    const tools = await toolsFor(tabId, budget);
    tools.budget = budget;
    return tools[method](args);
  },
  debug: {
    actionable: async (tabId, ref) => (await toolsFor(tabId, 26214)).debugActionable(ref)
  },
  async navigate(tabId, url) {
    await chrome.tabs.update(tabId, { url });
  },
  async evalInTab(tabId, expression) {
    const tools = await toolsFor(tabId, 26214);
    const r = await tools.session.cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return r.result.value;
  },
  async done(tabId) {
    const tools = await open.get(tabId);
    open.delete(tabId);
    if (tools) {
      tools.dispose();
      await release(tools.session);
    }
  }
};
Object.assign(window, { layer });
