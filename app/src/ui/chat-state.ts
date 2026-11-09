// The open chat as the panel sees it, advanced by the worker's events. Pure, so it is tested without a browser.
import type {PendingPrompt, WorkerToPanel} from '../shared/protocol.ts';
import type {Message} from '../store/types.ts';

export interface ChatState {
  conversationId: string | null;
  /** The send this panel is waiting to see started; it adopts a new conversation by it. */
  pendingRequestId: string | null;
  messages: Message[];
  running: boolean;
  /** The agent's open questions in this chat. */
  prompts: PendingPrompt[];
}

export const emptyChat: ChatState = {conversationId: null, pendingRequestId: null, messages: [], running: false, prompts: []};

function upsert(messages: Message[], message: Message): Message[] {
  const index = messages.findIndex(m => m.id === message.id);
  if (index === -1) return [...messages, message];
  const next = [...messages];
  next[index] = message;
  return next;
}

export function applyEvent(state: ChatState, event: WorkerToPanel): ChatState {
  switch (event.type) {
    case 'running': {
      const running = state.conversationId !== null && event.conversationIds.includes(state.conversationId);
      const prompts = (event.prompts ?? []).filter(p => p.conversationId === state.conversationId);
      if (running) return {...state, running, prompts};
      // The worker that sent this has no reply in progress here: a reply still streaming on screen died with the old one.
      const messages = state.messages.some(m => m.status === 'streaming')
        ? state.messages.map(m => m.status === 'streaming' ? {...m, status: 'interrupted' as const} : m)
        : state.messages;
      return {...state, running, messages, prompts};
    }
    case 'deleted':
      return event.conversationId === state.conversationId ? emptyChat : state;
    case 'started': {
      const mine = event.requestId === state.pendingRequestId;
      if (!mine && event.conversation.id !== state.conversationId) return state;
      return {
        conversationId: event.conversation.id,
        pendingRequestId: mine ? null : state.pendingRequestId,
        messages: upsert(upsert(state.messages, event.user), event.assistant),
        running: true,
        prompts: mine ? [] : state.prompts,
      };
    }
    case 'delta': {
      if (event.conversationId !== state.conversationId) return state;
      const current = state.messages.find(m => m.id === event.messageId);
      if (!current) return state;
      return {...state, messages: upsert(state.messages, {...current, text: event.text, reasoning: event.reasoning})};
    }
    case 'finished':
      if (event.conversationId !== state.conversationId) return state;
      return {...state, messages: upsert(state.messages, event.message), running: false};
    case 'step': {
      if (event.conversationId !== state.conversationId) return state;
      const message = state.messages.find(m => m.id === event.messageId);
      if (!message) return state;
      const steps = [...(message.steps ?? [])];
      const index = steps.findIndex(s => s.id === event.step.id);
      if (index === -1) steps.push(event.step); else steps[index] = event.step;
      return {...state, messages: upsert(state.messages, {...message, steps})};
    }
    case 'context': {
      if (event.conversationId !== state.conversationId) return state;
      const message = state.messages.find(m => m.id === event.messageId);
      return message ? {...state, messages: upsert(state.messages, {...message, context: event.context})} : state;
    }
    case 'prompt':
      return event.prompt.conversationId === state.conversationId ? {...state, prompts: [...state.prompts.filter(p => p.id !== event.prompt.id), event.prompt]} : state;
    case 'prompt-closed':
      return state.prompts.some(p => p.id === event.promptId) ? {...state, prompts: state.prompts.filter(p => p.id !== event.promptId)} : state;
    case 'busy':
      return event.requestId === state.pendingRequestId ? {...state, pendingRequestId: null} : state;
  }
}
