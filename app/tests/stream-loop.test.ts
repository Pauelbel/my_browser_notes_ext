import {test} from 'node:test';
import assert from 'node:assert/strict';
import {streamText, tool} from 'ai';
import {MockLanguageModelV4} from 'ai/test';
import {z} from 'zod';
import {loopOptions} from '../src/llm/stream.ts';
import {estimateTokens, fitToContext} from '../src/agent/elision.ts';
import {ScreenshotStore} from '../src/agent/screenshots.ts';

const usage = {inputTokens: {total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0}, outputTokens: {total: 1, text: 1, reasoning: 0}};

test('40 шагов настоящего цикла AI SDK: одна картинка, одна пометка на квитанцию, история в пределах', async () => {
  const CTX = 32768;
  const shots = new ScreenshotStore();
  const prompts: any[] = [];
  let call = 0;
  const model = new MockLanguageModelV4({doStream: async (opts: any) => {
    prompts.push(opts.prompt);
    const n = call++;
    const name = n === 0 ? 'screenshot' : n % 2 ? 'snapshot' : 'click';
    const chunks: any[] = n < 39
      ? [{type: 'stream-start', warnings: []}, {type: 'tool-call', toolCallId: `t${n}`, toolName: name, input: '{}'}, {type: 'finish', finishReason: {unified: 'tool-calls', raw: 'tool_calls'}, usage}]
      : [{type: 'stream-start', warnings: []}, {type: 'text-start', id: 'x'}, {type: 'text-delta', id: 'x', delta: 'ok'}, {type: 'text-end', id: 'x'}, {type: 'finish', finishReason: {unified: 'stop', raw: 'stop'}, usage}];
    return {stream: new ReadableStream({start(c) { chunks.forEach(x => c.enqueue(x)); c.close(); }})};
  }}) as any;
  const tools = {
    screenshot: tool({inputSchema: z.object({}), execute: async () => { shots.put('A'.repeat(1000)); return 'скриншот сделан'; }}),
    snapshot: tool({inputSchema: z.object({}), execute: async () => `<<<page-content>>>\n${'S'.repeat(8000)}\n<<<end-page-content>>>`}),
    click: tool({inputSchema: z.object({}), execute: async () => `<<<page-content>>>\nclick [a1] button "Ок": событие отправлено\nизменения:\n+ ${'x'.repeat(600)}\n<<<end-page-content>>>`}),
  };
  const r = streamText({model, messages: [{role: 'user', content: 'найди баги'}],
    ...loopOptions({tools, maxSteps: 40, prepareMessages: m => shots.inject(fitToContext(m, CTX))})} as any);
  for await (const _ of r.fullStream) { /* drain */ }
  assert.equal(prompts.length, 40);
  for (const [i, p] of prompts.entries()) {
    const images = p.flatMap((m: any) => Array.isArray(m.content) ? m.content : []).filter((x: any) => x.type === 'file' || x.type === 'image').length;
    assert.ok(images <= 1, `шаг ${i}: картинок ${images}`);
    const receipts = p.flatMap((m: any) => m.role === 'tool' ? m.content : []).filter((x: any) => x.toolName === 'click');
    for (const rc of receipts) assert.ok((JSON.stringify(rc.output).match(/подробности скрыты/g) ?? []).length <= 1, `шаг ${i}: пометка повторилась`);
    assert.ok(estimateTokens(p) <= 0.7 * CTX + 1000, `шаг ${i}: оценка ${estimateTokens(p)}`);
  }
});
