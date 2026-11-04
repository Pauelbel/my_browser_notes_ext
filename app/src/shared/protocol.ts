// Messages between the panel and the service worker over the `assistant` runtime port.
import type {Conversation, Message} from '../store/types.ts';

export const PORT_NAME = 'assistant';

export type PanelToWorker =
  | {type: 'send'; requestId: string; conversationId: string | null; text: string; profileId: string}
  | {type: 'stop'; conversationId: string}
  | {type: 'delete'; conversationId: string};

export type WorkerToPanel =
  | {type: 'running'; conversationIds: string[]}
  | {type: 'started'; requestId: string; conversation: Conversation; user: Message; assistant: Message}
  /** The whole text so far, not an increment: a panel that joins mid-reply catches up from any delta. */
  | {type: 'delta'; conversationId: string; messageId: string; text: string; reasoning: string}
  | {type: 'finished'; conversationId: string; message: Message}
  | {type: 'busy'; requestId: string; conversationId: string};
