// Runs chat replies in the service worker: one reply at a time per conversation, streamed to every panel and saved
// as it grows, so closing the panel does not lose it and a worker that stops leaves a reply marked as interrupted.
import type {PanelToWorker, WorkerToPanel} from '../shared/protocol.ts';
import type {StreamReply} from '../llm/stream.ts';
import type {Message, Settings, ToolName, ToolStep} from '../store/types.ts';
import {createConversation, deleteConversation, getConversation, listMessages, listProfiles, putMessage, setConversationProfile} from '../store/assistant-db.ts';
import {systemPrompt} from '../agent/prompt.ts';
import {toModelMessages} from '../agent/history.ts';
import {describeError} from '../llm/ollama.ts';
import {buildChatTools, describeInput, type ReadTools} from '../agent/tools.ts';

/** Model turns in one Chat-mode reply, tool calls included. */
export const CHAT_MAX_STEPS = 5;

export interface PageHandle { tools: ReadTools; release(): Promise<void> }

export interface ChatDeps {
  stream: StreamReply;
  settings: () => Promise<Settings>;
  emit: (event: WorkerToPanel) => void;
  now?: () => number;
  /** How often a growing reply is written to the database; 500 ms by default. */
  saveEveryMs?: number;
  /**
   * Called every `heartbeatMs` while a reply is in progress. Chrome stops an idle service worker after 30 s, and
   * reading a fetch body does not count as activity; with no panel open nothing else would keep the worker alive.
   */
  heartbeat?: () => void;
  heartbeatMs?: number;
  /** Opens the page tools for a tab; without it the model gets no page tools. */
  page?: (tabId: number) => Promise<PageHandle>;
}

interface Run {
  controller: AbortController;
  /** The conversation is being deleted: the reply must not be written again. */
  deleted: boolean;
  finished: Promise<void>;
}

type SendCommand = Extract<PanelToWorker, {type: 'send'}>;

export class ChatRunner {
  #deps: ChatDeps;
  #runs = new Map<string, Run>();
  #active = 0;
  #beat: ReturnType<typeof setInterval> | null = null;

  constructor(deps: ChatDeps) {
    this.#deps = deps;
  }

