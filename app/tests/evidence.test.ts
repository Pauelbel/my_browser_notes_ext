import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classifyEvidence} from '../src/page/evidence.ts';

const none = {mutations: 0, requests: 0};

test('classifyEvidence: приоритет диалог > новая вкладка > переход > изменения > запросы > ничего', () => {
  assert.equal(classifyEvidence({...none, dialog: true, navigated: true}), 'dialog');
  assert.equal(classifyEvidence({...none, newTab: true, navigated: true}), 'new_tab');
  assert.equal(classifyEvidence({...none, navigated: true, mutations: 5}), 'navigated');
  assert.equal(classifyEvidence({mutations: 3, requests: 2}), 'changed');
  assert.equal(classifyEvidence({mutations: 0, requests: 2}), 'requests');
  assert.equal(classifyEvidence(none), 'none');
});
