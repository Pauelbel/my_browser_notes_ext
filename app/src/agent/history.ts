// Stored messages turned into what the model is sent. Reasoning and failed or unfinished replies stay out. A reply's
// steps go as real tool calls with their short results, so a continued task knows what was already done — and the
// model sees its actions as calls, not as text it wrote (a steps line in the text taught it to write "(Шаги: …)"
// instead of calling a tool). With a budget, every message of the user stays word for word and the assistant's older
// replies are shortened first, then their steps go.
import type {Message, ToolStep} from '../store/types.ts';
import type {HistoryPart, ModelMessage, ToolResultPart} from '../llm/stream.ts';

const SENT_REPLIES = new Set(['done', 'stopped', 'interrupted']);
const STEPS_MAX = 20;
const SHORT_REPLY = 300;
const LINE_REPLY = 120;
// Order of shortening: older replies to 300 characters, then to one line, then hidden, then their steps dropped —
// never a user's message.

/** The summary of a step that was running when its reply ended. */
export const UNFINISHED = 'не завершён: ответ прерван';

/** The first step and the latest ones: what a continued task most needs is what happened last. */
function shownSteps(steps: ToolStep[]): {shown: ToolStep[]; omitted: number} {
  if (steps.length <= STEPS_MAX) return {shown: steps, omitted: 0};
  return {shown: [steps[0], ...steps.slice(-(STEPS_MAX - 1))], omitted: steps.length - STEPS_MAX};
}

/** A step that was still running when the reply ended may or may not have happened: its result says so. */
function resultOf(s: ToolStep): string {
  if (s.status === 'running' || s.summary === UNFINISHED) return UNFINISHED;
  if (s.status === 'uncertain') return s.summary || 'результат действия неизвестен; сначала проверьте состояние';
  return s.summary || (s.status === 'error' ? 'ошибка' : 'готово');
}

interface Reply { text: number; steps?: [number, number] }

function replyMessages(m: Message, out: ModelMessage[]): Reply {
  const end = !m.steps?.length ? '' : m.status === 'interrupted' ? '(ответ прерван)' : m.status === 'stopped' ? '(остановлено пользователем)' : '';
  const text = [m.text.trim() ? m.text.trimEnd() : '', end].filter(Boolean).join('\n\n');
  const reply: Reply = {text: -1};
  if (m.steps?.length) {
    const {shown, omitted} = shownSteps(m.steps);
    const calls: HistoryPart[] = [
      ...(omitted ? [{type: 'text' as const, text: `(пропущено шагов: ${omitted})`}] : []),
      ...shown.map(s => ({type: 'tool-call' as const, toolCallId: s.id, toolName: s.name, input: s.args ?? {}})),
    ];
    const results: ToolResultPart[] = shown.map(s => ({type: 'tool-result', toolCallId: s.id, toolName: s.name, output: {type: 'text', value: resultOf(s)}}));
    out.push({role: 'assistant', content: calls}, {role: 'tool', content: results});
    reply.steps = [out.length - 2, out.length - 1];
  }
  if (text) { out.push({role: 'assistant', content: text}); reply.text = out.length - 1; }
  return reply;
}

const length = (m: ModelMessage) => (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length);
const size = (messages: ModelMessage[]) => Math.ceil(messages.reduce((sum, m) => sum + length(m), 0) / 4);

export function toModelMessages(messages: Message[], budgetTokens?: number): ModelMessage[] {
  const out: ModelMessage[] = [];
  const replies: Reply[] = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({role: 'user', content: m.text});
    else if (SENT_REPLIES.has(m.status) && (m.text.trim() !== '' || Boolean(m.steps?.length))) replies.push(replyMessages(m, out));
  }
  if (!budgetTokens || size(out) <= budgetTokens) return out;
  // The latest reply stays whole: it is what the next question most likely refers to.
  const older = replies.slice(0, -1);
  const texts = older.map(r => r.text).filter(i => i >= 0);
  for (const [limit, mark] of [[SHORT_REPLY, '…[ответ сокращён]'], [LINE_REPLY, '…[сокращено]']] as const) {
    for (const i of texts) {
      if (size(out) <= budgetTokens) return out;
      const content = out[i].content as string;
      if (content.length > limit) out[i] = {role: 'assistant', content: `${content.slice(0, limit).trimEnd()}${mark}`};
    }
  }
  // Still too long: the oldest replies are left out altogether; the questions they answered stay.
  for (const i of texts) {
    if (size(out) <= budgetTokens) return out;
    out[i] = {role: 'assistant', content: '[ответ скрыт]'};
  }
  // Then the steps of older replies, oldest first; a call never stays without its result.
  const dropped = new Set<number>();
  const kept = () => out.filter((_, i) => !dropped.has(i));
  for (const r of older) {
    if (size(kept()) <= budgetTokens) break;
    if (r.steps) { dropped.add(r.steps[0]); dropped.add(r.steps[1]); }
  }
  return kept();
}
