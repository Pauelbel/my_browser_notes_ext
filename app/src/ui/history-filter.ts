// The Recent list's search: case-insensitive, ё equals е, newest first.
import type {Conversation} from '../store/types.ts';

const fold = (text: string) => text.toLocaleLowerCase('ru').replaceAll('ё', 'е');

export function filterConversations(list: Conversation[], query: string): Conversation[] {
  const q = fold(query.trim());
  return list.filter(c => !q || fold(c.title).includes(q)).sort((a, b) => b.updatedAt - a.updatedAt);
}
