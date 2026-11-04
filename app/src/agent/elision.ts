// Keeps a long agent run within the context window: page descriptions older than the last few are replaced by a stub.
// The model can always look again; the user's messages and the agent's receipts stay as they are.
export const ELIDED = '[описание страницы скрыто — при необходимости сделайте snapshot]';
const PAGE_START = '<<<page-content>>>';

interface Part { type?: string; output?: {type?: string; value?: unknown} }

export function elideOldPages<T>(messages: T[], keep = 3): T[] {
  const pages: [number, number][] = [];
  messages.forEach((m, i) => {
    const msg = m as {role?: string; content?: unknown};
    if (msg.role !== 'tool' || !Array.isArray(msg.content)) return;
    (msg.content as Part[]).forEach((part, j) => {
      if (typeof part.output?.value === 'string' && part.output.value.includes(PAGE_START)) pages.push([i, j]);
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
