// A conversation title from the user's first message: its start, on one line.
export const TITLE_LENGTH = 60;

export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (!line) return 'Новый чат';
  if (line.length <= TITLE_LENGTH) return line;
  return `${line.slice(0, TITLE_LENGTH - 1).trimEnd()}…`;
}
