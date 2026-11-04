// The model call: one streamed reply through Ollama's OpenAI-compatible address, via the Vercel AI SDK.
import {streamText, stepCountIs, type ToolSet} from 'ai';
import {createOpenAICompatible} from '@ai-sdk/openai-compatible';
import type {Settings} from '../store/types.ts';

export interface ModelMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type StreamPart =
  | {type: 'text'; delta: string}
  | {type: 'reasoning'; delta: string}
  | {type: 'tool-call'; id: string; name: string; input: unknown}
  | {type: 'tool-result'; id: string; ok: boolean; summary: string};

export type StreamReply = (request: {
  settings: Settings;
  system: string;
  messages: ModelMessage[];
  signal: AbortSignal;
  tools?: ToolSet;
  /** Model turns allowed in one reply, tool calls included. */
  maxSteps?: number;
}) => AsyncIterable<StreamPart>;

export const ollamaStream: StreamReply = async function* ({settings, system, messages, signal, tools, maxSteps = 1}) {
  const provider = createOpenAICompatible({name: 'ollama', baseURL: `${settings.ollamaUrl}/v1`});
  const result = streamText({model: provider(settings.model), instructions: system, messages, abortSignal: signal, maxRetries: 1,
    ...(tools && Object.keys(tools).length ? {tools, stopWhen: stepCountIs(maxSteps)} : {})});
  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') yield {type: 'text', delta: part.text};
    else if (part.type === 'reasoning-delta') yield {type: 'reasoning', delta: part.text};
    else if (part.type === 'tool-call') yield {type: 'tool-call', id: part.toolCallId, name: part.toolName, input: part.input};
    else if (part.type === 'tool-result') yield {type: 'tool-result', id: part.toolCallId, ok: !String(part.output).startsWith('ошибка'), summary: firstLine(part.output)};
    else if (part.type === 'tool-error') yield {type: 'tool-result', id: part.toolCallId, ok: false, summary: firstLine(part.error instanceof Error ? part.error.message : part.error)};
    else if (part.type === 'error') throw part.error;
  }
};

function firstLine(value: unknown): string {
  return String(value ?? '').split('\n')[0].slice(0, 160);
}
