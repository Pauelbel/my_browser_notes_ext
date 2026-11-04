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
