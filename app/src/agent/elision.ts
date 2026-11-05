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
