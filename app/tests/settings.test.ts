import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_SETTINGS, getSettings, saveSettings, normalizeOllamaUrl, type KeyValueArea} from '../src/store/settings.ts';

function fakeArea(): KeyValueArea {
  const map = new Map<string, unknown>();
  return {
    async get(key: unknown) { const k = String(key); return map.has(k) ? {[k]: structuredClone(map.get(k))} : {}; },
    async set(items: Record<string, unknown>) { for (const [k, v] of Object.entries(items)) map.set(k, structuredClone(v)); },
  } as unknown as KeyValueArea;
}

test('normalizeOllamaUrl', () => {
  assert.equal(normalizeOllamaUrl(' localhost:11434/ '), 'http://localhost:11434');
  assert.equal(normalizeOllamaUrl('http://127.0.0.1:11434/v1/'), 'http://127.0.0.1:11434');
  assert.equal(normalizeOllamaUrl(''), DEFAULT_SETTINGS.ollamaUrl);
});

test('getSettings без сохранённого даёт значения по умолчанию, saveSettings сливает и нормализует', async () => {
  const area = fakeArea();
  assert.deepEqual(await getSettings(area), DEFAULT_SETTINGS);
  const saved = await saveSettings({ollamaUrl: '127.0.0.1:1/'}, area);
  assert.deepEqual(saved, {...DEFAULT_SETTINGS, ollamaUrl: 'http://127.0.0.1:1'});
  assert.deepEqual(await getSettings(area), saved);
});

test('правила сайтов и рамка: значения по умолчанию, добавление и удаление правила', async () => {
  const {setSiteRule} = await import('../src/store/settings.ts');
  const area = fakeArea();
  const initial = await getSettings(area);
  assert.deepEqual(initial.siteRules, {});
  assert.equal(initial.border, true);
  assert.deepEqual((await setSiteRule('example.com', 'allow', area)).siteRules, {'example.com': 'allow'});
  assert.deepEqual((await setSiteRule('example.com', null, area)).siteRules, {});
});
