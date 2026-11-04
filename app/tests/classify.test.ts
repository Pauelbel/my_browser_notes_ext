import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classify, USER_STEP, type ActionFacts} from '../src/page/classify.ts';
import {decideWrite, siteOf} from '../src/agent/permissions.ts';

const facts = (over: Partial<ActionFacts>): ActionFacts => ({action: 'activate', role: 'button', name: '', tag: 'button', type: '', inForm: false,
  formHasPassword: false, secretField: false, nearbyText: '', ...over});

test('classify: словарь и факты формы', () => {
  assert.equal(classify(facts({name: 'Удалить черновик'})), 'delete');
  assert.equal(classify(facts({name: 'Выйти'})), 'logout');
  assert.equal(classify(facts({name: 'Оплатить 1 990 ₽'})), 'pay');
  assert.equal(classify(facts({name: 'Подтвердить', nearbyText: 'Итого 1 990 ₽'})), 'pay');
  assert.equal(classify(facts({name: 'Разрешить доступ'})), 'access');
  assert.equal(classify(facts({name: 'Отправить', type: 'submit', inForm: true})), 'send');
  assert.equal(classify(facts({name: 'Сохранить', type: 'submit', inForm: true})), 'submit');
  assert.equal(classify(facts({name: 'Сохранить', inForm: true})), 'submit');
  assert.equal(classify(facts({action: 'enter', role: 'textbox', tag: 'input', type: 'text', name: 'Поиск', inForm: true})), 'submit');
  assert.equal(classify(facts({action: 'enter', role: 'textbox', tag: 'input', type: 'text', name: 'Поиск'})), null);
  assert.equal(classify(facts({action: 'type', role: 'textbox', tag: 'input', type: 'password', name: 'Пароль', secretField: true})), 'secret');
  assert.equal(classify(facts({action: 'type', role: 'textbox', tag: 'input', type: 'text', name: 'Имя'})), null);
  assert.equal(classify(facts({name: 'Удалить и оплатить'})), 'pay');
  assert.equal(classify(facts({role: 'link', tag: 'a', name: 'Ёлка'})), null);
  assert.equal(classify(facts({name: 'Delete account'})), 'delete');
  assert.equal(classify(facts({name: 'Sign out'})), 'logout');
  assert.ok(USER_STEP.has('pay') && USER_STEP.has('access') && USER_STEP.has('secret') && !USER_STEP.has('delete'));
});

test('decideWrite', () => {
  assert.equal(decideWrite('ask', 'block'), 'block');
  assert.equal(decideWrite('auto', 'block'), 'block');
  assert.equal(decideWrite('ask', 'allow'), 'allow');
  assert.equal(decideWrite('auto', 'ask'), 'ask');
  assert.equal(decideWrite('ask', undefined), 'ask');
  assert.equal(decideWrite('auto', undefined), 'allow');
});

test('siteOf', () => {
  assert.equal(siteOf('https://www.example.com/a?b'), 'example.com');
  assert.equal(siteOf('http://localhost:8080/x'), 'localhost');
  assert.equal(siteOf('chrome://x'), '');
});
