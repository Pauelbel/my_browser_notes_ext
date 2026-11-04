import {open, loadAll, putNote, createNote, deleteNote, createFolder, putFolder, deleteFolder, kvGet, kvSet, onExternalChange} from './db.js';
import {buildTree, folderPath, canMoveFolder, descendants, parseTags, noteTitle} from './tree.js';
import {exportAll} from './backup.js';
import {createEditor} from './vendor/editor.js';
import {icons} from './icons.js';

const $ = id => document.getElementById(id);
const el = (tag, className = '', text = '') => { const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node; };
const time = value => new Intl.DateTimeFormat('ru', {hour:'2-digit', minute:'2-digit'}).format(value);
const narrow = matchMedia('(max-width: 559px)');
const darkScheme = matchMedia('(prefers-color-scheme: dark)');
const inPanel = new URLSearchParams(location.search).get('view') === 'panel';

function pref(key, fallback) { try { const value = localStorage.getItem(`notes:${key}`); return value === null ? fallback : JSON.parse(value); } catch { return fallback; } }
function setPref(key, value) { try { localStorage.setItem(`notes:${key}`, JSON.stringify(value)); } catch {} }

let data = {notes:[], folders:[]};
let current = null;          // working copy of the open note
let lastSaved = '';          // snapshot of what is in the database for `current`
let bodyDirty = false;       // editor changed since the body was last read (getMarkdown is costly with images)
let timer = null;
let chain = Promise.resolve();
let drag = null;
let sidebarOpen = true;
const openFolders = new Set(pref('open', []));

const snapshot = note => JSON.stringify([note.title, note.body, note.tags, note.folderId]);
const dirty = () => Boolean(current) && (timer !== null || bodyDirty || snapshot(current) !== lastSaved);

// Saves and destructive actions run one at a time, in order, so a late save cannot resurrect a deleted note.
function queue(fn) { const run = chain.then(fn); chain = run.catch(() => {}); return run; }
function fail(error) { console.error(error); setSaveState('error', error.message || String(error)); }

const editor = createEditor($('editor'), {onChange() { bodyDirty = true; schedule(); }});

// ——— Popovers and tooltips ———

const zoom = () => parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
// Positions a fixed popover next to `rect` (viewport pixels), flipping above when there is no room below.
function place(popover, rect, align = 'left') {
  popover.hidden = false;
  const z = zoom(), width = popover.offsetWidth * z, height = popover.offsetHeight * z;
  let x = align === 'right' ? rect.right - width : align === 'center' ? rect.left + rect.width / 2 - width / 2 : rect.left;
  x = Math.max(4, Math.min(x, innerWidth - width - 4));
  let y = rect.bottom + 4;
  if (y + height > innerHeight - 4) y = Math.max(4, rect.top - 4 - height);
  popover.style.left = `${x / z}px`; popover.style.top = `${y / z}px`;
}
function closePopovers() {
  $('treeMenu').hidden = true; $('tablePicker').hidden = true;
  $('insertTable').setAttribute('aria-expanded', 'false');
  document.querySelectorAll('.t-more[aria-expanded="true"]').forEach(button => button.setAttribute('aria-expanded', 'false'));
}
function showTip(target) {
  const tip = $('tip');
  tip.textContent = target.dataset.tip;
  place(tip, target.getBoundingClientRect(), 'center');
}
document.addEventListener('pointerover', event => { const target = event.target.closest?.('[data-tip]'); if (target) showTip(target); else $('tip').hidden = true; });
document.addEventListener('focusin', event => { const target = event.target.closest?.('[data-tip]'); if (target?.matches(':focus-visible')) showTip(target); else $('tip').hidden = true; });
document.addEventListener('pointerdown', event => {
  $('tip').hidden = true;
  if (!event.target.closest('.popover, #insertTable, .t-more')) closePopovers();
});

// ——— Dialogs ———

