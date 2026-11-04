// Pure helpers over the flat folder/note lists. No DOM, no storage.

const byName = (a, b) => a.localeCompare(b, 'ru');
export const noteTitle = note => note.title || 'Без названия';

export function folderPath(folders, folderId) {
  const names = [];
  for (let folder = folders.find(f => f.id === folderId); folder; folder = folders.find(f => f.id === folder.parentId)) names.unshift(folder.name);
  return names;
}

export function descendants(folders, folderId) {
  const result = new Set([folderId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const folder of folders) if (result.has(folder.parentId) && !result.has(folder.id)) { result.add(folder.id); grew = true; }
  }
  return result;
}

export function canMoveFolder(folders, folderId, targetParentId) {
  return targetParentId === null || !descendants(folders, folderId).has(targetParentId);
}

const normalize = text => text.toLocaleLowerCase('ru').replaceAll('ё', 'е');

export function matches(note, query) {
  const needle = normalize(query.trim());
  if (!needle) return true;
  return [note.title, note.body, ...note.tags].some(text => normalize(text || '').includes(needle));
}

export function buildTree(folders, notes, query = '') {
  const visible = notes.filter(note => matches(note, query));
  const filtering = Boolean(query.trim());
  const level = parentId => {
    const branches = folders.filter(f => f.parentId === parentId).sort((a, b) => byName(a.name, b.name)).map(folder => {
      const children = level(folder.id);
      const count = children.reduce((sum, node) => sum + (node.type === 'folder' ? node.count : 1), 0);
      return {type:'folder', folder, count, children};
    }).filter(node => !filtering || node.count);
    const leaves = visible.filter(note => note.folderId === parentId)
      .sort((a, b) => byName(noteTitle(a), noteTitle(b))).map(note => ({type:'note', note}));
    return [...branches, ...leaves];
  };
  return level(null);
}

export function parseTags(text) {
  return [...new Set(text.split(/[\s,]+/).map(tag => tag.replace(/^#+/, '')).filter(Boolean))];
}
