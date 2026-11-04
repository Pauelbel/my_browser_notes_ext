// The open chat as the panel sees it, advanced by the worker's events. Pure, so it is tested without a browser.
import type {WorkerToPanel} from '../shared/protocol.ts';
import type {Message} from '../store/types.ts';

export interface ChatState {
  conversationId: string | null;
  /** The send this panel is waiting to see started; it adopts a new conversation by it. */
  pendingRequestId: string | null;
  messages: Message[];
  running: boolean;
}

export const emptyChat: ChatState = {conversationId: null, pendingRequestId: null, messages: [], running: false};

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
      if (running) return {...state, running};
      // The worker that sent this has no reply in progress here: a reply still streaming on screen died with the old one.
      const messages = state.messages.some(m => m.status === 'streaming')
        ? state.messages.map(m => m.status === 'streaming' ? {...m, status: 'interrupted' as const} : m)
        : state.messages;
      return {...state, running, messages};
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
    case 'busy':
      return event.requestId === state.pendingRequestId ? {...state, pendingRequestId: null} : state;
  }
}
