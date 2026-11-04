// Stored messages turned into what the model is sent: reasoning and failed or unfinished replies stay out.
import type {Message} from '../store/types.ts';
import type {ModelMessage} from '../llm/stream.ts';

const SENT_REPLIES = new Set(['done', 'stopped', 'interrupted']);

export function toModelMessages(messages: Message[]): ModelMessage[] {
  return messages
    .filter(m => m.role === 'user' || (SENT_REPLIES.has(m.status) && m.text.trim() !== ''))
    .map(m => ({role: m.role, content: m.text}));
}