function confirmDelete(text) {
  const dialog = $('confirmDialog');
  $('confirmText').textContent = text; dialog.returnValue = '';
  dialog.showModal();
  return new Promise(resolve => { dialog.onclose = () => resolve(dialog.returnValue === 'ok'); });
}
function ask(label, value = '') {
  const dialog = $('promptDialog'), input = $('promptInput');
  $('promptTitle').textContent = label; input.value = value; dialog.returnValue = '';
  dialog.showModal(); input.select();
  return new Promise(resolve => { dialog.onclose = () => resolve(dialog.returnValue === 'ok' && input.value.trim() || null); });
}
// Enter must confirm; the implicit submit would pick the first button, which is "Отмена".
$('promptInput').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); $('promptDialog').close('ok'); } });

// ——— Saving ———

function setSaveState(state, detail = '') {
  const node = $('saveState');
  node.dataset.state = state;
  node.textContent = state === 'pending' ? '…' : state === 'error' ? '! не сохранено' : `✓ ${time(detail)}`;
  if (state === 'error') node.dataset.tip = detail; else delete node.dataset.tip;
}
function schedule() {
  if (!current) return;
  setSaveState('pending');
  clearTimeout(timer);
  timer = setTimeout(() => { timer = null; save().catch(fail); }, 500);
}
function save() {
  clearTimeout(timer); timer = null;
  return queue(async () => {
    const note = current;
    if (!note) return;
    if (bodyDirty) { note.body = editor.getMarkdown(); bodyDirty = false; }
    const snap = snapshot(note);
    if (snap === lastSaved) return;
    const saved = await putNote(note);
    if (current === note) { lastSaved = snap; note.updated = saved.updated; setSaveState('saved', saved.updated); }
    if (pref('draft', null)?.id === saved.id) setPref('draft', null);
    const index = data.notes.findIndex(n => n.id === saved.id);
    if (index >= 0) data.notes[index] = saved; else data.notes.push(saved);
    renderTree();
  });
}
// An IndexedDB write started while the page unloads gets aborted, so unsaved edits are also
// stashed synchronously in localStorage and written to the database on the next start.
function stash() {
  if (!dirty()) return;
  if (bodyDirty) { current.body = editor.getMarkdown(); bodyDirty = false; }
  setPref('draft', {...current, stashed:Date.now()});
  save().catch(fail);
}
async function restoreDraft() {
  const draft = pref('draft', null);
  if (!draft) return;
  const stored = data.notes.find(n => n.id === draft.id);
  if (stored && draft.stashed > stored.updated) {
    const {stashed, ...note} = draft;
    const saved = await putNote(note);
    data.notes = data.notes.map(n => n.id === saved.id ? saved : n);
  }
  setPref('draft', null);
}
document.addEventListener('visibilitychange', () => { if (document.hidden) stash(); });
addEventListener('pagehide', stash);

// ——— Note ———

function reveal(folderId) {
  for (let id = folderId; id; id = data.folders.find(f => f.id === id)?.parentId) openFolders.add(id);
  setPref('open', [...openFolders]);
}
function showNote(note) {
  current = {...note, tags:[...note.tags]};
  lastSaved = snapshot(current); bodyDirty = false;
  $('title').value = note.title;
  editor.setMarkdown(note.body);
  editor.setEditable(true);
  setPref('last', note.id);
  setSaveState('saved', note.updated);
  $('note').hidden = false; $('empty').hidden = true;
  updateToolbar(); renderMeta();
}
function showEmpty() {
  current = null; lastSaved = ''; bodyDirty = false;
  editor.setMarkdown(''); editor.setEditable(false);
  $('note').hidden = true; $('empty').hidden = false;
  updateToolbar();
}
function flatNotes() {
  const result = [];
  const walk = nodes => { for (const node of nodes) node.type === 'note' ? result.push(node.note) : walk(node.children); };
  walk(buildTree(data.folders, data.notes));
  return result;
}
async function openNote(id) {
  await save();
  const note = data.notes.find(n => n.id === id);
  if (note) showNote(note);
  renderTree();
  if (narrow.matches) setSidebar(false);
}
async function newNote(folderId) {
  await save();
  const note = await createNote(folderId);
  data.notes.push(note);
  reveal(folderId);
  showNote(note); renderTree();
  if (narrow.matches) setSidebar(false);
  $('title').focus();
}
async function newFolder(parentId) {
  const name = await ask(parentId ? 'Новая подпапка' : 'Новая папка');
  if (!name) return;
  const folder = await createFolder(name, parentId);
  data.folders.push(folder);
  reveal(parentId); renderTree();
}

