import {test} from 'node:test';
import assert from 'node:assert/strict';
import {safeName, serialize, backupName, exportAll} from '../backup.js';

// In-memory stand-in for FileSystemDirectoryHandle: only the calls exportAll uses.
function fakeDir() {
  const children = new Map();
  const missing = () => Object.assign(new Error('missing'), {name:'NotFoundError'});
  return {
    kind:'directory', children,
    async getDirectoryHandle(name, {create = false} = {}) {
      if (!children.has(name)) { if (!create) throw missing(); children.set(name, fakeDir()); }
      return children.get(name);
    },
    async getFileHandle(name, {create = false} = {}) {
      if (!children.has(name)) { if (!create) throw missing(); children.set(name, {kind:'file', text:''}); }
      const file = children.get(name);
      return {async createWritable() { let text = ''; return {async write(chunk) { text += chunk; }, async close() { file.text = text; }, async abort() {}}; }};
    },
  };
}
const note = (id, title, folderId, body = '') => ({id, title, body, tags:[], folderId, created:0, updated:0});

test('safeName: запрещённые символы, хвосты, зарезервированные имена, длина', () => {
  assert.equal(safeName('a/b:c?'), 'a-b-c-');
  assert.equal(safeName(' CON '), 'Заметка');
  assert.equal(safeName('x. . '), 'x');
  assert.equal(safeName(''), 'Заметка');
  assert.equal(safeName('я'.repeat(90)).length, 70);
});

test('serialize: фронтматтер с JSON-строками и ISO-датами', () => {
  assert.equal(serialize({title:'Т "1"', tags:['qa'], body:'# H', created:0, updated:0}),
    '---\ntitle: "Т \\"1\\""\ntags: ["qa"]\ncreated: 1970-01-01T00:00:00.000Z\nupdated: 1970-01-01T00:00:00.000Z\n---\n# H');
});

test('backupName: локальное время', () => {
  assert.equal(backupName(new Date(2026, 10, 4, 9, 5, 7)), 'Заметки-2026-11-04_09-05-07');
});

test('exportAll: дерево, дубли имён, пустые папки, безымянные заметки', async () => {
  const root = fakeDir(), date = new Date(2026, 10, 4, 9, 5, 7);
  const result = await exportAll(root, {
    folders:[{id:'a', name:'Q/A', parentId:null}, {id:'e', name:'Пусто', parentId:null}, {id:'d', name:'Q/A', parentId:null}],
    notes:[note('1', 'X', 'a', 'один'), note('2', 'X', 'a', 'два'), note('3', '', null)],
  }, date);
  assert.deepEqual(result, {name:'Заметки-2026-11-04_09-05-07', count:3});
  const backup = root.children.get(result.name);
  assert.deepEqual([...backup.children.keys()].sort(), ['Q-A', 'Q-A (2)', 'Без названия.md', 'Пусто']);
  const folder = [...backup.children.values()].find(child => child.children?.size === 2);
  assert.deepEqual([...folder.children.keys()].sort(), ['X (2).md', 'X.md']);
  assert.match(folder.children.get('X.md').text + folder.children.get('X (2).md').text, /один[\s\S]*два|два[\s\S]*один/);
});

test('exportAll не перезаписывает существующую копию', async () => {
  const root = fakeDir(), date = new Date(2026, 10, 4, 9, 5, 7), data = {folders:[], notes:[]};
  await exportAll(root, data, date);
  const second = await exportAll(root, data, date);
  assert.equal(second.name, 'Заметки-2026-11-04_09-05-07 (2)');
});

test('exportAll: ошибка записи называет копию', async () => {
  const root = fakeDir();
  const broken = {...root, async getDirectoryHandle(name, options) {
    const dir = await root.getDirectoryHandle(name, options);
    return {...dir, async getFileHandle() { throw new Error('диск полон'); }};
  }};
  await assert.rejects(exportAll(broken, {folders:[], notes:[note('1', 'X', null)]}, new Date(2026, 10, 4, 9, 5, 7)),
    /Копия не завершена: Заметки-2026-11-04_09-05-07\. диск полон/);
});
