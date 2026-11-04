// One-way export of all notes as .md files. Every run writes into a new folder; nothing is overwritten.
import {noteTitle} from './tree.js';

export function safeName(value) {
  let name = value.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/g, '').slice(0, 70);
  if (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = 'Заметка';
  return name;
}

export function serialize(note) {
  const iso = time => new Date(time).toISOString();
  return `---\ntitle: ${JSON.stringify(note.title)}\ntags: ${JSON.stringify(note.tags)}\ncreated: ${iso(note.created)}\nupdated: ${iso(note.updated)}\n---\n${note.body}`;
}

export function backupName(date) {
  const pad = value => String(value).padStart(2, '0');
  return `Заметки-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

// "name", "name (2)", "name (3)"… — the first one not yet taken in this directory (case-insensitive, like most file systems).
function unique(taken, base, extension = '') {
  for (let n = 1; ; n++) {
    const name = `${base}${n > 1 ? ` (${n})` : ''}${extension}`;
    if (!taken.has(name.toLowerCase())) { taken.add(name.toLowerCase()); return name; }
  }
}

async function exists(root, name) {
  try { await root.getDirectoryHandle(name); return true; }
  catch (error) { if (error.name === 'NotFoundError') return false; throw error; }
}

export async function exportAll(root, {folders, notes}, date = new Date()) {
  let name = backupName(date);
  for (let n = 2; await exists(root, name); n++) name = `${backupName(date)} (${n})`;
  try {
    const writeLevel = async (dir, parentId) => {
      const taken = new Set();
      for (const note of notes.filter(n => n.folderId === parentId)) {
        const file = await dir.getFileHandle(unique(taken, safeName(noteTitle(note)), '.md'), {create:true});
        const stream = await file.createWritable();
        try { await stream.write(serialize(note)); await stream.close(); }
        catch (error) { await stream.abort().catch(() => {}); throw error; }
      }
      for (const folder of folders.filter(f => f.parentId === parentId)) {
        await writeLevel(await dir.getDirectoryHandle(unique(taken, safeName(folder.name)), {create:true}), folder.id);
      }
    };
    await writeLevel(await root.getDirectoryHandle(name, {create:true}), null);
  } catch (error) {
    throw new Error(`Копия не завершена: ${name}. ${error.message || error}`, {cause:error});
  }
  return {name, count:notes.length};
}
