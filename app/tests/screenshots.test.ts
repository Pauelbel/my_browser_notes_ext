import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ScreenshotStore} from '../src/agent/screenshots.ts';
import {modelCapabilities} from '../src/llm/ollama.ts';
import {buildAgentTools, buildChatTools} from '../src/agent/tools.ts';
import {DEFAULT_PROFILES} from '../src/agent/profiles.ts';

const shotResult = (id: string) => ({role: 'tool', content: [{type: 'tool-result', toolCallId: id, toolName: 'screenshot', output: {type: 'text', value: 'скриншот сделан'}}]});

test('в истории остаётся последний скриншот', () => {
  const store = new ScreenshotStore();
  store.put('AAA');
  store.put('BBB');
  const messages: any[] = [{role: 'user', content: 'найди баги'}, shotResult('1'), {role: 'assistant', content: 'смотрю'}, shotResult('2'), {role: 'assistant', content: 'дальше'}];
  const out = store.inject(messages) as any[];
  const images = out.filter(m => m.role === 'user' && Array.isArray(m.content));
  assert.equal(images.length, 1);
  assert.equal(out.indexOf(images[0]), 4, 'сразу после последнего результата screenshot');
  assert.equal(images[0].content.find((p: any) => p.type === 'image').image, 'BBB');
  assert.equal(new ScreenshotStore().inject(messages), messages, 'без скриншота история не меняется');
});

test('modelCapabilities из /api/show', async () => {
  const f = (async () => new Response(JSON.stringify({capabilities: ['completion', 'vision', 'tools']}))) as unknown as typeof fetch;
  assert.deepEqual(await modelCapabilities('http://x', 'm', f), ['completion', 'vision', 'tools']);
  const broken = (async () => new Response('', {status: 500})) as unknown as typeof fetch;
  assert.deepEqual(await modelCapabilities('http://x', 'm', broken), []);
});

test('screenshot только для моделей с vision', () => {
  const qa = DEFAULT_PROFILES[1];
  const notes = {search: async () => '', read: async () => '', create: async () => '', append: async () => ''};
  const page = async () => { throw new Error('не нужно'); };
  assert.ok(!('screenshot' in buildChatTools({...qa, tools: [...qa.tools, 'screenshot']}, page, notes)));
  assert.ok('screenshot' in buildChatTools({...qa, tools: [...qa.tools, 'screenshot']}, page, notes, {vision: true, screenshots: new ScreenshotStore()}));
  const ctx = {tabs: {current: page, list: page, open: page, switch: page, close: page}, notes, ask: page, confirmNotes: page} as any;
  assert.ok(!('screenshot' in buildAgentTools(qa, ctx)));
  assert.ok('screenshot' in buildAgentTools(qa, {...ctx, vision: true, screenshots: new ScreenshotStore()}));
});
