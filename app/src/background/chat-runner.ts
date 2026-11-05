// Runs chat replies in the service worker: one reply at a time per conversation, streamed to every panel and saved
// as it grows, so closing the panel does not lose it and a worker that stops leaves a reply marked as interrupted.
import type {PanelAnswer, PanelToWorker, PendingPrompt, WorkerToPanel} from '../shared/protocol.ts';
import type {StreamReply} from '../llm/stream.ts';
import type {ChatMode, Message, PermissionMode, Settings, SiteRule, ToolName, ToolStep} from '../store/types.ts';
import {createConversation, deleteConversation, getConversation, listMessages, listProfiles, putMessage, setConversationMode, setConversationProfile} from '../store/assistant-db.ts';
import {agentSystemPrompt, systemPrompt} from '../agent/prompt.ts';
import {toModelMessages} from '../agent/history.ts';
import {describeError} from '../llm/ollama.ts';
import {buildChatTools, describeInput, type ReadTools} from '../agent/tools.ts';
import {fitToContext} from '../agent/elision.ts';
import {ScreenshotStore} from '../agent/screenshots.ts';
import type {NotesApi} from '../agent/notes.ts';
import type {Gate, PageTools} from '../page/index.ts';
import {PromptBroker} from './prompts.ts';
import {createAgentSession} from './agent-session.ts';

