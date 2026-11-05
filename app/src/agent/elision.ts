// Keeps a long agent run within the context window: results of reading tools (page descriptions, page text, notes)
// older than the last few are replaced by a stub. The model can always look again; the user's messages and the
// receipts of actions stay as they are.
export const ELIDED = '[описание страницы скрыто — при необходимости сделайте snapshot]';
/** Results that go stale: page descriptions and notes. Hidden beyond the last few at every step. */
const PAGE_TOOLS = new Set(['snapshot', 'read', 'find', 'notes_read', 'notes_search', 'screenshot']);
/** QA findings are evidence for the report: hidden only when the history would not fit otherwise. */
const QA_TOOLS = new Set(['console_log', 'network_log', 'page_checks']);
const READING_TOOLS = new Set([...PAGE_TOOLS, ...QA_TOOLS]);

interface Part { type?: string; toolName?: string; output?: {type?: string; value?: unknown} }

export function elideOldPages<T>(messages: T[], keep = 3, kinds: Set<string> = PAGE_TOOLS): T[] {
  const pages: [number, number][] = [];
  messages.forEach((m, i) => {
    const msg = m as {role?: string; content?: unknown};
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) return;
    (msg.content as Part[]).forEach((part, j) => {
      if (part.toolName && kinds.has(part.toolName) && typeof part.output?.value === 'string') pages.push([i, j]);
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

const HIDDEN = ' [подробности скрыты]';

/** Receipts of actions older than the last `keep` are cut to their first line (what was done, without the diff);
 * the page-content markers stay around it, and a receipt cut before is left as it is. */
function shortenOldReceipts<T>(messages: T[], keep: number): T[] {
  const receipts: [number, number][] = [];
  messages.forEach((m, i) => {
    const msg = m as {role?: string; content?: unknown};
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) return;
    (msg.content as Part[]).forEach((p, j) => {
      if (p.toolName && !READING_TOOLS.has(p.toolName) && typeof p.output?.value === 'string' && !p.output.value.includes(HIDDEN)) receipts.push([i, j]);
    });
  });
  const cut = new Set(receipts.slice(0, Math.max(0, receipts.length - keep)).map(([i, j]) => `${i}:${j}`));
  if (!cut.size) return messages;
  return messages.map((m, i) => {
    const msg = m as {content?: Part[]};
    if (!Array.isArray(msg.content) || !msg.content.some((_, j) => cut.has(`${i}:${j}`))) return m;
    return {...msg, content: msg.content.map((p, j) => {
      if (!cut.has(`${i}:${j}`)) return p;
      const value = String(p.output!.value);
      const lines = value.split('\n').filter(l => !l.startsWith('<<<'));
      const marked = value.includes('<<<page-content>>>');
      const kept = `${lines[0] ?? ''}${HIDDEN}`;
      return {...p, output: {...p.output, value: marked ? `<<<page-content>>>\n${kept}\n<<<end-page-content>>>` : kept}};
    })} as T;
  });
}

/** Reasoning parts are dropped from all assistant messages but the last `keep`: the model does not need old thoughts. */
function dropOldReasoning<T>(messages: T[], keep: number): T[] {
  const idx = messages.map((m, i) => ((m as {role?: string}).role === 'assistant' && Array.isArray((m as {content?: unknown}).content) ? i : -1)).filter(i => i >= 0);
  const old = new Set(idx.slice(0, Math.max(0, idx.length - keep)));
  if (!old.size) return messages;
  return messages.map((m, i) => {
    if (!old.has(i)) return m;
    const msg = m as {content: {type?: string}[]};
    const content = msg.content.filter(p => p.type !== 'reasoning');
    return content.length === msg.content.length ? m : ({...msg, content} as T);
  });
}

/** Plain-text assistant messages (earlier replies of the chat) but the last are cut to one line. */
function shortenOldReplies<T>(messages: T[]): T[] {
  const idx = messages.map((m, i) => ((m as {role?: string; content?: unknown}).role === 'assistant' && typeof (m as {content?: unknown}).content === 'string' ? i : -1)).filter(i => i >= 0);
  idx.pop();
  if (!idx.length) return messages;
  return messages.map((m, i) => {
    if (!idx.includes(i)) return m;
    const text = (m as {content: string}).content;
    return text.length > 120 ? ({...(m as object), content: `${text.slice(0, 119)}…[сокращено]`} as T) : m;
  });
}

/** The oldest steps (an assistant message with tool calls and the tool message answering it) but the last `keep`
 * are replaced by one line naming them; a call is never left without its result. */
function collapseOldSteps<T>(messages: T[], keep: number): T[] {
  const pairs: number[] = [];
  messages.forEach((m, i) => {
    const msg = m as {role?: string; content?: unknown};
    const next = messages[i + 1] as {role?: string} | undefined;
    if (msg.role === 'assistant' && Array.isArray(msg.content) && (msg.content as {type?: string}[]).some(p => p.type === 'tool-call') && next?.role === 'tool') pairs.push(i);
  });
  const drop = pairs.slice(0, Math.max(0, pairs.length - keep));
  if (!drop.length) return messages;
  const names = drop.flatMap(i => ((messages[i] as {content: {type?: string; toolName?: string}[]}).content).filter(p => p.type === 'tool-call').map(p => p.toolName));
  const gone = new Set(drop.flatMap(i => [i, i + 1]));
  const out: T[] = [];
  messages.forEach((m, i) => {
    if (i === drop[0]) out.push({role: 'assistant', content: `Ранее выполненные шаги (подробности скрыты): ${names.join(' · ')}`} as T);
    if (!gone.has(i)) out.push(m);
  });
  return out;
}

/** Keeps a run's history under 70 % of the given window, hiding more of the old results step by step. Old page
 * descriptions are always hidden beyond the last three: their labels are no longer valid anyway. */
export function fitToContext<T>(messages: T[], contextTokens: number): T[] {
  const limit = 0.7 * contextTokens;
  const levels: ((m: T[]) => T[])[] = [
    m => elideOldPages(m, 3),
    m => elideOldPages(m, 1),
    m => shortenOldReceipts(elideOldPages(m, 1), 10),
    m => elideOldPages(dropOldReasoning(shortenOldReceipts(elideOldPages(m, 1), 10), 2), 3, QA_TOOLS),
    m => shortenOldReplies(elideOldPages(dropOldReasoning(shortenOldReceipts(elideOldPages(m, 1), 10), 2), 3, QA_TOOLS)),
    m => collapseOldSteps(shortenOldReplies(elideOldPages(dropOldReasoning(shortenOldReceipts(elideOldPages(m, 1), 10), 2), 3, QA_TOOLS)), 10),
  ];
  let out = messages;
  for (const level of levels) {
    out = level(messages);
    if (estimateTokens(out) <= limit) return out;
  }
  return out;
}
