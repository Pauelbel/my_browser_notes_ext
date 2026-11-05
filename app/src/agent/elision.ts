// Keeps a long agent run within the context window: results of reading tools (page descriptions, page text, notes)
// older than the last few are replaced by a stub. The model can always look again; the user's messages and the
// receipts of actions stay as they are.
export const ELIDED = '[описание страницы скрыто — при необходимости сделайте snapshot]';
const READING_TOOLS = new Set(['snapshot', 'read', 'find', 'notes_read', 'notes_search', 'screenshot', 'console_log', 'network_log', 'page_checks']);

interface Part { type?: string; toolName?: string; output?: {type?: string; value?: unknown} }

export function elideOldPages<T>(messages: T[], keep = 3): T[] {
  const pages: [number, number][] = [];
  messages.forEach((m, i) => {
    const msg = m as {role?: string; content?: unknown};
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) return;
    (msg.content as Part[]).forEach((part, j) => {
      if (part.toolName && READING_TOOLS.has(part.toolName) && typeof part.output?.value === 'string') pages.push([i, j]);
    });
  });
  const drop = new Set(pages.slice(0, Math.max(0, pages.length - keep)).map(([i, j]) => `${i}:${j}`));
  if (!drop.size) return messages;
  return messages.map((m, i) => {
    const msg = m as {role?: string; content?: Part[]};
    if (msg.role !== 'tool' || !Array.isArray(msg.content) || !msg.content.some((_, j) => drop.has(`${i}:${j}`))) return m;
    return {...msg, content: msg.content.map((part, j) => drop.has(`${i}:${j}`) ? {...part, output: {...part.output, type: 'text', value: ELIDED}} : part)} as T;
  });
}

const IMAGE_TOKENS = 1000;

/** A rough size of a history in tokens: 4 characters a token, an image counted as 1000. */
export function estimateTokens(messages: unknown[]): number {
  let chars = 0, images = 0;
  const part = (p: unknown) => {
    if (typeof p === 'string') { chars += p.length; return; }
    const x = p as {type?: string; text?: string; output?: {value?: unknown}; input?: unknown};
    if (x.type === 'image') { images++; return; }
    if (typeof x.text === 'string') chars += x.text.length;
    if (typeof x.output?.value === 'string') chars += x.output.value.length;
    if (x.input !== undefined) chars += JSON.stringify(x.input).length;
  };
  for (const m of messages) {
    const content = (m as {content?: unknown}).content;
    if (Array.isArray(content)) content.forEach(part); else part(content);
  }
  return Math.ceil(chars / 4) + images * IMAGE_TOKENS;
}

/** Receipts of actions older than the last `keep` are cut to their first line (what was done, without the diff). */
function shortenOldReceipts<T>(messages: T[], keep: number): T[] {
  const receipts: [number, number][] = [];
  messages.forEach((m, i) => {
    const msg = m as {role?: string; content?: unknown};
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) return;
    (msg.content as Part[]).forEach((p, j) => {
      if (p.toolName && !READING_TOOLS.has(p.toolName) && typeof p.output?.value === 'string') receipts.push([i, j]);
    });
  });
  const cut = new Set(receipts.slice(0, Math.max(0, receipts.length - keep)).map(([i, j]) => `${i}:${j}`));
  if (!cut.size) return messages;
  return messages.map((m, i) => {
    const msg = m as {content?: Part[]};
    if (!Array.isArray(msg.content) || !msg.content.some((_, j) => cut.has(`${i}:${j}`))) return m;
    return {...msg, content: msg.content.map((p, j) => {
      if (!cut.has(`${i}:${j}`)) return p;
      const lines = String(p.output!.value).split('\n').filter(l => !l.startsWith('<<<'));
      return {...p, output: {...p.output, value: `${lines[0] ?? ''} [подробности скрыты]`}};
    })} as T;
  });
}

/** Keeps a run's history under 70 % of the context window, hiding more of the old results step by step. */
export function fitToContext<T>(messages: T[], contextTokens: number): T[] {
  const limit = 0.7 * contextTokens;
  if (estimateTokens(messages) <= limit) return messages;
  const levels = [(m: T[]) => elideOldPages(m, 3), (m: T[]) => elideOldPages(m, 1), (m: T[]) => shortenOldReceipts(elideOldPages(m, 1), 10)];
  let out = messages;
  for (const level of levels) {
    out = level(messages);
    if (estimateTokens(out) <= limit) return out;
  }
  return out;
}
