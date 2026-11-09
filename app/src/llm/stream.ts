// The model call: one streamed reply through Ollama's OpenAI-compatible address, via the Vercel AI SDK.
import {streamText, stepCountIs, type ToolSet} from 'ai';
import {createOpenAICompatible} from '@ai-sdk/openai-compatible';
import type {Settings} from '../store/types.ts';

/** Earlier steps go to the model as the calls they were, each followed by its short result. */
export type HistoryPart = {type: 'text'; text: string} | {type: 'tool-call'; toolCallId: string; toolName: string; input: unknown};
export interface ToolResultPart { type: 'tool-result'; toolCallId: string; toolName: string; output: {type: 'text'; value: string} }
export type ModelMessage =
  | {role: 'user'; content: string}
  | {role: 'assistant'; content: string | HistoryPart[]}
  | {role: 'tool'; content: ToolResultPart[]};

export type StreamPart =
  | {type: 'text'; delta: string}
  | {type: 'reasoning'; delta: string}
  | {type: 'tool-call'; id: string; name: string; input: unknown}
  | {type: 'tool-result'; id: string; ok: boolean; summary: string; /** Full output for strict host-side contracts. */ value?: string}
  /** One model turn finished (tool calls included). */
  | {type: 'step'};

export type StreamReply = (request: {
  settings: Settings;
  system: string;
  messages: ModelMessage[];
  signal: AbortSignal;
  tools?: ToolSet;
  /** Model turns allowed in one reply, tool calls included. */
  maxSteps?: number;
  /** The loop also ends after a call to this tool (the agent's `done`). */
  stopOnTool?: string;
  /** Rewrites the history before each model turn (to keep long runs within the context). */
  prepareMessages?: <T>(messages: T[]) => T[];
}) => AsyncIterable<StreamPart>;

/**
 * Loop options for streamText: tools, the step cap, the stop on a tool (done), and the history rewrite. AI SDK v7
 * carries a returned history forward to later steps, so each step is rebuilt from the original messages and the
 * responses so far; the rewrite then never works on its own earlier output (no duplicated images or marks).
 */
export function loopOptions(o: {tools?: ToolSet; maxSteps?: number; stopOnTool?: string; prepareMessages?: <T>(messages: T[]) => T[]}): Record<string, unknown> {
  const {tools, maxSteps = 1, stopOnTool, prepareMessages} = o;
  if (!tools || !Object.keys(tools).length) return {};
  return {
    tools,
    stopWhen: stopOnTool
      ? [stepCountIs(maxSteps), ({steps}: {steps: {toolCalls?: {toolName: string}[]}[]}) => Boolean(steps.at(-1)?.toolCalls?.some(c => c.toolName === stopOnTool))]
      : stepCountIs(maxSteps),
    ...(prepareMessages ? {prepareStep: ({initialMessages, responseMessages}: {initialMessages: unknown[]; responseMessages: unknown[]}) =>
      ({messages: prepareMessages([...initialMessages, ...responseMessages])})} : {}),
  };
}

export const ollamaStream: StreamReply = async function* ({settings, system, messages, signal, tools, maxSteps = 1, stopOnTool, prepareMessages}) {
  const provider = createOpenAICompatible({name: 'ollama', baseURL: `${settings.ollamaUrl}/v1`});
  const result = streamText({model: provider(settings.model), instructions: system, messages, abortSignal: signal, maxRetries: 1,
    ...loopOptions({tools, maxSteps, stopOnTool, prepareMessages})} as Parameters<typeof streamText>[0]);
  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') yield {type: 'text', delta: part.text};
    else if (part.type === 'reasoning-delta') yield {type: 'reasoning', delta: part.text};
    else if (part.type === 'tool-call') yield {type: 'tool-call', id: part.toolCallId, name: part.toolName, input: part.input};
    else if (part.type === 'tool-result') {
      const value = String(part.output ?? '');
      yield {type: 'tool-result', id: part.toolCallId, ok: !value.startsWith('ошибка'), summary: summarizeResult(value), value};
    }
    else if (part.type === 'tool-error') yield {type: 'tool-result', id: part.toolCallId, ok: false, summary: summarizeResult(part.error instanceof Error ? part.error.message : part.error)};
    else if (part.type === 'finish-step') yield {type: 'step'};
    else if (part.type === 'error') throw part.error;
  }
};

/** Compact persisted action trace: the meaningful line plus the machine receipt, never the page block marker. */
export function summarizeResult(value: unknown): string {
  const text = String(value ?? '');
  const lines = text.split('\n').map(s => s.trim()).filter(s => s && s !== '<<<page-content>>>' && s !== '<<<end-page-content>>>');
  const head = lines.find(s => !s.startsWith('[action-receipt ')) ?? '';
  const receipt = lines.find(s => s.startsWith('[action-receipt ')) ?? '';
  return [head.slice(0, 220), receipt.slice(0, 260)].filter(Boolean).join(' · ').slice(0, 480);
}