$('title').addEventListener('input', () => { if (current) { current.title = $('title').value; schedule(); } });
$('title').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); editor.focus(); } });

// ——— Meta line: folder path, tags ———

function renderMeta() {
  if (!current) return;
  $('path').textContent = folderPath(data.folders, current.folderId).join(' › ') || 'без папки';
  $('tags').replaceChildren(...current.tags.map(tag => {
    const chip = el('span', 'tag', `#${tag}`), remove = el('button', '', '×');
    remove.setAttribute('aria-label', `Убрать тег ${tag}`);
    remove.onclick = () => { current.tags = current.tags.filter(t => t !== tag); renderMeta(); schedule(); };
    chip.append(remove);
    return chip;
  }));
}
function addTags(values) {
  const fresh = values.filter(tag => !current.tags.includes(tag));
  if (!fresh.length) return;
  current.tags.push(...fresh); renderMeta(); schedule();
}
function renderTagSuggest() {
  const query = $('tagInput').value.trim().replace(/^#/, '').toLocaleLowerCase('ru');
  const all = [...new Set(data.notes.flatMap(n => n.tags))].filter(tag => !current.tags.includes(tag) && tag.toLocaleLowerCase('ru').includes(query))
    .sort((a, b) => a.localeCompare(b, 'ru')).slice(0, 30);
  $('tagSuggest').replaceChildren(...all.map(tag => {
    const option = el('button', '', `#${tag}`);
    option.setAttribute('role', 'option');
    option.onmousedown = event => event.preventDefault();
    option.onclick = () => { addTags([tag]); $('tagInput').value = ''; renderTagSuggest(); };
    return option;
  }));
  $('tagSuggest').hidden = !all.length;
}
function commitTagInput() { addTags(parseTags($('tagInput').value)); $('tagInput').value = ''; }
function closeTagInput() { $('tagInput').hidden = true; $('tagSuggest').hidden = true; $('addTag').hidden = false; }
$('addTag').onclick = () => { $('addTag').hidden = true; $('tagInput').hidden = false; $('tagInput').focus(); renderTagSuggest(); };
$('tagInput').addEventListener('keydown', event => {
  if (['Enter', ' ', ','].includes(event.key)) { event.preventDefault(); commitTagInput(); renderTagSuggest(); }
  else if (event.key === 'Escape') { $('tagInput').value = ''; closeTagInput(); }
});
$('tagInput').addEventListener('input', () => { if (/[\s,]/.test($('tagInput').value)) commitTagInput(); renderTagSuggest(); });
$('tagInput').addEventListener('blur', () => { commitTagInput(); closeTagInput(); });

// ——— Tree ———

function renderTree() {
  const query = $('search').value, filtering = Boolean(query.trim());
  const nodes = buildTree(data.folders, data.notes, query);
  $('tree').replaceChildren(...nodes.map(node => renderNode(node, filtering)));
  if (!nodes.length) $('tree').append(el('p', 't-empty', filtering ? 'ничего не найдено' : 'пусто'));
  if (current) renderMeta();
}
function renderNode(node, filtering) {
  const item = el('div', `t-item ${node.type}`), row = el('div', 't-row'), label = el('button', 't-label');
  row.append(label); item.append(row);
  row.draggable = true;
  row.addEventListener('dragstart', event => {
    drag = node.type === 'note' ? {type:'note', id:node.note.id} : {type:'folder', id:node.folder.id};
    event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', drag.id);
  });
  row.addEventListener('dragend', () => { drag = null; clearDropMarks(); });
  if (node.type === 'note') {
    label.append(el('span', 't-name', noteTitle(node.note)));
    label.setAttribute('role', 'treeitem');
    item.classList.toggle('active', node.note.id === current?.id);
    label.onclick = () => openNote(node.note.id).catch(fail);
    return item;
  }
  const {folder} = node, expanded = filtering || openFolders.has(folder.id);
  item.classList.toggle('closed', !expanded);
  label.append(el('span', 't-name', folder.name), el('span', 't-count', `· ${node.count}`));
  label.setAttribute('role', 'treeitem'); label.setAttribute('aria-expanded', String(expanded));
  label.onclick = () => {
    if (openFolders.has(folder.id)) openFolders.delete(folder.id); else openFolders.add(folder.id);
    setPref('open', [...openFolders]); renderTree();
  };
  const more = el('button', 't-more');
  more.innerHTML = icons.more; more.setAttribute('aria-label', `Действия с папкой ${folder.name}`); more.setAttribute('aria-haspopup', 'menu');
  more.onclick = () => openTreeMenu(folder, more);
  row.append(more);
  row.addEventListener('dragover', event => { if (canDrop(folder.id)) { event.preventDefault(); clearDropMarks(); row.classList.add('drop'); } });
  row.addEventListener('dragleave', () => row.classList.remove('drop'));
  row.addEventListener('drop', event => { event.preventDefault(); event.stopPropagation(); dropInto(folder.id); });
  if (expanded && node.children.length) {
    const children = el('div', 't-children');
    children.append(...node.children.map(child => renderNode(child, filtering)));
    item.append(children);
  }
  return item;
}

// ——— Drag and drop ———

function clearDropMarks() { document.querySelectorAll('.t-row.drop').forEach(row => row.classList.remove('drop')); $('tree').classList.remove('drop-root'); }
function canDrop(targetId) {
  if (!drag) return false;
  if (drag.type === 'note') return data.notes.find(n => n.id === drag.id)?.folderId !== targetId;
  const folder = data.folders.find(f => f.id === drag.id);
  return folder.parentId !== targetId && canMoveFolder(data.folders, folder.id, targetId);
}
function dropInto(targetId) {
  const source = drag; drag = null; clearDropMarks();
  if (!source) return;
  (async () => {
    if (source.type === 'note') {
      if (current?.id === source.id) { current.folderId = targetId; await save(); }
      else {
        const saved = await putNote({...data.notes.find(n => n.id === source.id), folderId:targetId});
        data.notes = data.notes.map(n => n.id === saved.id ? saved : n);
      }
    } else {
      const saved = await putFolder({...data.folders.find(f => f.id === source.id), parentId:targetId});
      data.folders = data.folders.map(f => f.id === saved.id ? saved : f);
    }
    reveal(targetId); renderTree();
  })().catch(fail);
}
$('tree').addEventListener('dragover', event => {
  if (event.target.closest('.folder > .t-row') || !canDrop(null)) return;
  event.preventDefault(); clearDropMarks(); $('tree').classList.add('drop-root');
});
$('tree').addEventListener('dragleave', event => { if (!$('tree').contains(event.relatedTarget)) $('tree').classList.remove('drop-root'); });
$('tree').addEventListener('drop', event => { event.preventDefault(); dropInto(null); });

// ——— Folder menu ———

let menuFolder = null;
function openTreeMenu(folder, button) {
  const wasOpen = !$('treeMenu').hidden && menuFolder?.id === folder.id;
  closePopovers();
  if (wasOpen) return;
  menuFolder = folder;
  button.setAttribute('aria-expanded', 'true');
  place($('treeMenu'), button.getBoundingClientRect(), 'right');
  $('treeMenu').querySelector('button').focus();
}
$('treeMenu').addEventListener('click', event => {
  const action = event.target.closest('button')?.dataset.action, folder = menuFolder;
  if (!action || !folder) return;
  closePopovers();
  ({
    note:() => newNote(folder.id),
    folder:() => newFolder(folder.id),
    async rename() {
      const name = await ask('Название папки', folder.name);
      if (!name || name === folder.name) return;
      const saved = await putFolder({...folder, name});
      data.folders = data.folders.map(f => f.id === saved.id ? saved : f);
      renderTree();
    },
    async delete() {
      const doomed = descendants(data.folders, folder.id);
      const count = data.notes.filter(n => doomed.has(n.folderId)).length;
      if (!await confirmDelete(`Удалить папку «${folder.name}»${count ? ` и ${count} ${plural(count, 'заметку', 'заметки', 'заметок')} в ней` : ''} навсегда?`)) return;
      await queue(async () => {
        const lost = current && doomed.has(current.folderId);
        if (lost) { clearTimeout(timer); timer = null; current = null; }
        await deleteFolder(folder.id);
        data = await loadAll();
        if (lost) { const next = flatNotes()[0]; next ? showNote(next) : showEmpty(); }
      });
      renderTree();
    },
  })[action]().catch(fail);
});

function plural(n, one, few, many) {
  const mod10 = n % 10, mod100 = n % 100;
  return mod10 === 1 && mod100 !== 11 ? one : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many;
}

// ——— Top bar ———

for (const button of document.querySelectorAll('[data-icon]')) button.innerHTML = icons[button.dataset.icon];

$('newNote').onclick = () => newNote(current?.folderId ?? null).catch(fail);
$('newFolder').onclick = () => newFolder(current?.folderId ?? null).catch(fail);
$('deleteNote').onclick = async () => {
  if (!current) return;
  const note = current;
  if (!await confirmDelete(`Удалить заметку «${noteTitle(note)}» навсегда?`)) return;
  await queue(async () => {
    const order = flatNotes(), index = order.findIndex(n => n.id === note.id);
    clearTimeout(timer); timer = null; current = null;
    await deleteNote(note.id);
    data.notes = data.notes.filter(n => n.id !== note.id);
    const next = order[index + 1] || order[index - 1];
    next && next.id !== note.id ? showNote(data.notes.find(n => n.id === next.id)) : showEmpty();
  }).catch(fail);
  renderTree();
};

const formatButtons = [...document.querySelectorAll('.tb-format button')];
const toggles = ['bold', 'italic', 'heading', 'bulletList', 'orderedList', 'taskList', 'blockquote', 'codeBlock'];
function updateToolbar() {
  $('deleteNote').disabled = !current;
  for (const button of formatButtons) {
    const command = button.dataset.cmd;
    button.disabled = !current || (command === 'undo' || command === 'redo') && !editor.can(command);
    if (toggles.includes(command)) button.setAttribute('aria-pressed', String(Boolean(current) && editor.isActive(command)));
  }
  requestAnimationFrame(updateTableContext);
}
for (const button of document.querySelectorAll('[data-cmd]')) {
  button.addEventListener('mousedown', event => event.preventDefault());   // keep the editor's selection
  button.addEventListener('click', () => { editor.run(button.dataset.cmd); });
}
editor.onSelectionChange(updateToolbar);

function updateTableContext() {
  const rect = current && document.activeElement?.closest('#editor') && editor.inTable() ? editor.cellRect() : null;
  if (rect) place($('tableContext'), rect); else $('tableContext').hidden = true;
}
$('note').addEventListener('scroll', () => { $('tableContext').hidden = true; });
addEventListener('resize', () => { $('tableContext').hidden = true; closePopovers(); });
$('editor').addEventListener('focusout', () => setTimeout(updateTableContext));

const grid = $('tablePicker').querySelector('.table-grid');
for (let row = 1; row <= 6; row++) for (let col = 1; col <= 6; col++) {
  const cell = el('button');
  cell.setAttribute('aria-label', `${col} × ${row}`);
  const highlight = () => {
    $('tablePicker').querySelector('.table-size').textContent = `${col} × ${row}`;
    grid.querySelectorAll('button').forEach((other, i) => other.classList.toggle('on', i % 6 < col && Math.floor(i / 6) < row));
  };
  cell.onpointerenter = highlight; cell.onfocus = highlight;
  cell.onmousedown = event => event.preventDefault();
  cell.onclick = () => { closePopovers(); editor.insertTable(row, col); };
  grid.append(cell);
}
$('insertTable').onclick = () => {
  const opening = $('tablePicker').hidden;
  closePopovers();
  if (!opening) return;
  $('insertTable').setAttribute('aria-expanded', 'true');
  place($('tablePicker'), $('insertTable').getBoundingClientRect());
};
$('insertImage').onclick = () => $('imageInput').click();
$('imageInput').onchange = () => {
  const [file] = $('imageInput').files;
  $('imageInput').value = '';
  if (file) editor.readImage(file).then(src => editor.insertImage(src), fail);
};

// ——— Theme, sidebar ———

function renderTheme() {
  const theme = pref('theme', '');
  if (theme) document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme;
  const dark = theme ? theme === 'dark' : darkScheme.matches;
  $('themeToggle').innerHTML = icons[dark ? 'sun' : 'moon'];
  $('themeToggle').dataset.tip = dark ? 'Светлая тема' : 'Тёмная тема';
}
$('themeToggle').onclick = () => {
  const dark = (pref('theme', '') || (darkScheme.matches ? 'dark' : 'light')) === 'dark';
  setPref('theme', dark ? 'light' : 'dark'); renderTheme();
};
darkScheme.addEventListener('change', renderTheme);

function setSidebar(open) {
  sidebarOpen = open;
  $('app').classList.toggle('sidebar-collapsed', !open);
  if (!narrow.matches) setPref('collapsed', !open);
}
function renderSide() {
  const right = pref('side', 'left') === 'right';
  $('app').classList.toggle('side-right', right);
  $('sideLeft').setAttribute('aria-pressed', String(!right));
  $('sideRight').setAttribute('aria-pressed', String(right));
}
$('toggleSidebar').onclick = () => setSidebar(!sidebarOpen);
narrow.addEventListener('change', () => setSidebar(narrow.matches ? false : !pref('collapsed', false)));
// Tapping the note closes the overlaid list on a narrow panel.
$('note').addEventListener('pointerdown', () => { if (narrow.matches && sidebarOpen) setSidebar(false); });

$('resizer').addEventListener('pointerdown', event => {
  const resizer = $('resizer'), box = $('app').getBoundingClientRect(), z = zoom();
  resizer.setPointerCapture(event.pointerId); resizer.classList.add('dragging');
  const move = moveEvent => {
    const right = $('app').classList.contains('side-right');
    const width = Math.round(Math.min(480, Math.max(180, (right ? box.right - moveEvent.clientX : moveEvent.clientX - box.left) / z)));
    $('app').style.setProperty('--side-w', `${width}px`);
  };
  resizer.addEventListener('pointermove', move);
  resizer.addEventListener('pointerup', () => {
    resizer.removeEventListener('pointermove', move); resizer.classList.remove('dragging');
    setPref('width', parseInt($('app').style.getPropertyValue('--side-w')) || 240);
  }, {once:true});
});

$('search').addEventListener('input', renderTree);
$('search').addEventListener('keydown', event => { if (event.key === 'Escape') { $('search').value = ''; renderTree(); } });

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closePopovers();
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save().catch(fail); }
});