  running(): string[] {
    return [...this.#runs.keys()];
  }

  stop(conversationId: string): void {
    this.#runs.get(conversationId)?.controller.abort();
  }

  async delete(conversationId: string): Promise<void> {
    const run = this.#runs.get(conversationId);
    if (run) {
      run.deleted = true;
      run.controller.abort();
      await run.finished;
    }
    await deleteConversation(conversationId);
    this.#deps.emit({type: 'deleted', conversationId});
  }

  #setActive(delta: number): void {
    this.#active += delta;
    const {heartbeat} = this.#deps;
    if (!heartbeat) return;
    if (this.#active > 0 && !this.#beat) this.#beat = setInterval(heartbeat, this.#deps.heartbeatMs ?? 20_000);
    if (this.#active === 0 && this.#beat) { clearInterval(this.#beat); this.#beat = null; }
  }

  async send(command: SendCommand): Promise<void> {
    const text = command.text.trim();
    if (!text) return;
    if (command.conversationId && this.#runs.has(command.conversationId)) {
      this.#deps.emit({type: 'busy', requestId: command.requestId, conversationId: command.conversationId});
      return;
    }
    // Claim the conversation before the first await, so a second send cannot start beside this one.
    let release!: () => void;
    const run: Run = {controller: new AbortController(), deleted: false, finished: new Promise(resolve => { release = resolve; })};
    let claimed = command.conversationId;
    if (claimed) this.#runs.set(claimed, run);
    this.#setActive(1);
    try {
      claimed = await this.#reply(command, text, run, id => { claimed = id; this.#runs.set(id, run); });
    } finally {
      if (claimed) this.#runs.delete(claimed);
      this.#setActive(-1);
      release();
    }
  }

  async #reply(command: SendCommand, text: string, run: Run, claim: (id: string) => void): Promise<string> {
    const now = this.#deps.now ?? Date.now;
    const settings = await this.#deps.settings();
    const profiles = await listProfiles();
    const profile = profiles.find(p => p.id === command.profileId) ?? profiles[0];

    let conversation = command.conversationId ? await getConversation(command.conversationId) : undefined;
    if (!conversation) {
      conversation = await createConversation({profileId: profile.id, firstMessage: text});
      claim(conversation.id);
    } else if (conversation.profileId !== profile.id) {
      await setConversationProfile(conversation.id, profile.id);
      conversation = {...conversation, profileId: profile.id};
    }
    const history = await listMessages(conversation.id);
    // Deleted while the awaits above ran: write nothing, so the chat is not brought back.
    if (run.deleted) return conversation.id;

    const at = now();
    const user: Message = {id: crypto.randomUUID(), conversationId: conversation.id, role: 'user', text, reasoning: '', status: 'done', createdAt: at};
    const assistant: Message = {
      id: crypto.randomUUID(), conversationId: conversation.id, role: 'assistant', text: '', reasoning: '',
      status: 'streaming', model: settings.model || undefined, createdAt: at + 1,
    };
    await putMessage(user);
    await putMessage(assistant);
    this.#deps.emit({type: 'started', requestId: command.requestId, conversation, user, assistant});

    if (!settings.model) {
      await this.#finish(run, {...assistant, status: 'failed', error: 'Модель не выбрана — выберите её в настройках.'});
      return conversation.id;
    }

    const reply: Message = {...assistant, steps: []};
    const saveEvery = this.#deps.saveEveryMs ?? 500;
    let savedAt = now();
    // The page is opened on the first tool call and released when the reply ends, whatever way it ends.
    let handle: Promise<PageHandle> | null = null;
    const openPage = (): Promise<ReadTools> => {
      const tabId = command.tabId;
      if (!this.#deps.page) return Promise.resolve(unavailable('Инструменты страницы недоступны.'));
      if (tabId === null || tabId === undefined) return Promise.resolve(unavailable('Нет открытой вкладки рядом с панелью.'));
      handle ??= this.#deps.page(tabId);
      return handle.then(h => h.tools, error => unavailable(error instanceof Error ? error.message : String(error)));
    };
    const tools = this.#deps.page ? buildChatTools(profile, openPage) : {};
    const toolNames = Object.keys(tools) as ToolName[];
    const emitStep = (step: ToolStep) => this.#deps.emit({type: 'step', conversationId: reply.conversationId, messageId: reply.id, step});
    try {
      const parts = this.#deps.stream({
        settings, system: systemPrompt(profile, toolNames), messages: toModelMessages([...history, user]), signal: run.controller.signal,
        tools, maxSteps: CHAT_MAX_STEPS,
      });
      for await (const part of parts) {
        if (part.type === 'tool-call') {
          const step: ToolStep = {id: part.id, name: part.name as ToolName, input: describeInput(part.input), status: 'running', summary: ''};
          reply.steps!.push(step);
          emitStep(step);
          continue;
        }
        if (part.type === 'tool-result') {
          const index = reply.steps!.findIndex(s => s.id === part.id);
          if (index >= 0) {
            reply.steps![index] = {...reply.steps![index], status: part.ok ? 'done' : 'error', summary: part.summary};
            emitStep(reply.steps![index]);
          }
          continue;
        }
        if (part.type === 'text') reply.text += part.delta; else reply.reasoning += part.delta;
        this.#deps.emit({type: 'delta', conversationId: reply.conversationId, messageId: reply.id, text: reply.text, reasoning: reply.reasoning});
        if (now() - savedAt >= saveEvery && !run.deleted) {
          savedAt = now();
          await putMessage({...reply});
        }
      }
      reply.status = run.controller.signal.aborted ? 'stopped' : 'done';
    } catch (error) {
      if (run.controller.signal.aborted) reply.status = 'stopped';
      else { reply.status = 'failed'; reply.error = describeError(error, settings.ollamaUrl); }
    } finally {
      if (handle) await (handle as Promise<PageHandle>).then(h => h.release(), () => {});
    }
    if (!reply.steps!.length) delete reply.steps;
    await this.#finish(run, reply);
    return conversation.id;
  }

  async #finish(run: Run, message: Message): Promise<void> {
    if (run.deleted) return;
    await putMessage(message);
    this.#deps.emit({type: 'finished', conversationId: message.conversationId, message});
  }
}

/** Read tools that answer every call with the same error, when the page cannot be opened. */
function unavailable(reason: string): ReadTools {
  const answer = async () => ({ok: false, text: `ошибка NO_PAGE: ${reason}`});
  return {snapshot: answer, find: answer, read: answer};
}
