// The layer's only script in pages, run in an isolated world named "assistant": page scripts cannot see or change it.
// It counts DOM mutations (for readiness and action evidence) and answers small questions about elements.
import type {PageSession} from './session.ts';

export const WORLD = 'assistant';
export const OVERLAY_ATTR = 'data-assistant-overlay';

export const PROBE_SOURCE = `(() => {
  if (globalThis.__assistant) return;
  const OVERLAY = '[${OVERLAY_ATTR}]';
  const state = {mutations: 0};
  const inOverlay = node => { const el = node && (node.nodeType === 1 ? node : node.parentElement); return Boolean(el && el.closest && el.closest(OVERLAY)); };
  const observe = () => new MutationObserver(records => {
    for (const r of records) if (!inOverlay(r.target)) state.mutations++;
  }).observe(document, {subtree: true, childList: true, attributes: true, characterData: true});
  if (document.documentElement) observe(); else document.addEventListener('DOMContentLoaded', observe, {once: true});
  const fold = s => s.toLowerCase().replace(/ё/g, 'е');
  const highlights = new Map();
  let layer = null;
  const ensureLayer = () => {
    if (layer && layer.host.isConnected) return layer;
    const host = document.createElement('div');
    host.setAttribute('${OVERLAY_ATTR}', '');
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

/** The probe's execution context in a frame, created on first use and again after the frame loads a new document. */
export async function ensureProbe(session: PageSession, frameId: string, cache: Map<string, {loaderId: string; contextId: number}>): Promise<number> {
  const frame = session.frames.get(frameId);
  if (!frame) throw new Error(`Фрейм ${frameId} исчез`);
  const cached = cache.get(frameId);
  if (cached && cached.loaderId === frame.loaderId) return cached.contextId;
  const {executionContextId} = await session.cdp.send<{executionContextId: number}>('Page.createIsolatedWorld', {frameId, worldName: WORLD, grantUniveralAccess: false}, frame.sessionId);
  await session.cdp.send('Runtime.evaluate', {expression: PROBE_SOURCE, contextId: executionContextId}, frame.sessionId);
  cache.set(frameId, {loaderId: frame.loaderId, contextId: executionContextId});
  return executionContextId;
}

/** Evaluates `expression` in the probe's world of a frame and returns its value. */
export async function probeEval<T>(session: PageSession, frameId: string, cache: Map<string, {loaderId: string; contextId: number}>, expression: string): Promise<T> {
  const contextId = await ensureProbe(session, frameId, cache);
  const frame = session.frames.get(frameId);
  const result = await session.cdp.send<{result: {value: T}; exceptionDetails?: {text: string}}>('Runtime.evaluate',
    {expression, contextId, returnByValue: true, awaitPromise: true}, frame?.sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}
