import 'fake-indexeddb/auto';
import './helpers/unref-channels.ts';
import {test, before} from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain JS module of the notes UI
import {open, createFolder, createNote, putNote, loadAll} from '../db.js';
import {notesAppend, notesCreate, notesRead, notesSearch} from '../src/agent/notes.ts';

let work: {id: string}, qa: {id: string}, ёлка: {id: string};
before(async () => {
  await open();
  work = await createFolder('Работа', null);
  qa = await createFolder('QA', work.id);
  const note = await createNote(qa.id);
  ёлка = await putNote({...note, title: 'Новогодняя ёлка', body: 'Купить гирлянду', tags: ['дом']});
  const other = await createNote(null);
  await putNote({...other, title: 'План тестов', body: 'Проверить форму входа', tags: ['qa']});
});

test('notesSearch: по тегу и по тексту с ё', async () => {
  assert.match(await notesSearch('qa'), /План тестов/);
  assert.match(await notesSearch('елка'), /Новогодняя ёлка/);
  assert.match(await notesSearch('елка'), /Работа \/ QA/);
  assert.match(await notesSearch('нет такого'), /ничего не найдено/i);
});

test('notesRead: содержимое в блоке заметки; неизвестный id — понятная ошибка', async () => {
  const text = await notesRead(ёлка.id);
  assert.match(text, /<<<note>>>[\s\S]*Купить гирлянду[\s\S]*<<<end-note>>>/);
  await assert.rejects(notesRead('нет-такого'), /не найдена/);
});

test('notesCreate: в папку по пути', async () => {
  const result = await notesCreate('Отчёт', 'Найден баг', 'Работа/QA');
  assert.match(result, /создана/);
  const {notes} = await loadAll();
  const created = notes.find((n: {title: string}) => n.title === 'Отчёт');
  assert.equal(created.folderId, qa.id);
  assert.equal(created.body, 'Найден баг');
});

test('notesAppend: дописывает и не трогает остальное', async () => {
  await notesAppend(ёлка.id, 'И звезду');
  const {notes} = await loadAll();
  const note = notes.find((n: {id: string}) => n.id === ёлка.id);
  assert.equal(note.body, 'Купить гирлянду\n\nИ звезду');
  assert.equal(note.title, 'Новогодняя ёлка');
  assert.deepEqual(note.tags, ['дом']);
});
