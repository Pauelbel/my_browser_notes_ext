// The page as an outline the model can read: the accessibility tree of every frame, cleaned up (structural wrappers
// collapse, repeated text goes), joined with layout (what is hidden is dropped, clickable divs are added),
// with states and values, secrets masked, and every iframe stitched under its own node.
import {cleanText, nameOf, property, roleOf, valueOf, type AXNode} from './ax.ts';
import type {Capture, FrameCapture} from './capture.ts';
import {decodeSnapshot, type LayoutNode} from './layout.ts';
import {isSecretField, MASK} from './masking.ts';

export interface ONode {
  role: string;
  name: string;
  value?: string;
  states: string[];
  children: ONode[];
  kind: 'element' | 'text';
  frameId: string;
  sessionId?: string;
  backendNodeId?: number;
  loaderId: string;
  interactive: boolean;
  masked?: boolean;
  /** The node stands for a hidden control and points at its visible label, which is what gets clicked. */
  proxy?: 'label';
  /** Link target, for read(). */
  href?: string;
  /** Heading level, for read(). */
  level?: number;
  /** Top of the box in page coordinates (child frames offset by their iframe). */
  y?: number;
  ref?: string;
  /** Text fingerprint of the nearest repeated record, guarding refs in virtualized lists. */
  recordContext?: string;
}

export const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'slider', 'spinbutton', 'switch', 'tab', 'treeitem', 'DisclosureTriangle',
]);
const VALUE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider']);
const TEXT_FIELDS = new Set(['textbox', 'searchbox', 'spinbutton', 'combobox']);
const TRANSPARENT = new Set([
  'generic', 'none', 'presentation', 'group', 'LabelText', 'cell', 'gridcell', 'paragraph', 'Section', 'Div', 'rowgroup',
  'Abbr', 'Ruby', 'time', 'emphasis', 'strong', 'subscript', 'superscript', 'Pre', 'code', 'mark', 'blockquote',
]);
const SKIP = new Set(['InlineTextBox', 'LineBreak', 'ListMarker']);
const OVERLAY_ATTR = 'data-assistant-overlay';
const CLICKABLE_NAME_MAX = 80;

function states(ax: AXNode): string[] {
  const out: string[] = [];
  if (property(ax, 'disabled') === true) out.push('disabled');
  const checked = property(ax, 'checked');
  if (checked === 'true' || checked === true) out.push('checked');
  if (checked === 'mixed') out.push('mixed');
  if (property(ax, 'selected') === true) out.push('selected');
  const expanded = property(ax, 'expanded');
  if (expanded === true) out.push('expanded');
  if (expanded === false) out.push('collapsed');
  if (property(ax, 'focused') === true && roleOf(ax) !== 'RootWebArea') out.push('focused');
  if (property(ax, 'required') === true) out.push('required');
  if (property(ax, 'readonly') === true) out.push('readonly');
  return out;
}

const hasInteractive = (nodes: ONode[]): boolean => nodes.some(n => n.interactive || hasInteractive(n.children));

function textOf(nodes: ONode[]): string {
  return cleanText(nodes.map(n => (n.kind === 'text' ? n.name : n.name || textOf(n.children))).join(' '));
}

/** Joins adjacent text nodes; drops text that only repeats the parent's name or a neighbouring control's (its label). */
function tidy(children: ONode[], parentName: string): ONode[] {
  const out: ONode[] = [];
  for (const child of children) {
    if (child.kind === 'text' && child.name === parentName) continue;
    const last = out[out.length - 1];
    if (child.kind === 'text' && last?.kind === 'text') last.name = cleanText(`${last.name} ${child.name}`);
    else out.push(child);
  }
  return out.filter((node, i) => node.kind !== 'text'
    || ![out[i - 1], out[i + 1]].some(next => next?.kind === 'element' && next.interactive && next.name === node.name));
}

interface Context {
  capture: Capture;
  layouts: Map<string, Map<number, LayoutNode>>;
  notices: string[];
  stitched: Set<string>;
}

