// The user's notes as agent tools: search, read, create, append text or add tags. They use the notes database of version 1.0 through
// its own module, so the notes UI sees every change at once. Note text is the user's data, not instructions.
// @ts-ignore: plain JS modules of the notes UI
import {open, loadAll, createNote, putNote} from '../../db.js';
// @ts-ignore: plain JS modules of the notes UI
import {folderPath, matches, noteTitle, parseTags} from '../../tree.js';

interface Note { id: string; title: string; body: string; tags: string[]; folderId: string | null; updated: number }
interface Folder { id: string; name: string; parentId: string | null }

export const NOTE_START = '<<<note>>>';
export const NOTE_END = '<<<end-note>>>';
const SEARCH_MAX = 20;
const BODY_MAX = 20000;

const neutralize = (text: string) => text.replace(/<{3,}/g, '‹‹‹').replace(/>{3,}/g, '›››');

async function all(): Promise<{notes: Note[]; folders: Folder[]}> {
  await open();
  return loadAll();
}

const pathOf = (folders: Folder[], id: string | null) => (folderPath(folders, id) as string[]).join(' / ') || 'без папки';

export async function notesSearch(query: string): Promise<string> {
  const {notes, folders} = await all();
  const found = notes.filter(n => matches(n, query)).sort((a, b) => b.updated - a.updated);
  if (!found.length) return `Ничего не найдено по «${query}».`;
  const lines = found.slice(0, SEARCH_MAX).map(n => `${n.id} · ${pathOf(folders, n.folderId)} / ${noteTitle(n)}${n.tags.length ? ` · #${n.tags.join(' #')}` : ''}`);
  if (found.length > SEARCH_MAX) lines.push(`… и ещё ${found.length - SEARCH_MAX}`);
  return `${NOTE_START}\n${neutralize(lines.join('\n'))}\n${NOTE_END}`;
}

export async function notesRead(id: string): Promise<string> {
  const {notes, folders} = await all();
  const note = notes.find(n => n.id === id);
  if (!note) throw new Error(`Заметка ${id} не найдена: найдите её через notes_search.`);
  const body = note.body.length > BODY_MAX ? `${note.body.slice(0, BODY_MAX)}\n…(обрезано: ${note.body.length} символов)` : note.body;
  const head = `${noteTitle(note)} · ${pathOf(folders, note.folderId)}${note.tags.length ? ` · #${note.tags.join(' #')}` : ''}`;
  return `${NOTE_START}\n${neutralize(`${head}\n\n${body}`)}\n${NOTE_END}`;
}

export async function notesCreate(title: string, body: string, folder?: string, tags: string[] = []): Promise<string> {
  const {folders} = await all();
  let folderId: string | null = null;
  if (folder) {
    const want = folder.split('/').map(s => s.trim().toLowerCase()).filter(Boolean).join(' / ');
    folderId = folders.find(f => (folderPath(folders, f.id) as string[]).join(' / ').toLowerCase() === want)?.id ?? null;
  }
  const note = await createNote(folderId);
  const normalizedTags = parseTags(tags.join(' ')) as string[];
  await putNote({...note, title, body, tags: normalizedTags});
  return `Заметка «${title}» создана (${note.id}) в «${pathOf(folders, folderId)}».${folder && !folderId ? ` Папки «${folder}» нет — заметка в корне.` : ''}`
    + `\n[note-receipt operation=create id=${note.id} fields=title,body,tags,folder tags=${normalizedTags.length}]`;
}

export async function notesAppend(id: string, text?: string, tags: string[] = []): Promise<string> {
  const {notes} = await all();
  const note = notes.find(n => n.id === id);
  if (!note) throw new Error(`Заметка ${id} не найдена.`);
  if (!text && !tags.length) throw new Error('Укажите текст или теги для заметки.');
  const nextBody = text ? (note.body ? `${note.body}\n\n${text}` : text) : note.body;
  const nextTags = parseTags([...note.tags, ...tags].join(' ')) as string[];
  await putNote({...note, body: nextBody, tags: nextTags});
  const fields = [text ? 'body' : '', tags.length ? 'tags' : ''].filter(Boolean).join(',');
  const receipt = `[note-receipt operation=append id=${id} fields=${fields} tags=${nextTags.length}]`;
  if (text && tags.length) return `Текст и теги добавлены в заметку «${noteTitle(note)}».\n${receipt}`;
  return `${tags.length ? `Теги добавлены в заметку «${noteTitle(note)}».` : `Дописано в заметку «${noteTitle(note)}».`}\n${receipt}`;
}

export interface NotesApi {
  search: typeof notesSearch; read: typeof notesRead; create: typeof notesCreate; append: typeof notesAppend;
}
export const notesApi: NotesApi = {search: notesSearch, read: notesRead, create: notesCreate, append: notesAppend};
