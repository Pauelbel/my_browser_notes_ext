// Messages between the panel and the service worker over the `assistant` runtime port.
import type {ChatMode, Conversation, Message, PermissionMode, ToolStep} from '../store/types.ts';
import type {Category} from '../page/classify.ts';

/** A question from a running agent to the user, waiting in the worker. */
export interface PendingPrompt { id: string; conversationId: string; kind: 'confirm' | 'takeover' | 'input'; text: string; site?: string; category?: Category }
export type PanelAnswer = 'allow' | 'allow-site' | 'deny' | 'done' | 'cancel' | {text: string};

export const PORT_NAME = 'assistant';

export type PanelToWorker =
  /** `tabId` is the active tab of the panel's window: the page the read tools look at. */
  | {type: 'send'; requestId: string; conversationId: string | null; text: string; profileId: string; tabId?: number | null; mode?: ChatMode; permission?: PermissionMode}
  | {type: 'answer'; promptId: string; answer: PanelAnswer}
  | {type: 'mode'; conversationId: string; mode: ChatMode; permission: PermissionMode}
  | {type: 'stop'; conversationId: string}
  /** `tabId` lets deletion also remove a highlight left by older versions that did not remember its tab. */
  | {type: 'delete'; conversationId: string; tabId?: number | null};

export type WorkerToPanel =
  | {type: 'running'; conversationIds: string[]; prompts?: PendingPrompt[]}
  | {type: 'started'; requestId: string; conversation: Conversation; user: Message; assistant: Message}
  /** The whole text so far, not an increment: a panel that joins mid-reply catches up from any delta. */
  | {type: 'delta'; conversationId: string; messageId: string; text: string; reasoning: string}
  | {type: 'finished'; conversationId: string; message: Message}
  | {type: 'busy'; requestId: string; conversationId: string}
  | {type: 'step'; conversationId: string; messageId: string; step: ToolStep}
  | {type: 'context'; conversationId: string; messageId: string; context: NonNullable<Message['context']>}
  | {type: 'deleted'; conversationId: string}
  | {type: 'prompt'; prompt: PendingPrompt}
  | {type: 'prompt-closed'; promptId: string};
