// Runs chat replies in the service worker: one reply at a time per conversation, streamed to every panel and saved
// as it grows, so closing the panel does not lose it and a worker that stops leaves a reply marked as interrupted.
import type {PanelToWorker, WorkerToPanel} from '../shared/protocol.ts';
import type {StreamReply} from '../llm/stream.ts';
import type {Message, Settings} from '../store/types.ts';
import {createConversation, deleteConversation, getConversation, listMessages, listProfiles, putMessage, setConversationProfile} from '../store/assistant-db.ts';
import {systemPrompt} from '../agent/prompt.ts';
import {toModelMessages} from '../agent/history.ts';
import {describeError} from '../llm/ollama.ts';

export interface ChatDeps {
  stream: StreamReply;
  settings: () => Promise<Settings>;
  emit: (event: WorkerToPanel) => void;
  now?: () => number;
  /** How often a growing reply is written to the database; 500 ms by default. */
  saveEveryMs?: number;
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
    try {
      claimed = await this.#reply(command, text, run, id => { claimed = id; this.#runs.set(id, run); });
    } finally {
      if (claimed) this.#runs.delete(claimed);
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

    const reply = {...assistant};
    const saveEvery = this.#deps.saveEveryMs ?? 500;
    let savedAt = now();
    try {
      const parts = this.#deps.stream({
        settings, system: systemPrompt(profile), messages: toModelMessages([...history, user]), signal: run.controller.signal,
      });
      for await (const part of parts) {
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
    }
    await this.#finish(run, reply);
    return conversation.id;
  }

  async #finish(run: Run, message: Message): Promise<void> {
    if (run.deleted) return;
    await putMessage(message);
    this.#deps.emit({type: 'finished', conversationId: message.conversationId, message});
  }
}
