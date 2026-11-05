// Stored messages turned into what the model is sent. Reasoning and failed or unfinished replies stay out; an agent
// reply carries a short list of its steps, so a continued task knows what was already done. With a budget, every
// message of the user stays word for word and the assistant's older replies are shortened first.
import type {Message} from '../store/types.ts';
import type {ModelMessage} from '../llm/stream.ts';

const SENT_REPLIES = new Set(['done', 'stopped', 'interrupted']);
const STEPS_MAX = 20;
const SHORT_REPLY = 300;
const LINE_REPLY = 120;
// Order of shortening: older replies to 300 characters, then to one line, then hidden — never a user's message.

/** The first step and the latest ones: what a continued task most needs is what happened last. A step that was
 * still running when the reply ended is marked: it may or may not have happened. */
function stepsLine(m: Message): string {
  if (!m.steps?.length) return '';
  const label = (s: NonNullable<Message['steps']>[number]) => `${s.name}${s.input ? ` ${s.input}` : ''}${s.status === 'running' || s.summary === UNFINISHED ? ' (не завершён)' : s.status === 'error' ? ' (ошибка)' : ''}`;
  const all = m.steps;
  const shown = all.length > STEPS_MAX ? [label(all[0]), `… ещё ${all.length - STEPS_MAX}`, ...all.slice(-(STEPS_MAX - 1)).map(label)] : all.map(label);
  const end = m.status === 'interrupted' ? ' (прервано)' : m.status === 'stopped' ? ' (остановлено)' : '';
  return `Шаги: ${shown.join(' · ')}${end}`;
}

/** The summary of a step that was running when its reply ended. */
export const UNFINISHED = 'не завершён: ответ прерван';

function replyContent(m: Message): string {
  const steps = stepsLine(m);
  if (!steps) return m.text;
  return m.text.trim() ? `${m.text.trimEnd()}\n\n(${steps})` : steps;
}

const size = (messages: ModelMessage[]) => Math.ceil(messages.reduce((sum, m) => sum + m.content.length, 0) / 4);

export function toModelMessages(messages: Message[], budgetTokens?: number): ModelMessage[] {
  const out: ModelMessage[] = messages
    .filter(m => m.role === 'user' || (SENT_REPLIES.has(m.status) && (m.text.trim() !== '' || Boolean(m.steps?.length))))
    .map(m => ({role: m.role, content: m.role === 'user' ? m.text : replyContent(m)}));
  if (!budgetTokens || size(out) <= budgetTokens) return out;
  // The latest reply stays whole: it is what the next question most likely refers to.
  const lastReply = out.map(m => m.role).lastIndexOf('assistant');
  const older = out.map((m, i) => (m.role === 'assistant' && i !== lastReply ? i : -1)).filter(i => i >= 0);
  for (const [limit, mark] of [[SHORT_REPLY, '…[ответ сокращён]'], [LINE_REPLY, '…[сокращено]']] as const) {
    for (const i of older) {
      if (size(out) <= budgetTokens) return out;
      if (out[i].content.length > limit) out[i] = {...out[i], content: `${out[i].content.slice(0, limit).trimEnd()}${mark}`};
    }
  }
  // Still too long: the oldest replies are left out altogether; the questions they answered stay.
  for (const i of older) {
    if (size(out) <= budgetTokens) return out;
    out[i] = {...out[i], content: '[ответ скрыт]'};
  }
  return out;
}
