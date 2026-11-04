import {test} from 'node:test';
import assert from 'node:assert/strict';
import {listModels, checkOllama, describeError} from '../src/llm/ollama.ts';

/** A fetch that answers by path: an object becomes a JSON body, a number becomes that status. */
function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    if (!(path in routes)) return new Response('not found', {status: 404});
    const route = routes[path];
    if (typeof route === 'number') return new Response('', {status: route});
    return new Response(JSON.stringify(route), {status: 200, headers: {'content-type': 'application/json'}});
  }) as typeof fetch;
}

test('listModels сортирует имена', async () => {
  const f = fakeFetch({'/api/tags': {models: [{name: 'qwen3.5:35b-a3b'}, {name: 'llama3.2:3b'}]}});
  assert.deepEqual(await listModels('http://x', f), ['llama3.2:3b', 'qwen3.5:35b-a3b']);
});

test('checkOllama предупреждает о маленьком контексте', async () => {
  const f = fakeFetch({'/api/tags': {models: [{name: 'm'}]}, '/api/ps': {models: [{name: 'm', context_length: 4096}]}});
  const r = await checkOllama('http://x', 'm', f);
  assert.equal(r.ok, true);
  assert.match(r.ok ? r.warning ?? '' : '', /OLLAMA_CONTEXT_LENGTH/);
});

test('checkOllama без предупреждения при достаточном контексте', async () => {
  const f = fakeFetch({'/api/tags': {models: [{name: 'm'}]}, '/api/ps': {models: [{name: 'm', context_length: 32768}]}});
  assert.deepEqual(await checkOllama('http://x', 'm', f), {ok: true, models: ['m']});
});

test('checkOllama предупреждает, если модели нет', async () => {
  const r = await checkOllama('http://x', 'нет', fakeFetch({'/api/tags': {models: [{name: 'm'}]}, '/api/ps': {models: []}}));
  assert.match(r.ok ? r.warning ?? '' : '', /не найдена/);
});

test('describeError: 403 → OLLAMA_ORIGINS', () => {
  assert.match(describeError(new Response('', {status: 403}), 'http://x'), /OLLAMA_ORIGINS=chrome-extension:\/\/\*/);
  assert.match(describeError({statusCode: 403, message: 'Forbidden'}, 'http://x'), /OLLAMA_ORIGINS/);
});

test('describeError: 404 → модель не найдена', () => {
  assert.match(describeError({statusCode: 404, message: 'model "x" not found'}, 'http://x'), /[Мм]одель не найдена/);
});

test('describeError: сеть недоступна → адрес и «запущена ли Ollama»', () => {
  const text = describeError(new TypeError('Failed to fetch'), 'http://localhost:11434');
  assert.match(text, /localhost:11434/);
  assert.match(text, /запущена/);
});

test('describeError: прочее — сообщение ошибки', () => {
  assert.equal(describeError(new Error('что-то'), 'http://x'), 'что-то');
});

test('checkOllama при 403 возвращает ok:false с подсказкой', async () => {
  const r = await checkOllama('http://x', '', fakeFetch({'/api/tags': 403}));
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.error, /OLLAMA_ORIGINS/);
});
