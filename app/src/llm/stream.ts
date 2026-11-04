// The model call: one streamed reply through Ollama's OpenAI-compatible address, via the Vercel AI SDK.
import {streamText} from 'ai';
import {createOpenAICompatible} from '@ai-sdk/openai-compatible';
import type {Settings} from '../store/types.ts';

export interface ModelMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type StreamPart = {type: 'text'; delta: string} | {type: 'reasoning'; delta: string};

export type StreamReply = (request: {
  settings: Settings;
  system: string;
  messages: ModelMessage[];
  signal: AbortSignal;
}) => AsyncIterable<StreamPart>;

export const ollamaStream: StreamReply = async function* ({settings, system, messages, signal}) {
  const provider = createOpenAICompatible({name: 'ollama', baseURL: `${settings.ollamaUrl}/v1`});
  const result = streamText({model: provider(settings.model), instructions: system, messages, abortSignal: signal, maxRetries: 1});
  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') yield {type: 'text', delta: part.text};
    else if (part.type === 'reasoning-delta') yield {type: 'reasoning', delta: part.text};
    else if (part.type === 'error') throw part.error;
  }
};
