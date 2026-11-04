// Data shapes of the assistant: settings, profiles, conversations and messages.

export type ToolName = 'snapshot' | 'find' | 'read' | 'screenshot' | 'notes_search' | 'notes_read'
  | 'tabs' | 'navigate' | 'click' | 'hover' | 'scroll' | 'type' | 'set' | 'press' | 'wait' | 'handle_dialog'
  | 'highlight' | 'clear_highlights' | 'ask_user' | 'notes_create' | 'notes_append' | 'done'
  | 'console_log' | 'network_log' | 'page_checks';

export interface Profile {
  id: string;
  name: string;
  /** The role part of the system prompt; the common rules are added to it automatically. */
  prompt: string;
  tools: ToolName[];
  createdAt: number;
}

export interface Conversation {
  id: string;
  title: string;
  /** The user renamed it; the title no longer follows the first message. */
  titleByUser: boolean;
  profileId: string;
  createdAt: number;
  updatedAt: number;
}

export type MessageStatus = 'streaming' | 'done' | 'stopped' | 'failed' | 'interrupted';

export interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  text: string;
  /** The model's reasoning, shown collapsed and never sent back to the model. */
  reasoning: string;
  status: MessageStatus;
  error?: string;
  model?: string;
  createdAt: number;
}

export interface Settings {
  ollamaUrl: string;
  model: string;
}
