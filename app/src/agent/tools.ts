// The tools the model gets in Chat mode: reading the current page. The page is opened lazily, on the first call,
// so a reply that needs no page never attaches the debugger.
import {tool, type ToolSet} from 'ai';
import {z} from 'zod';
import type {Profile, ToolName} from '../store/types.ts';

export const CHAT_TOOLS: ToolName[] = ['snapshot', 'find', 'read'];

export interface ReadTools {
  snapshot(args: {mode?: 'interactive' | 'all'; window?: 'near' | 'all'}): Promise<{ok: boolean; text: string}>;
  find(args: {role?: string; name?: string; text?: string}): Promise<{ok: boolean; text: string}>;
  read(args: {ref?: string}): Promise<{ok: boolean; text: string}>;
}

export function buildChatTools(profile: Profile, page: () => Promise<ReadTools>): ToolSet {
  const enabled = new Set(profile.tools.filter(t => CHAT_TOOLS.includes(t)));
  const tools: ToolSet = {};
  if (enabled.has('snapshot')) {
    tools.snapshot = tool({
      description: 'Описание текущей страницы: интерактивные элементы с метками вроде [a12] (кнопки, ссылки, поля) и заголовки. '
        + 'mode="all" добавляет текст страницы; window="all" — всю страницу, а не только около экрана.',
      inputSchema: z.object({mode: z.enum(['interactive', 'all']).optional(), window: z.enum(['near', 'all']).optional()}),
      execute: async input => (await (await page()).snapshot(input)).text,
    });
  }
  if (enabled.has('find')) {
    tools.find = tool({
      description: 'Найти элементы на текущей странице по роли (button, link, textbox, heading…), имени или тексту.',
      inputSchema: z.object({role: z.string().optional(), name: z.string().optional(), text: z.string().optional()}),
      execute: async input => (await (await page()).find(input)).text,
    });
  }
  if (enabled.has('read')) {
    tools.read = tool({
      description: 'Прочитать текст текущей страницы в Markdown, целиком или внутри элемента с меткой ref.',
      inputSchema: z.object({ref: z.string().optional()}),
      execute: async input => (await (await page()).read(input)).text,
    });
  }
  return tools;
}

/** The arguments of a tool call in a few words, for the step line in the panel. */
export function describeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  return Object.entries(input as Record<string, unknown>).filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => (k === 'name' || k === 'text' ? `"${String(v)}"` : k === 'ref' ? String(v) : `${k}=${String(v)}`)).join(' ').slice(0, 80);
}