// ——— Settings ———

const backupStatus = text => { $('backupResult').textContent = text; };
async function chooseBackupDir() {
  try {
    const handle = await showDirectoryPicker({id:'notes-backup', mode:'readwrite'});
    await kvSet('backupDir', handle);
    $('backupDir').textContent = handle.name;
    return handle;
  } catch (error) {
    if (error.name !== 'AbortError') backupStatus(error.message);
    return null;
  }
}
$('openSettings').onclick = async () => {
  $('backupDir').textContent = (await kvGet('backupDir'))?.name || 'не выбрана';
  backupStatus(pref('lastBackup', ''));
  renderZoom(quietZoom.read());
  $('settingsDialog').showModal();
};
$('chooseBackupDir').onclick = chooseBackupDir;
$('runBackup').onclick = async () => {
  $('runBackup').disabled = true;
  try {
    const handle = await kvGet('backupDir') || await chooseBackupDir();
    if (!handle) return;
    if (await handle.queryPermission({mode:'readwrite'}) !== 'granted' && await handle.requestPermission({mode:'readwrite'}) !== 'granted') {
      backupStatus('Нет доступа к папке. Разрешите доступ или выберите другую папку.');
      return;
    }
    backupStatus('Сохранение…');
    await save();
    const result = await exportAll(handle, await loadAll());
    const text = `Сохранено ${result.count} ${plural(result.count, 'заметка', 'заметки', 'заметок')} в «${result.name}» · ${time(Date.now())}`;
    setPref('lastBackup', text); backupStatus(text);
  } catch (error) {
    console.error(error); backupStatus(error.message || String(error));
  } finally {
    $('runBackup').disabled = false;
  }
};

