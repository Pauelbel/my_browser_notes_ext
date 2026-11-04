import {test} from 'node:test';
import assert from 'node:assert/strict';
import {titleFrom} from '../src/store/title.ts';

test('titleFrom: одна строка, до 60 символов', () => {
  assert.equal(titleFrom('  Привет,\n  мир  '), 'Привет, мир');
  const long = 'а'.repeat(80);
  assert.equal(titleFrom(long).length, 60);
  assert.ok(titleFrom(long).endsWith('…'));
  assert.equal(titleFrom(''), 'Новый чат');
});
