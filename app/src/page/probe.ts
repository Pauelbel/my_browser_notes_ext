// The layer's only script in pages, run in an isolated world named "assistant": page scripts cannot see or change it.
// It counts DOM mutations (for readiness and action evidence) and answers small questions about elements.
import type {PageSession} from './session.ts';
import {CHECKS_SOURCE} from './checks.ts';

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
  const highlightTimers = new Map();
  const armExpiry = owner => {
    const key = owner || '*';
    clearTimeout(highlightTimers.get(key));
    highlightTimers.set(key, setTimeout(() => globalThis.__assistant && globalThis.__assistant.clearHighlights(owner || undefined), 10 * 60 * 1000));
  };
  let layer = null;
  const ensureLayer = () => {
    if (layer && layer.host.isConnected) return layer;
    const host = document.createElement('div');
    host.setAttribute('${OVERLAY_ATTR}', '');
    // A zero-sized host with fixed children cannot cover the page even in browser hit-testing implementations
    // that handle pointer-events on shadow hosts inconsistently.
    for (const [k, v] of [['position', 'fixed'], ['left', '0'], ['top', '0'], ['width', '0'], ['height', '0'], ['overflow', 'visible'],
      ['pointer-events', 'none'], ['z-index', '2147483647'], ['display', 'block']]) host.style.setProperty(k, v, 'important');
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
    ${CHECKS_SOURCE}
    highlightText(query, name, owner) {
      const words = fold(query).split(/\\s+/).filter(Boolean); if (!words.length) return 0;
      // The visible text as one string with each character's node and offset: sites split a phrase over elements
      // (YouTube writes «29» and «комментариев» in two spans), so a match may span nodes.
      let text = ''; const nodes = []; const offsets = [];
      const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
      for (let node; (node = walker.nextNode());) {
        const parent = node.parentElement;
        if (!parent || inOverlay(node) || !parent.getClientRects().length || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(parent.tagName)) continue;
        for (let i = 0; i < node.data.length; i++) {
          const c = fold(node.data[i]);
          text += c.length === 1 ? c : node.data[i];
          nodes.push(node); offsets.push(i);
        }
      }
      // Words follow each other with any whitespace between them, or none (a gap drawn by a margin).
      const endOf = start => {
        let p = start;
        for (let w = 0; w < words.length; w++) {
          if (w) while (p < text.length && /\\s/.test(text[p])) p++;
          if (!text.startsWith(words[w], p)) return -1;
          p += words[w].length;
        }
        return p;
      };
      const ranges = [];
      for (let i = text.indexOf(words[0]); i >= 0;) {
        const end = endOf(i);
        if (end < 0) { i = text.indexOf(words[0], i + 1); continue; }
        const r = new Range(); r.setStart(nodes[i], offsets[i]); r.setEnd(nodes[end - 1], offsets[end - 1] + 1); ranges.push(r);
        i = text.indexOf(words[0], end);
      }
      if (!ranges.length) return 0;
      const h = highlights.get(name) || new Highlight();
      for (const r of ranges) h.add(r);
      highlights.set(name, h);
      CSS.highlights.set(name, h);
      armExpiry(owner);
      return ranges.length;
    },
    highlightElement(el, color, owner) {
      const l = ensureLayer();
      const box = document.createElement('div');
      l.root.append(box);
      l.boxes.push({el, box, color, owner: owner || ''});
      l.place();
      armExpiry(owner);
      return 1;
    },
    border(on, color) {
      let host = document.querySelector('[${OVERLAY_ATTR}="border"]');
      if (!on) { if (host) host.remove(); return; }
      if (host) return;
      host = document.createElement('div');
      host.setAttribute('${OVERLAY_ATTR}', 'border');
      for (const [k, v] of [['position', 'fixed'], ['inset', '0'], ['pointer-events', 'none'], ['z-index', '2147483647'], ['display', 'block'],
        ['box-shadow', 'inset 0 0 0 3px ' + color + ', inset 0 0 18px ' + color], ['border-radius', '2px']]) host.style.setProperty(k, v, 'important');
      document.documentElement.append(host);
    },
    clearHighlights(owner) {
      const prefix = owner ? 'assistant-' + owner + '-' : '';
      for (const name of [...highlights.keys()]) if (!owner || name.startsWith(prefix) || /^assistant-(yellow|green|blue|red|orange)$/.test(name)) { CSS.highlights.delete(name); highlights.delete(name); }
      if (layer && owner) {
        for (const item of layer.boxes.filter(x => x.owner === owner || !x.owner)) item.box.remove();
        layer.boxes = layer.boxes.filter(x => x.owner !== owner && x.owner);
        if (!layer.boxes.length) { layer.host.remove(); layer = null; }
      } else if (layer) { layer.host.remove(); layer = null; }
      const key = owner || '*'; clearTimeout(highlightTimers.get(key)); highlightTimers.delete(key);
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
export async function probeEval<T>(session: PageSession, frameId: string, cache: Map<string, {loaderId: string; contextId: number}>, expression: string, timeoutMs?: number): Promise<T> {
  const contextId = await ensureProbe(session, frameId, cache);
  const frame = session.frames.get(frameId);
  const result = await session.cdp.send<{result: {value: T}; exceptionDetails?: {text: string}}>('Runtime.evaluate',
    {expression, contextId, returnByValue: true, awaitPromise: true}, frame?.sessionId, timeoutMs);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}
