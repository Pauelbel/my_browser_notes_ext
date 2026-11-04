// The outline as text within a budget: around the visible part of the page by default, labels only on what is
// shown, and every omission stated.
import type {Capture} from './capture.ts';
import type {ONode} from './outline.ts';
import type {RefRegistry} from './refs.ts';

export type WindowMode = 'near' | 'all';
export type OutlineMode = 'interactive' | 'all';

const VALUE_MAX = 200;
const KEEP_IN_INTERACTIVE = new Set(['heading', 'Iframe', 'dialog', 'alertdialog']);

/** A share of the model's context window for one page description: 20 %, at 4 characters a token. */
export function pageBudget(contextTokens: number): number {
  return Math.max(2000, Math.min(30000, Math.round(contextTokens * 4 * 0.2)));
}

function quote(text: string, max = Infinity): string {
  const cut = text.length > max ? `${text.slice(0, max)}…` : text;
  return `"${cut.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

export function renderLine(n: ONode): string {
  if (n.kind === 'text') return `text ${quote(n.name)}`;
  let line = n.ref ? `[${n.ref}] ${n.role}` : n.role;
  if (n.name) line += ` ${quote(n.name)}`;
  if (n.states.length) line += ` (${n.states.join(', ')})`;
  if (n.masked) line += n.value ? ` = ${quote(n.value)} (скрыто)` : ' (скрыто)';
  else if (n.value !== undefined) line += ` = ${quote(n.value, VALUE_MAX)}`;
  return line;
}

export function header(capture: Capture): string {
  const {scrollY, height, pageHeight} = capture.viewport;
  return `${capture.title} · ${capture.url} · видно ${scrollY}–${scrollY + height} из ${pageHeight} px`;
}

interface Row { node: ONode; depth: number }

function flatten(roots: ONode[], mode: OutlineMode): Row[] {
  const rows: Row[] = [];
  const walk = (nodes: ONode[], depth: number) => {
    for (const n of nodes) {
      const keep = mode === 'all' || n.interactive || KEEP_IN_INTERACTIVE.has(n.role);
      if (keep) rows.push({node: n, depth});
      walk(n.children, keep ? depth + 1 : depth);
    }
  };
  walk(roots, 0);
  return rows;
}

export function render(roots: ONode[], refs: RefRegistry, opts: {mode: OutlineMode; window: WindowMode; budget: number; viewport: Capture['viewport']}):
  {body: string; notices: string[]; shown: string[]} {
  const {scrollY, height} = opts.viewport;
  const notices: string[] = [];
  let rows = flatten(roots, opts.mode);

  if (opts.window === 'near') {
    const start = scrollY - height, end = scrollY + 2 * height;
    let above = 0, below = 0;
    rows = rows.filter(({node}) => {
      if (node.y === undefined || (node.y >= start && node.y <= end)) return true;
      if (node.y < start) above++; else below++;
      return false;
    });
    if (above) notices.push(`Выше ещё ${above} элементов: прокрутите вверх или вызовите snapshot с window="all".`);
    if (below) notices.push(`Ниже ещё ${below} элементов: прокрутите вниз или вызовите snapshot с window="all".`);
  }

  // Lines are measured as they will print; labels go only to what fits, nearest to the screen first.
  // Distance from the visible part: zero on screen, else to the nearer edge. Ties drop the lower line first.
  const distance = (n: ONode) => (n.y === undefined ? 0 : n.y < scrollY ? scrollY - n.y : Math.max(0, n.y - (scrollY + height)));
  const lengthOf = ({node, depth}: Row) => depth * 2 + renderLine({...node, ref: node.interactive ? `${refs.epoch}0000` : undefined}).length + 1;
  let total = rows.reduce((sum, row) => sum + lengthOf(row), 0);
  if (total > opts.budget) {
    const all = rows.length;
    const byDistance = [...rows].sort((a, b) => distance(b.node) - distance(a.node) || (b.node.y ?? 0) - (a.node.y ?? 0));
    const dropped = new Set<Row>();
    for (const row of byDistance) {
      if (total <= opts.budget) break;
      dropped.add(row);
      total -= lengthOf(row);
    }
    rows = rows.filter(row => !dropped.has(row));
    notices.push(`Описание урезано до бюджета: показано ${rows.length} из ${all} строк. Уточните запрос через find или read.`);
  }

  const shown: string[] = [];
  const lines = rows.map(({node, depth}) => {
    if (node.interactive && node.backendNodeId !== undefined) shown.push(refs.assign(node));
    return `${'  '.repeat(depth)}${renderLine(node)}`;
  });
  return {body: lines.join('\n'), notices, shown};
}
