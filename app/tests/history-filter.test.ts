import {test} from 'node:test';
import assert from 'node:assert/strict';
import {filterConversations} from '../src/ui/history-filter.ts';
import type {Conversation} from '../src/store/types.ts';

const c = (id: string, title: string, updatedAt: number): Conversation => ({id, title, titleByUser: false, profileId: 'assistant', mode: 'chat', permission: 'ask', createdAt: 0, updatedAt});
const list = [c('1', 'план', 30), c('2', 'Ёлка', 10), c('3', 'Отчёт QA', 20)];

test('filterConversations: регистр и ё не важны, порядок по updatedAt', () => {
  assert.deepEqual(filterConversations(list, 'ел').map(x => x.title), ['Ёлка']);
  assert.deepEqual(filterConversations(list, 'QA').map(x => x.title), ['Отчёт QA']);
  assert.deepEqual(filterConversations(list, 'qa').map(x => x.title), ['Отчёт QA']);
  assert.deepEqual(filterConversations(list, '  ').map(x => x.title), ['план', 'Отчёт QA', 'Ёлка']);
});
