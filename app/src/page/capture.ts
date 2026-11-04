// A raw capture of a tab: the accessibility tree of every frame in its own session, and one layout snapshot
// (DOMSnapshot) per session. A frame that fails is reported, not fatal; so is a failed layout snapshot.
import type {AXNode} from './ax.ts';
import type {PageSession} from './session.ts';

export interface FrameCapture {
  frameId: string;
  sessionId?: string;
  parentFrameId?: string;
  url: string;
  loaderId: string;
  nodes: AXNode[];
  status: 'captured' | 'failed';
  reason?: string;
}

export interface Capture {
  url: string;
  title: string;
  frames: FrameCapture[];
  /** DOMSnapshot.captureSnapshot results by session id ('' for the tab's own session). */
  layout: Record<string, unknown>;
  viewport: {width: number; height: number; scrollY: number; pageHeight: number};
  layoutError?: string;
}

export const LAYOUT_STYLES = ['display', 'visibility', 'opacity', 'cursor', 'pointer-events', 'overflow-x', 'overflow-y'];
const COMMAND_TIMEOUT_MS = 8000;

export async function capture(session: PageSession): Promise<Capture> {
  const {cdp, frames} = session;
  const list = frames.list().filter(f => f.url && !f.url.startsWith('about:blank') || !f.parentFrameId);
  const sessions = [...new Set(list.map(f => f.sessionId ?? ''))];

  const layoutPromise = Promise.all(sessions.map(async key => {
    const snapshot = await cdp.send('DOMSnapshot.captureSnapshot', {computedStyles: LAYOUT_STYLES, includeDOMRects: true}, key || undefined, COMMAND_TIMEOUT_MS);
    return [key, snapshot] as const;
  })).then(entries => ({layout: Object.fromEntries(entries)}), error => ({layout: {}, layoutError: error instanceof Error ? error.message : String(error)}));

  const captured: FrameCapture[] = await Promise.all(list.map(async frame => {
    const base = {frameId: frame.frameId, sessionId: frame.sessionId, parentFrameId: frame.parentFrameId, url: frame.url, loaderId: frame.loaderId};
    try {
      const {nodes} = await cdp.send<{nodes: AXNode[]}>('Accessibility.getFullAXTree', {frameId: frame.frameId}, frame.sessionId, COMMAND_TIMEOUT_MS);
      return {...base, nodes, status: 'captured' as const};
    } catch (error) {
      return {...base, nodes: [], status: 'failed' as const, reason: error instanceof Error ? error.message : String(error)};
    }
  }));

  const metrics = await cdp.send<{cssLayoutViewport: {pageY: number; clientWidth: number; clientHeight: number}; cssContentSize: {height: number}}>('Page.getLayoutMetrics');
  const {layout, layoutError} = await layoutPromise as {layout: Record<string, unknown>; layoutError?: string};
  const main = captured.find(f => !f.parentFrameId) ?? captured[0];
  const root = main?.nodes.find(n => n.role?.value === 'RootWebArea');
  return {
    url: main?.url ?? '',
    title: typeof root?.name?.value === 'string' ? root.name.value : '',
    frames: captured,
    layout,
    layoutError,
    viewport: {
      width: Math.round(metrics.cssLayoutViewport.clientWidth),
      height: Math.round(metrics.cssLayoutViewport.clientHeight),
      scrollY: Math.round(metrics.cssLayoutViewport.pageY),
      pageHeight: Math.round(metrics.cssContentSize.height),
    },
  };
}
