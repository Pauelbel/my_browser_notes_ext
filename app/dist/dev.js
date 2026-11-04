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
  const layoutPromise = Promise.all(sessions.map(async (key) => {
    const snapshot = await cdp.send("DOMSnapshot.captureSnapshot", { computedStyles: LAYOUT_STYLES, includeDOMRects: true }, key || void 0, COMMAND_TIMEOUT_MS);
    return [key, snapshot];
  })).then((entries) => ({ layout: Object.fromEntries(entries) }), (error) => ({ layout: {}, layoutError: error instanceof Error ? error.message : String(error) }));
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
      const text = (name || textOf(children)).slice(0, CLICKABLE_NAME_MAX);
      return [{ ...base(ax), kind: "element", role: "clickable", name: text, states: [], children: [], interactive: true, y: yOf(own) }];
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
      if (TEXT_FIELDS.has(role) && own && isSecretField(own.attrs)) {
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
  globalThis.__assistant = {
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
    } catch {
    }
    if (mutations !== lastMutations) {
      lastMutations = mutations;
      mutationsStableSince = Date.now();
    }
    const waited = Date.now() - started;
    const domQuiet = Date.now() - mutationsStableSince >= DOM_QUIET_MS;
    const needQuiet = Date.now() - network.createdAt < FRESH_TRACKER_MS ? FRESH_QUIET_MS : NETWORK_QUIET_MS;
    if (readyState === "complete" && network.quietFor() >= needQuiet && domQuiet) return { ready: true, waitedMs: waited };
    if (waited >= capMs) {
      const reason = readyState !== "complete" ? "\u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0430 \u0435\u0449\u0451 \u0437\u0430\u0433\u0440\u0443\u0436\u0430\u0435\u0442\u0441\u044F" : network.inflight() ? `\u0438\u0434\u0443\u0442 \u0437\u0430\u043F\u0440\u043E\u0441\u044B (${network.inflight()})` : "\u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0430 \u043F\u0440\u043E\u0434\u043E\u043B\u0436\u0430\u0435\u0442 \u043C\u0435\u043D\u044F\u0442\u044C\u0441\u044F";
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

// src/page/tools.ts
var PAGE_START = "<<<page-content>>>";
var PAGE_END = "<<<end-page-content>>>";
function pageText(head, body, notices, before = "") {
  return [before, head, PAGE_START, body, PAGE_END, ...notices].filter(Boolean).join("\n");
}
function errorResult(error) {
  if (error instanceof PageError) {
    const delivered = error.delivered === true ? " \u0421\u043E\u0431\u044B\u0442\u0438\u0435 \u0432\u0432\u043E\u0434\u0430 \u0431\u044B\u043B\u043E \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043E: \u043F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0443, \u043F\u0440\u0435\u0436\u0434\u0435 \u0447\u0435\u043C \u043F\u043E\u0432\u0442\u043E\u0440\u044F\u0442\u044C." : error.delivered === "unknown" ? " \u041D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u043E, \u0434\u043E\u0448\u043B\u043E \u043B\u0438 \u0441\u043E\u0431\u044B\u0442\u0438\u0435 \u0432\u0432\u043E\u0434\u0430: \u043F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435 \u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0443, \u043F\u0440\u0435\u0436\u0434\u0435 \u0447\u0435\u043C \u043F\u043E\u0432\u0442\u043E\u0440\u044F\u0442\u044C." : "";
    return { ok: false, text: `\u043E\u0448\u0438\u0431\u043A\u0430 ${error.code}: ${error.message}${delivered}` };
  }
  return { ok: false, text: `\u043E\u0448\u0438\u0431\u043A\u0430 INTERNAL: ${error instanceof Error ? error.message : String(error)}` };
}
var PageTools = class {
  session;
  refs;
  observer;
  budget;
  constructor(session, options) {
    this.session = session;
    this.budget = options.budget;
    this.refs = new RefRegistry(session.epoch);
    this.observer = new Observer(session, this.refs);
    session.frames.onChange(() => {
      for (const f of session.frames.list()) this.refs.invalidateFrame(f.frameId, f.loaderId);
    });
  }
  async run(fn) {
    try {
      return { ok: true, text: await fn() };
    } catch (error) {
      return errorResult(error);
    }
  }
  snapshot(args = {}) {
    return this.run(async () => {
      const o = await this.observer.snapshot({ ...args, budget: this.budget });
      return pageText(o.header, o.body, o.notices);
    });
  }
  find(args) {
    return this.run(async () => {
      const r = await this.observer.find(args, this.budget);
      return pageText(r.header, r.body, r.notices);
    });
  }
  read(args = {}) {
    return this.run(async () => {
      const r = await this.observer.read({ ref: args.ref, budget: this.budget });
      return pageText(r.header, r.body, r.notices);
    });
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
