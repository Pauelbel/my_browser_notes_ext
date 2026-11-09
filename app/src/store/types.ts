// Data shapes of the assistant: settings, profiles, conversations and messages.

export type ToolName = 'snapshot' | 'find' | 'read' | 'locator' | 'screenshot' | 'notes_search' | 'notes_read'
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

export type ChatMode = 'chat' | 'agent';
export type PermissionMode = 'ask' | 'auto';
export type SiteRule = 'allow' | 'ask' | 'block';

export interface Conversation {
  id: string;
  title: string;
  /** The user renamed it; the title no longer follows the first message. */
  titleByUser: boolean;
  profileId: string;
  /** chat: answers and reads; agent: acts on pages. */
  mode: ChatMode;
  /** In agent mode: ask before dangerous actions, or act on its own (site rules still apply). */
  permission: PermissionMode;
  createdAt: number;
  updatedAt: number;
}

/** A tool call the model made while answering, as shown in the panel. */
export interface ToolStep {
  id: string;
  name: ToolName;
  /** The arguments in a few words, for display. */
  input: string;
  /** The arguments as called, for the history the model is sent (absent when large, or in steps saved before). */
  args?: unknown;
  status: 'running' | 'done' | 'error' | 'uncertain';
  /** The first line of the result, or the error. */
  summary: string;
}

export type MessageStatus = 'streaming' | 'done' | 'stopped' | 'failed' | 'interrupted';

/** Approximate tokens that would occupy the model context for this state of the chat. */
export interface ContextUsage {
  used: number;
  limit: number;
  system: number;
  tools: number;
  history: number;
}

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
  steps?: ToolStep[];
  context?: ContextUsage;
  createdAt: number;
}

export interface Settings {
  ollamaUrl: string;
  model: string;
  siteRules: Record<string, SiteRule>;
  /** Draw a frame around the page the agent works on. */
  border: boolean;
}
