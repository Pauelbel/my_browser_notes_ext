// IndexedDB storage: notes, folders and a small key-value store (for handles that localStorage cannot hold).
// Every write is announced on a BroadcastChannel so the side panel and a tab stay in step.
import {descendants} from './tree.js';

const channel = new BroadcastChannel('notes');
let db;

const done = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
const committed = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error); });

export async function open() {
  if (db) return;
  // 1.0 starts clean: drop the 0.x database and its settings. Not awaited: deletion waits
  // for every open connection to close, and a stale 0.x page must not block startup.
  indexedDB.deleteDatabase('quiet-notes').onerror = event => console.error(event.target.error);
  try { for (const key of Object.keys(localStorage)) if (key.startsWith('quiet-')) localStorage.removeItem(key); } catch {}
  const request = indexedDB.open('notes', 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore('notes', {keyPath:'id'});
    request.result.createObjectStore('folders', {keyPath:'id'});
    request.result.createObjectStore('kv');
  };
  db = await done(request);
}

async function write(stores, fn, id = null) {
  const tx = db.transaction(stores, 'readwrite');
  const result = fn(tx);
  await committed(tx);
  channel.postMessage({type:'changed', id});
  return result;
}

export async function loadAll() {
  const tx = db.transaction(['notes', 'folders']);
  const [notes, folders] = await Promise.all([done(tx.objectStore('notes').getAll()), done(tx.objectStore('folders').getAll())]);
  return {notes, folders};
}

export function putNote(note) {
  const saved = {...note, tags:[...note.tags], updated:Date.now()};
  return write('notes', tx => { tx.objectStore('notes').put(saved); return saved; }, saved.id);
}

export function createNote(folderId) {
  const now = Date.now();
  const note = {id:crypto.randomUUID(), title:'', body:'', tags:[], folderId, created:now, updated:now};
  return write('notes', tx => { tx.objectStore('notes').put(note); return note; }, note.id);
}

export function deleteNote(id) {
  return write('notes', tx => { tx.objectStore('notes').delete(id); }, id);
}

export function createFolder(name, parentId) {
  return putFolder({id:crypto.randomUUID(), name, parentId});
}

export function putFolder(folder) {
  return write('folders', tx => { tx.objectStore('folders').put(folder); return folder; });
}

export async function deleteFolder(id) {
  const {notes, folders} = await loadAll();
  const doomed = descendants(folders, id);
  await write(['notes', 'folders'], tx => {
    for (const folderId of doomed) tx.objectStore('folders').delete(folderId);
    for (const note of notes) if (doomed.has(note.folderId)) tx.objectStore('notes').delete(note.id);
  });
}

export async function kvGet(key) {
  return done(db.transaction('kv').objectStore('kv').get(key));
}

export async function kvSet(key, value) {
  const tx = db.transaction('kv', 'readwrite');
  tx.objectStore('kv').put(value, key);
  await committed(tx);
}

export function onExternalChange(callback) {
  channel.addEventListener('message', event => { if (event.data?.type === 'changed') callback(event.data); });
}