function renderZoom(percent) { $('zoom').value = percent; $('zoomValue').textContent = `${percent}%`; }
Object.assign($('zoom'), {min:quietZoom.min, max:quietZoom.max, step:quietZoom.step});
$('zoom').addEventListener('input', () => { const value = quietZoom.clamp($('zoom').value); quietZoom.apply(value); quietZoom.save(value); renderZoom(value); });
$('zoomReset').onclick = () => { quietZoom.apply(quietZoom.fallback); quietZoom.save(quietZoom.fallback); renderZoom(quietZoom.fallback); };
addEventListener('storage', event => { if (event.key === quietZoom.key) quietZoom.apply(quietZoom.read()); });

$('sideLeft').onclick = () => { setPref('side', 'left'); renderSide(); };
$('sideRight').onclick = () => { setPref('side', 'right'); renderSide(); };
const tabs = globalThis.chrome?.tabs;
$('openTab').hidden = !tabs || !inPanel;
$('chromePanel').hidden = !tabs;
$('openTab').closest('section').hidden = $('openTab').hidden && $('chromePanel').hidden;
$('openTab').onclick = () => tabs.create({url:chrome.runtime.getURL('index.html')});
$('chromePanel').onclick = () => tabs.create({url:'chrome://settings/appearance'});

// ——— Another window (side panel ↔ tab) changed the data ———

onExternalChange(({id}) => queue(async () => {
  data = await loadAll();
  if (current) {
    const fresh = data.notes.find(n => n.id === current.id);
    if (!fresh) { const next = flatNotes()[0]; next ? showNote(next) : showEmpty(); }
    else if (id === current.id && !dirty() && fresh.updated !== current.updated) showNote(fresh);
  } else if (data.notes.length) showNote(flatNotes()[0]);
  renderTree();
}).catch(fail));

// ——— Start ———

renderTheme(); renderSide();
$('app').style.setProperty('--side-w', `${pref('width', 240)}px`);
setSidebar(narrow.matches ? false : !pref('collapsed', false));
try {
  await open();
  data = await loadAll();
  await restoreDraft();
  const last = data.notes.find(n => n.id === pref('last', null)) || flatNotes()[0];
  if (last) { reveal(last.folderId); showNote(last); } else showEmpty();
  renderTree();
} catch (error) {
  showEmpty(); fail(error);
  $('empty').textContent = `Не удалось открыть хранилище: ${error.message || error}`;
}
