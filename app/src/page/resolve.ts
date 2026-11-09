// From a label to the live node it was shown for. The node must still be in the same document, still attached,
// and still have the role and name the model saw; otherwise the label is stale and nothing is guessed.
import {cleanText} from './ax.ts';
import {PageError} from './errors.ts';
import type {FrameInfo} from './frames.ts';
import {ensureProbe} from './probe.ts';
import type {RefRecord, RefRegistry} from './refs.ts';
import type {PageSession} from './session.ts';

export type ProbeCache = Map<string, {loaderId: string; contextId: number}>;

export interface Target {
  record: RefRecord;
  frame: FrameInfo;
  /** The node as a remote object in the probe's isolated world of its frame. */
  objectId: string;
}

const staleText = (ref: string, why: string) => `Элемент ${ref} ${why}: сделайте snapshot и возьмите новую метку.`;

export async function callOn<T>(session: PageSession, frame: FrameInfo, objectId: string, fn: string, args: {objectId?: string; value?: unknown}[] = []): Promise<T> {
  const r = await session.cdp.send<{result: {value: T}; exceptionDetails?: {text: string}}>('Runtime.callFunctionOn',
    {objectId, functionDeclaration: fn, arguments: args, returnByValue: true, awaitPromise: true}, frame.sessionId);
  if (r.exceptionDetails) throw new PageError('INTERNAL', r.exceptionDetails.text);
  return r.result.value;
}

export async function resolveNode(session: PageSession, frame: FrameInfo, backendNodeId: number, probes: ProbeCache): Promise<string | null> {
  const executionContextId = await ensureProbe(session, frame.frameId, probes);
  try {
    const {object} = await session.cdp.send<{object: {objectId: string}}>('DOM.resolveNode', {backendNodeId, executionContextId}, frame.sessionId);
    return object.objectId;
  } catch {
    return null;
  }
}

export async function resolveTarget(session: PageSession, refs: RefRegistry, ref: string, probes: ProbeCache): Promise<Target> {
  const record = refs.get(ref);
  const frame = session.frames.get(record.frameId);
  if (!frame || frame.loaderId !== record.loaderId) {
    refs.invalidateFrame(record.frameId, frame?.loaderId ?? '');
    throw new PageError('REF_STALE', staleText(ref, 'был на странице, которая уже сменилась'));
  }
  const objectId = await resolveNode(session, frame, record.backendNodeId, probes);
  if (!objectId) throw new PageError('REF_STALE', staleText(ref, 'исчез со страницы'));
  const connected = await callOn<boolean>(session, frame, objectId, 'function () { return this.isConnected; }');
  if (!connected) throw new PageError('REF_STALE', staleText(ref, 'исчез со страницы (её перерисовали)'));
  // A control shown through its label and a clickable div have no role of their own to compare.
  if (!record.proxy && record.role !== 'clickable') {
    const {nodes} = await session.cdp.send<{nodes: {role?: {value?: string}; name?: {value?: string}}[]}>(
      'Accessibility.getPartialAXTree', {backendNodeId: record.backendNodeId, fetchRelatives: false}, frame.sessionId);
    const role = nodes[0]?.role?.value ?? '', name = cleanText(String(nodes[0]?.name?.value ?? ''));
    if (role !== record.role || name !== record.name) {
      throw new PageError('REF_STALE', staleText(ref, `изменился (был ${record.role} "${record.name}", стал ${role} "${name}")`));
    }
  }
  if (record.recordContext) {
    const current = await callOn<string>(session, frame, objectId, `function () {
      const start = this.nodeType === 1 ? this : this.parentElement;
      const row = start && start.closest('[role="row"], [role="listitem"], [role="article"], [role="treeitem"], tr, li, article');
      return row ? (row.innerText || row.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 240) : '';
    }`).catch(() => '');
    const expected = cleanText(record.recordContext).slice(0, 240);
    if (current && expected && cleanText(current) !== expected) {
      throw new PageError('REF_STALE', staleText(ref, 'теперь находится в другой записи списка (страница переиспользовала DOM-узел)'));
    }
  }
  return {record, frame, objectId};
}