function buildFrame(frame: FrameCapture, offsetY: number, ctx: Context): ONode[] {
  if (frame.status !== 'captured') {
    ctx.notices.push(`Фрейм ${frame.url} не снят: ${frame.reason ?? 'неизвестная причина'}.`);
    return [];
  }
  const layout = ctx.layouts.get(frame.sessionId ?? '');
  const byId = new Map(frame.nodes.map(n => [n.nodeId, n]));
  const lay = (ax: AXNode) => (ax.backendDOMNodeId !== undefined ? layout?.get(ax.backendDOMNodeId) : undefined);

  // Hidden native checkboxes and radios are shown through their visible label, which is what a person clicks.
  const labelFor = new Map<number, LayoutNode>();
  const consumedLabels = new Set<number>();
  if (layout) {
    const labelsById = new Map<string, LayoutNode>();
    for (const node of layout.values()) if (node.tag === 'label' && node.attrs.for && node.rendered) labelsById.set(node.attrs.for, node);
    for (const ax of frame.nodes) {
      const role = roleOf(ax);
      const own = lay(ax);
      if ((role !== 'checkbox' && role !== 'radio') || !own || own.rendered) continue;
      let label = own.attrs.id ? labelsById.get(own.attrs.id) : undefined;
      for (let p = own.parent; !label && p >= 0; p = layout.get(p)?.parent ?? -1) {
        const ancestor = layout.get(p);
        if (ancestor?.tag === 'label' && ancestor.rendered) label = ancestor;
      }
      if (label) { labelFor.set(own.backendNodeId, label); consumedLabels.add(label.backendNodeId); }
    }
  }

  const base = (ax: AXNode) => ({frameId: frame.frameId, sessionId: frame.sessionId, loaderId: frame.loaderId, backendNodeId: ax.backendDOMNodeId});
  const yOf = (node?: LayoutNode) => (node?.bounds ? Math.round(node.bounds.y + offsetY) : undefined);

  function convert(ax: AXNode, insideInteractive: boolean): ONode[] {
    const own = lay(ax);
    if (own?.attrs[OVERLAY_ATTR] !== undefined) return [];
    const role = roleOf(ax);
    if (SKIP.has(role)) return [];
    const kids = (inside: boolean) => (ax.childIds ?? []).flatMap(id => { const child = byId.get(id); return child ? convert(child, inside) : []; });
    if (ax.ignored) return kids(insideInteractive);

    if (role === 'StaticText') {
      if (own && !own.rendered) return [];
      const text = cleanText(nameOf(ax));
      return text ? [{...base(ax), kind: 'text', role: 'text', name: text, states: [], children: [], interactive: false, y: yOf(own)}] : [];
    }
    if (role === 'Iframe') {
      const child = ctx.capture.frames.find(f => f.ownerBackendNodeId === ax.backendDOMNodeId && f.parentFrameId
        && (ctx.capture.frames.find(p => p.frameId === f.parentFrameId)?.sessionId ?? '') === (frame.sessionId ?? ''));
      if (child) ctx.stitched.add(child.frameId);
      const children = child ? buildFrame(child, yOf(own) ?? offsetY, ctx) : [];
      return [{...base(ax), kind: 'element', role: 'Iframe', name: cleanText(nameOf(ax)), states: [], children, interactive: false, y: yOf(own)}];
    }
    if (consumedLabels.has(ax.backendDOMNodeId ?? -1)) return [];

    const label = own ? labelFor.get(own.backendNodeId) : undefined;
    // A box with no area of its own hides its subtree only when it is hidden or clips; otherwise (a body of height 0
    // laid out by positioned children, display:contents) it stays for whatever visible content it holds.
    const noBox = Boolean(own && !own.rendered && !label);
    if (noBox && own!.hidden) return [];

    const name = cleanText(nameOf(ax));
    const interactiveRole = INTERACTIVE_ROLES.has(role);
    const children = kids(insideInteractive || interactiveRole);
    if (noBox && children.length === 0) return [];
    if (!own && children.length === 0 && !interactiveRole) return [];
    // A clickable element (click listener or pointer area) that holds no control of its own becomes one target;
    // one that wraps controls (a label around an input, a card with buttons) stays a container for them.
    const becomesClickable = !noBox && !interactiveRole && !insideInteractive && Boolean(own?.clickable) && role !== 'RootWebArea'
      && !['html', 'body'].includes(own?.tag ?? '') && !hasInteractive(children);

    if (becomesClickable) {
      // The name is short for the label line; the full text stays as children, so reading the page loses nothing.
      const full = name || textOf(children);
      const short = full.length > CLICKABLE_NAME_MAX ? `${full.slice(0, CLICKABLE_NAME_MAX - 1).trimEnd()}…` : full;
      return [{...base(ax), kind: 'element', role: 'clickable', name: short, states: [], children: tidy(children, short), interactive: true, y: yOf(own)}];
    }

    const node: ONode = {...base(ax), kind: 'element', role, name, states: states(ax), children, interactive: interactiveRole, y: yOf(own)};
    if (role === 'link' && own?.attrs.href) node.href = own.attrs.href;
    if (role === 'heading') node.level = Number(property(ax, 'level')) || 2;
    if (label) {
      node.backendNodeId = label.backendNodeId;
      node.proxy = 'label';
      node.y = yOf(label);
    }
    if (VALUE_ROLES.has(role)) {
      node.children = [];
      const value = valueOf(ax);
      // Without layout the field's attributes are unknown: its value is masked rather than risked.
      if (TEXT_FIELDS.has(role) && (!own || isSecretField(own.attrs))) {
        node.masked = true;
        node.value = value ? MASK : undefined;
      } else if (value !== undefined) {
        node.value = value;
      }
      return [node];
    }
    if (TRANSPARENT.has(role) && !name) return tidy(children, '');
    node.children = tidy(children, name);
    return [node];
  }

  const root = frame.nodes.find(n => roleOf(n) === 'RootWebArea' && !n.parentId) ?? frame.nodes[0];
  if (!root) return [];
  const rootChildren = (root.childIds ?? []).flatMap(id => { const child = byId.get(id); return child ? convert(child, false) : []; });
  return tidy(rootChildren, cleanText(nameOf(root)));
}

