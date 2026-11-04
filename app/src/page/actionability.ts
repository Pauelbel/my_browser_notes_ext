// Before an input event is sent: the target is attached, visible, enabled, holds still, and is what a pointer at the
// click point would hit, at every level of the frame chain. Every retry happens here, before anything is dispatched.
import {PageError} from './errors.ts';
import type {FrameInfo} from './frames.ts';
import {quadArea, toParent, visibleCenter, type Point, type Quad} from './geometry.ts';
import {probeEval} from './probe.ts';
import {callOn, resolveNode, type ProbeCache, type Target} from './resolve.ts';
import type {PageSession} from './session.ts';

export const ACTIONABILITY_BUDGET_MS = 5000;
const SCHEDULE = [0, 20, 100, 100, 500];
const STABLE_GAP_MS = 50;
const STABLE_TOLERANCE_PX = 2;
const TERMINAL = new Set(['REF_STALE', 'NOT_EDITABLE', 'DETACHED', 'PAGE_NOT_SUPPORTED', 'REF_UNKNOWN']);

export interface Actionable { point: Point; quad: Quad }
interface ElementState { disabled: boolean; readonly: boolean; editable: boolean; visible: boolean }

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function scrollOffset(session: PageSession, sessionId?: string): Promise<Point> {
  const m = await session.cdp.send<{cssLayoutViewport: {pageX: number; pageY: number}}>('Page.getLayoutMetrics', {}, sessionId);
  return {x: m.cssLayoutViewport.pageX, y: m.cssLayoutViewport.pageY};
}

async function firstQuad(session: PageSession, frame: FrameInfo, backendNodeId: number): Promise<Quad | null> {
  try {
    const {quads} = await session.cdp.send<{quads: Quad[]}>('DOM.getContentQuads', {backendNodeId}, frame.sessionId);
    return quads.find(q => quadArea(q) > 1) ?? null;
  } catch {
    return null;
  }
}

/** The chain from the target's session root up to the tab: owner iframes in parent sessions, nearest first. */
function sessionChain(session: PageSession, frame: FrameInfo): {root: FrameInfo; parent?: FrameInfo}[] {
  const chain: {root: FrameInfo; parent?: FrameInfo}[] = [];
  let root = session.frames.sessionRoot(frame.frameId);
  for (;;) {
    const parent = root.parentFrameId ? session.frames.get(root.parentFrameId) : undefined;
    chain.push({root, parent});
    if (!parent) return chain;
    root = session.frames.sessionRoot(parent.frameId);
  }
}

/** Short text that names what a person would see in the way. */
async function describe(session: PageSession, frame: FrameInfo, objectId: string): Promise<string> {
  return callOn<string>(session, frame, objectId, `function () {
    let el = this.nodeType === 1 ? this : this.parentElement;
    for (let n = el; n; n = n.parentElement) { const t = (n.getAttribute('aria-label') || n.innerText || '').trim(); if (t) return t.replace(/\\s+/g, ' ').slice(0, 80); }
    return el ? el.tagName.toLowerCase() : 'неизвестный элемент';
  }`).catch(() => 'другой элемент');
}

async function hitTest(session: PageSession, target: Target, local: Point, probes: ProbeCache): Promise<Point> {
  const chain = sessionChain(session, target.frame);
  let point = local;
  for (let level = 0; level < chain.length; level++) {
    const {root, parent} = chain[level];
    const offset = await scrollOffset(session, root.sessionId);
    const hit = await session.cdp.send<{backendNodeId: number; frameId: string}>('DOM.getNodeForLocation',
      {x: Math.round(point.x + offset.x), y: Math.round(point.y + offset.y), includeUserAgentShadowDOM: true, ignorePointerEventsNone: false}, root.sessionId)
      .catch(() => null);
    if (!hit) throw new PageError('NOT_VISIBLE', `Элемент ${target.record.ref} не найден в точке клика.`);
    const hitFrame = session.frames.get(hit.frameId) ?? root;
    // At the target's own level the hit must be the target or inside it; above, it must be the iframe holding it.
    let expectedObject = target.objectId, expectedFrame = target.frame;
    if (level > 0) {
      const child = chain[level - 1].root;
      const owner = await session.cdp.send<{backendNodeId: number}>('DOM.getFrameOwner', {frameId: child.frameId}, root.sessionId);
      const ownerFrame = session.frames.get(child.parentFrameId!) ?? root;
      const ownerObject = await resolveNode(session, ownerFrame, owner.backendNodeId, probes);
      if (!ownerObject) throw new PageError('NOT_VISIBLE', 'Фрейм с элементом исчез.');
      expectedObject = ownerObject; expectedFrame = ownerFrame;
    }
    const hitObject = hitFrame.frameId === expectedFrame.frameId ? await resolveNode(session, hitFrame, hit.backendNodeId, probes) : null;
    const inside = hitObject ? await callOn<boolean>(session, expectedFrame, expectedObject,
      'function (other) { for (let n = other; n; n = n.parentNode || n.host) if (n === this) return true; return false; }', [{objectId: hitObject}]) : false;
    if (!inside) {
      const blockerObject = hitObject ?? await resolveNode(session, hitFrame, hit.backendNodeId, probes);
      const blocker = blockerObject ? await describe(session, hitFrame, blockerObject) : 'другой элемент';
      throw new PageError('COVERED', `Элемент ${target.record.ref} закрыт другим элементом: «${blocker}». Сначала закройте или уберите его.`);
    }
    if (!parent) return point;
    const {model} = await session.cdp.send<{model: {content: Quad}}>('DOM.getBoxModel',
      {backendNodeId: (await session.cdp.send<{backendNodeId: number}>('DOM.getFrameOwner', {frameId: root.frameId}, parent.sessionId)).backendNodeId}, parent.sessionId);
    const [width, height] = await probeEval<[number, number]>(session, root.frameId, probes, '[innerWidth, innerHeight]');
    point = toParent(point, model.content, {width, height});
  }
  return point;
}

