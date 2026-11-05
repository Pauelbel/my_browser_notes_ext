// DOMSnapshot.captureSnapshot decoded per session into nodes keyed by backendNodeId: tag, attributes, box,
// whether it is rendered, and whether it reacts to clicks (a click listener, or the top of a cursor:pointer area).
import {LAYOUT_STYLES} from './capture.ts';

export interface Box { x: number; y: number; width: number; height: number }

export interface LayoutNode {
  backendNodeId: number;
  tag: string;
  attrs: Record<string, string>;
  /** backendNodeId of the parent in the same document, or -1. */
  parent: number;
  bounds?: Box;
  rendered: boolean;
  /** The whole subtree is hidden: display:none, visibility:hidden, opacity 0, or a zero-size box that clips its overflow.
   *  A box that is merely empty (a body of height 0 whose content is positioned, display:contents) is not hidden. */
  hidden: boolean;
  /** A click listener, or the topmost element of a cursor:pointer area (the cursor is inherited by children). */
  clickable: boolean;
  text?: string;
}

interface RawDocument {
  nodes: {
    parentIndex: number[]; nodeType: number[]; nodeName: number[]; nodeValue: number[]; backendNodeId: number[];
    attributes: number[][]; isClickable?: {index: number[]};
  };
  layout: {nodeIndex: number[]; styles: number[][]; bounds: number[][]};
}
interface RawSnapshot { documents: RawDocument[]; strings: string[] }

const STYLE = Object.fromEntries(LAYOUT_STYLES.map((name, i) => [name, i]));

/** All nodes of one session's snapshot (its documents share one backendNodeId space). */
export function decodeSnapshot(raw: unknown): Map<number, LayoutNode> {
  const out = new Map<number, LayoutNode>();
  const snapshot = raw as RawSnapshot | undefined;
  if (!snapshot?.documents) return out;
  const str = (i: number) => (i >= 0 ? snapshot.strings[i] : '');
  for (const doc of snapshot.documents) {
    const n = doc.nodes;
    const layoutOf = new Map<number, number>();
    doc.layout.nodeIndex.forEach((nodeIndex, li) => layoutOf.set(nodeIndex, li));
    const clickListener = new Set(n.isClickable?.index ?? []);
    const pointer: boolean[] = [];
    for (let i = 0; i < n.backendNodeId.length; i++) {
      const li = layoutOf.get(i);
      const styles = li === undefined ? undefined : doc.layout.styles[li];
      const style = (name: string) => (styles ? str(styles[STYLE[name]]) : '');
      const b = li === undefined ? undefined : doc.layout.bounds[li];
      const bounds = b ? {x: b[0], y: b[1], width: b[2], height: b[3]} : undefined;
      pointer[i] = style('cursor') === 'pointer';
      const attrs: Record<string, string> = {};
      const list = n.attributes[i] ?? [];
      for (let a = 0; a + 1 < list.length; a += 2) attrs[str(list[a]).toLowerCase()] = str(list[a + 1]);
      const parentIndex = n.parentIndex[i];
      const rendered = Boolean(bounds && bounds.width * bounds.height > 0)
        && style('display') !== 'none' && !['hidden', 'collapse'].includes(style('visibility')) && style('opacity') !== '0';
      const isElement = n.nodeType[i] === 1;
      const tag = str(n.nodeName[i]).toLowerCase();
      const clips = (axis: string) => !['', 'visible'].includes(style(axis));
      // The overflow of html and body goes to the viewport, so they never clip their own content.
      const clipsToNothing = Boolean(bounds) && !['html', 'body'].includes(tag)
        && ((bounds!.width === 0 && clips('overflow-x')) || (bounds!.height === 0 && clips('overflow-y')));
      const styleHidden = style('display') === 'none' || ['hidden', 'collapse'].includes(style('visibility')) || style('opacity') === '0';
      out.set(n.backendNodeId[i], {
        backendNodeId: n.backendNodeId[i],
        tag,
        attrs,
        parent: parentIndex >= 0 ? n.backendNodeId[parentIndex] : -1,
        bounds,
        rendered,
        hidden: isElement && (styleHidden || clipsToNothing),
        clickable: isElement && (clickListener.has(i) || (pointer[i] && !(parentIndex >= 0 && pointer[parentIndex]))),
        text: n.nodeType[i] === 3 ? str(n.nodeValue[i]) : undefined,
      });
    }
  }
  return out;
}
