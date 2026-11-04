import {test} from 'node:test';
import assert from 'node:assert/strict';
import {folderPath, descendants, canMoveFolder, matches, buildTree, parseTags} from '../tree.js';

const F = [{id:'a', name:'Тест', parentId:null}, {id:'b', name:'Апи', parentId:'a'}, {id:'c', name:'Инструменты', parentId:null}];
const N = [
  {id:'1', title:'Метрики', body:'DDR', tags:['qa'], folderId:'a'},
  {id:'2', title:'Ёж', body:'', tags:[], folderId:'b'},
  {id:'3', title:'', body:'', tags:[], folderId:null},
  {id:'4', title:'Archify', body:'', tags:[], folderId:'c'},
];

test('folderPath возвращает имена от корня', () => {
  assert.deepEqual(folderPath(F, 'b'), ['Тест', 'Апи']);
  assert.deepEqual(folderPath(F, null), []);
});

test('descendants включает саму папку и вложенные', () => {
  assert.deepEqual([...descendants(F, 'a')].sort(), ['a', 'b']);
});

test('canMoveFolder запрещает себя и потомков', () => {
  assert.equal(canMoveFolder(F, 'a', 'a'), false);
  assert.equal(canMoveFolder(F, 'a', 'b'), false);
  assert.equal(canMoveFolder(F, 'b', null), true);
  assert.equal(canMoveFolder(F, 'c', 'a'), true);
});

test('matches: без учёта регистра и ё', () => {
  assert.ok(matches(N[1], 'ЕЖ'));
  assert.ok(matches(N[0], 'ddr'));
  assert.ok(matches(N[0], 'QA'));
  assert.ok(matches(N[2], '  '));
  assert.equal(matches(N[0], 'кот'), false);
});

test('buildTree: папки перед заметками, по алфавиту, счётчики поддерева', () => {
  const tree = buildTree(F, N);
  assert.deepEqual(tree.map(node => node.type === 'folder' ? node.folder.name : node.note.id), ['Инструменты', 'Тест', '3']);
  assert.equal(tree[1].count, 2);
  assert.equal(tree[1].children[0].folder.name, 'Апи');
  assert.equal(tree[1].children[1].note.id, '1');
});

test('buildTree: фильтр убирает папки без совпадений', () => {
  const tree = buildTree(F, N, 'ёж');
  assert.equal(tree.length, 1);
  assert.equal(tree[0].count, 1);
  assert.equal(tree[0].children[0].children[0].note.id, '2');
});

test('parseTags: разделители, #, без дублей', () => {
  assert.deepEqual(parseTags('#qa, kpi  qa'), ['qa', 'kpi']);
  assert.deepEqual(parseTags(' , # '), []);
});