/** Converts a quad from the target's session root viewport to the tab's viewport. */
async function toTop(session: PageSession, frame: FrameInfo, quad: Quad, probes: ProbeCache): Promise<Quad> {
  let q = quad;
  for (const {root, parent} of sessionChain(session, frame)) {
    if (!parent) return q;
    const owner = await session.cdp.send<{backendNodeId: number}>('DOM.getFrameOwner', {frameId: root.frameId}, parent.sessionId);
    const {model} = await session.cdp.send<{model: {content: Quad}}>('DOM.getBoxModel', {backendNodeId: owner.backendNodeId}, parent.sessionId);
    const [width, height] = await probeEval<[number, number]>(session, root.frameId, probes, '[innerWidth, innerHeight]');
    const points = [0, 1, 2, 3].map(i => toParent({x: q[i * 2], y: q[i * 2 + 1]}, model.content, {width, height}));
    q = points.flatMap(p => [p.x, p.y]);
  }
  return q;
}

async function checkOnce(session: PageSession, target: Target, needs: {pointer: boolean; editable?: boolean}, probes: ProbeCache): Promise<Actionable> {
  const {frame, objectId, record} = target;
  const connected = await callOn<boolean>(session, frame, objectId, 'function () { return this.isConnected; }');
  if (!connected) throw new PageError('REF_STALE', `Элемент ${record.ref} исчез со страницы: сделайте snapshot.`);
  const state = await callOn<ElementState>(session, frame, objectId, 'function () { return __assistant.elementState(this.nodeType === 1 ? this : this.parentElement); }');
  if (!state.visible) throw new PageError('NOT_VISIBLE', `Элемент ${record.ref} скрыт.`);
  if (state.disabled) throw new PageError('NOT_ENABLED', `Элемент ${record.ref} неактивен (disabled).`);
  if (needs.editable && (!state.editable || state.readonly)) throw new PageError('NOT_EDITABLE', `В элемент ${record.ref} нельзя вводить текст.`);

  await session.cdp.send('DOM.scrollIntoViewIfNeeded', {backendNodeId: record.backendNodeId}, frame.sessionId).catch(() => {});
  const first = await firstQuad(session, frame, record.backendNodeId);
  if (!first) throw new PageError('NOT_VISIBLE', `У элемента ${record.ref} нет видимой области.`);
  await sleep(STABLE_GAP_MS);
  const second = await firstQuad(session, frame, record.backendNodeId);
  if (!second || first.some((v, i) => Math.abs(v - second[i]) > STABLE_TOLERANCE_PX)) {
    throw new PageError('NOT_STABLE', `Элемент ${record.ref} ещё двигается.`);
  }
  const root = session.frames.sessionRoot(frame.frameId);
  const [width, height] = await probeEval<[number, number]>(session, root.frameId, probes, '[document.documentElement.clientWidth || innerWidth, document.documentElement.clientHeight || innerHeight]');
  const local = visibleCenter(second, {width, height});
  if (!local) throw new PageError('NOT_VISIBLE', `Элемент ${record.ref} за пределами экрана.`);
  const point = needs.pointer ? await hitTest(session, target, local, probes) : local;
  return {point, quad: await toTop(session, frame, second, probes)};
}

export async function waitActionable(session: PageSession, target: Target, needs: {pointer: boolean; editable?: boolean}, probes: ProbeCache): Promise<Actionable> {
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