export function buildOutline(capture: Capture): {roots: ONode[]; notices: string[]} {
  const layouts = new Map(Object.entries(capture.layout ?? {}).map(([key, raw]) => [key, decodeSnapshot(raw)]));
  const ctx: Context = {capture, layouts, notices: [], stitched: new Set()};
  if (capture.layoutError) ctx.notices.push(`Геометрия страницы недоступна (${capture.layoutError}): видимость элементов не проверена.`);
  const main = capture.frames.find(f => !f.parentFrameId) ?? capture.frames[0];
  if (!main) return {roots: [], notices: ['Страница не снята.']};
  const roots = buildFrame(main, 0, ctx);
  // Frames whose iframe could not be found in the tree still get shown, at the end.
  for (const frame of capture.frames) {
    if (frame === main || ctx.stitched.has(frame.frameId)) continue;
    const children = buildFrame(frame, 0, ctx);
    if (children.length) roots.push({kind: 'element', role: 'Iframe', name: frame.url, states: [], children, interactive: false, frameId: frame.frameId, sessionId: frame.sessionId, loaderId: frame.loaderId});
  }
  annotateRecordContexts(roots);
  return {roots, notices: ctx.notices};
}

const RECORD_ROLES = new Set(['row', 'listitem', 'article', 'treeitem']);
const contextText = (node: ONode): string => cleanText([node.name, node.value ?? '', ...node.children.map(contextText)].join(' ')).slice(0, 240);

/** A ref inside a list record must not silently follow a recycled DOM node into another record. */
function annotateRecordContexts(nodes: ONode[], inherited = ''): void {
  for (const node of nodes) {
    const context = RECORD_ROLES.has(node.role) ? contextText(node) : inherited;
    if (node.interactive && context) node.recordContext = context;
    annotateRecordContexts(node.children, context);
  }
}