/** Model turns in one Agent-mode reply (nanobrowser's turn cap). */
export const AGENT_MAX_STEPS = 100;

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
  /** Agent mode: opens a tab's page tools with the gate of this reply. Without it there is no Agent mode. */
  openTab?: (tabId: number, gate: Gate) => Promise<{tools: PageTools; release(): Promise<void>}>;
  tabsApi?: typeof chrome.tabs;
  tabGroupsApi?: typeof chrome.tabGroups;
  notes?: NotesApi;
  setSiteRule?: (site: string, rule: SiteRule) => Promise<unknown>;
  /** What the model can do (Ollama capabilities); 'vision' turns on screenshots. */
  capabilities?: (settings: Settings) => Promise<string[]>;
  /** The model's context window in tokens; 8192 when unknown. */
  contextTokens?: (settings: Settings) => Promise<number>;
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
  readonly #broker: PromptBroker;
  /** Each chat's agent tabs and tab group, so its next reply continues in them (kept while the worker lives). */
  readonly #tabMemory = new Map<string, {members: Set<number>; groupId: number | null}>();

  constructor(deps: ChatDeps) {
    this.#deps = deps;
    this.#broker = new PromptBroker(deps.emit);
  }

  /** Questions to the user that wait for an answer, for a panel that connects later. */
  pending(): PendingPrompt[] {
    return this.#broker.pending();
  }

  answer(promptId: string, answer: PanelAnswer): void {
    this.#broker.answer(promptId, answer);
  }

  async setMode(conversationId: string, mode: ChatMode, permission: PermissionMode): Promise<void> {
    await setConversationMode(conversationId, mode, permission);
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
      conversation = await createConversation({profileId: profile.id, firstMessage: text, mode: command.mode, permission: command.permission});
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
    const vision = (await this.#deps.capabilities?.(settings).catch(() => []) ?? []).includes('vision');
    const screenshots = new ScreenshotStore();
    const context = await this.#deps.contextTokens?.(settings).catch(() => 8192) ?? 8192;
    // Agent mode needs a tab and the agent dependencies; otherwise the reply is a Chat-mode one.
    const agentMode = conversation.mode === 'agent' && this.#deps.openTab && this.#deps.tabsApi && command.tabId !== null && command.tabId !== undefined;
    const conversationId = conversation.id;
    const agent = agentMode ? createAgentSession({
      tabId: command.tabId!, profile, conversation, settings, openTab: this.#deps.openTab!, tabsApi: this.#deps.tabsApi!, tabGroupsApi: this.#deps.tabGroupsApi,
      notes: this.#deps.notes, setSiteRule: this.#deps.setSiteRule ?? (async () => {}),
      readSettings: this.#deps.settings,
      readPermission: async () => (await getConversation(conversationId))?.permission ?? conversation.permission,
      memory: this.#tabMemory.get(conversationId) ?? (this.#tabMemory.set(conversationId, {members: new Set(), groupId: null}).get(conversationId)!),
      ask: prompt => this.#broker.ask({...prompt, conversationId}, run.controller.signal),
      vision, screenshots,
    }) : null;
    const tools = agent ? agent.tools : this.#deps.page ? buildChatTools(profile, openPage, this.#deps.notes, {vision, screenshots}) : {};
    const toolNames = Object.keys(tools) as ToolName[];
    let steps = 0;
    let doneSummary: string | null = null;
    let doneOutcome = 'success';
    /** Text that comes after a tool call starts a new paragraph instead of running into the earlier text. */
    let afterTool = false;
    const emitStep = (step: ToolStep) => this.#deps.emit({type: 'step', conversationId: reply.conversationId, messageId: reply.id, step});
    try {
      const parts = this.#deps.stream({
        settings, system: agent ? agentSystemPrompt(profile, toolNames) : systemPrompt(profile, toolNames),
        messages: toModelMessages([...history, user]), signal: run.controller.signal, tools,
        ...(agent
          ? {maxSteps: AGENT_MAX_STEPS, stopOnTool: 'done', prepareMessages: <T>(m: T[]) => screenshots.inject(fitToContext(m, context))}
          : {maxSteps: CHAT_MAX_STEPS, prepareMessages: <T>(m: T[]) => screenshots.inject(m)}),
      });
      for await (const part of parts) {
        if (part.type === 'step') { steps++; continue; }
        if (part.type === 'tool-call' && part.name === 'done') {
          const input = part.input as {summary?: string; outcome?: string};
          doneSummary = input?.summary ?? '';
          doneOutcome = input?.outcome ?? 'success';
        }
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
          afterTool = true;
          continue;
        }
        if (part.type === 'text') {
          if (afterTool && reply.text.trim() && part.delta.trim()) reply.text = `${reply.text.trimEnd()}\n\n`;
          if (part.delta.trim()) afterTool = false;
          reply.text += part.delta;
        } else reply.reasoning += part.delta;
        this.#deps.emit({type: 'delta', conversationId: reply.conversationId, messageId: reply.id, text: reply.text, reasoning: reply.reasoning});
        if (now() - savedAt >= saveEvery && !run.deleted) {
          savedAt = now();
          await putMessage({...reply});
        }
      }
      reply.status = run.controller.signal.aborted ? 'stopped' : 'done';
      if (agent && reply.status === 'done') {
        // The agent's answer is its text, or the summary it gave to done; a run cut by the cap says so.
        // Local models narrate between calls: the summary given to done is the real answer and is always shown.
        if (doneSummary) {
          const label = doneOutcome === 'failed' ? 'Итог (не удалось): ' : doneOutcome === 'partial' ? 'Итог (выполнено частично): ' : '';
          const summary = `${label}${doneSummary}`;
          if (!reply.text.trim()) reply.text = summary;
          else if (!reply.text.trim().endsWith(doneSummary.trim())) reply.text = `${reply.text.trimEnd()}\n\n${summary}`;
        }
        if (doneSummary === null && steps >= AGENT_MAX_STEPS) {
          reply.text = `${reply.text.trim() ? `${reply.text.trim()}\n\n` : ''}Достигнут лимит шагов (${AGENT_MAX_STEPS}): задача выполнена не полностью.`;
        }
      }
    } catch (error) {
      if (run.controller.signal.aborted) reply.status = 'stopped';
      else { reply.status = 'failed'; reply.error = describeError(error, settings.ollamaUrl); }
    } finally {
      if (handle) await (handle as Promise<PageHandle>).then(h => h.release(), () => {});
      if (agent) await agent.release().catch(() => {});
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
