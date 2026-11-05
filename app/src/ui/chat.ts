// The Chat view: the transcript of the open conversation and the composer under it.
// Replies are produced by the service worker; this view renders its events and reads history from the database.
import type {PanelAnswer, PendingPrompt, WorkerToPanel} from '../shared/protocol.ts';
import type {ChatMode, Message, PermissionMode, Profile} from '../store/types.ts';
import type {Client} from './client.ts';
import {applyEvent, emptyChat, type ChatState} from './chat-state.ts';
import {hideRefs, renderMarkdown} from './markdown.ts';
import {getConversation, listMessages, listProfiles, onAssistantChange} from '../store/assistant-db.ts';
import {getSettings, saveSettings} from '../store/settings.ts';
import {listModels} from '../llm/ollama.ts';
import {icons} from '../../icons.js'; // plain JS, shared with the notes UI

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const LAST = 'assistant:last';
const PROFILE = 'assistant:profile';
const pref = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const setPref = (key: string, value: string | null) => {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch {}
};

export interface ChatView {
  open(conversationId: string | null): Promise<void>;
  /** The conversation on screen, or null for a new one. */
  current(): string | null;
  /** Conversations whose reply is in progress, in any panel. */
  running(): Set<string>;
  /** Called after any event that changes what is running. */
  onRunningChange(callback: () => void): void;
  /** Handles a worker event; main.ts routes every event here. */
  handle(event: WorkerToPanel): void;
}

const STATUS_TEXT: Partial<Record<Message['status'], string>> = {stopped: 'остановлено', interrupted: 'прервано'};
/** What «Продолжить» sends: the agent picks up an interrupted task from where it stopped. */
export const CONTINUE_TEXT = 'Продолжи задачу с того места, где остановился. Сначала посмотри, что сейчас на странице.';

export function initChat(client: Client): ChatView {
  let state: ChatState = emptyChat;
  let profiles: Profile[] = [];
  const running = new Set<string>();
  const runningListeners: (() => void)[] = [];
  const nodes = new Map<string, HTMLElement>();
  /** The message object each node was last filled from; an unchanged object is not rendered again. */
  const filled = new Map<string, Message>();
  const transcript = $('transcript');
  const input = $<HTMLTextAreaElement>('prompt');
  const send = $<HTMLButtonElement>('sendButton');
  const profileSelect = $<HTMLSelectElement>('profileSelect');
  const modeSelect = $<HTMLSelectElement>('modeSelect');
  const permissionSelect = $<HTMLSelectElement>('permissionSelect');
  /** Every open agent question, in any chat; the open chat shows its own. */
  const allPrompts = new Map<string, PendingPrompt>();
  const modelSelect = $<HTMLSelectElement>('modelSelect');

  // ——— Rendering ———

  function messageNode(message: Message): HTMLElement {
    let node = nodes.get(message.id);
    if (!node) {
      node = document.createElement('div');
      node.className = `msg ${message.role}`;
      if (message.role === 'assistant') {
        node.innerHTML = '<details class="reasoning" hidden><summary>Рассуждения</summary><div class="reasoning-text"></div></details>'
          + '<details class="steps" hidden><summary></summary><div class="steps-list"></div></details>'
          + '<div class="md"></div><div class="msg-status"></div><div class="msg-error" hidden></div>';
      }
      nodes.set(message.id, node);
    }
    return node;
  }

  function fill(node: HTMLElement, message: Message): void {
    if (message.role === 'user') { node.textContent = message.text; return; }
    const reasoning = node.querySelector<HTMLDetailsElement>('.reasoning')!;
    reasoning.hidden = !message.reasoning;
    node.querySelector('.reasoning-text')!.textContent = message.reasoning;
    const steps = node.querySelector<HTMLDetailsElement>('.steps')!;
    const list = message.steps ?? [];
    steps.hidden = !list.length;
    steps.querySelector('summary')!.textContent = list.map(s => `${s.name}${s.input ? ` ${s.input}` : ''}`).join(' · ');
    steps.classList.toggle('has-error', list.some(s => s.status === 'error'));
    steps.querySelector('.steps-list')!.replaceChildren(...list.map(s => {
      const line = document.createElement('div');
      line.className = `step ${s.status}`;
      line.textContent = `${s.status === 'running' ? '…' : s.status === 'error' ? '✕' : '✓'} ${s.name}${s.input ? ` ${s.input}` : ''}${s.summary ? ` — ${s.summary}` : ''}`;
      return line;
    }));
    node.querySelector('.md')!.innerHTML = renderMarkdown(hideRefs(message.text));
    const status = node.querySelector('.msg-status')!;
    const running = message.steps?.find(s => s.status === 'running');
    status.textContent = message.status === 'streaming' ? (running ? `смотрю страницу: ${running.name}…` : message.text ? '' : 'печатает…') : STATUS_TEXT[message.status] ?? '';
    node.classList.toggle('streaming', message.status === 'streaming');
    const error = node.querySelector<HTMLElement>('.msg-error')!;
    error.hidden = message.status !== 'failed';
    error.textContent = message.error ?? '';
  }

  function render(): void {
    const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
    const keep = new Set(state.messages.map(m => m.id));
    for (const [id, node] of nodes) if (!keep.has(id)) { node.remove(); nodes.delete(id); filled.delete(id); }
    if (!state.messages.length) {
      transcript.replaceChildren(emptyHint());
    } else {
      transcript.querySelector('.chat-empty')?.remove();
      state.messages.forEach((message, index) => {
        const node = messageNode(message);
        if (filled.get(message.id) !== message) { fill(node, message); filled.set(message.id, message); }
        if (transcript.children[index] !== node) transcript.insertBefore(node, transcript.children[index] ?? null);
      });
    }
    renderPrompts();
    renderContinue();
    if (nearBottom) transcript.scrollTop = transcript.scrollHeight;
    const busy = state.running || state.pendingRequestId !== null;
    send.innerHTML = icons[state.running ? 'stop' : 'send'];
    send.dataset.tip = state.running ? 'Остановить' : 'Отправить (Enter)';
    send.setAttribute('aria-label', state.running ? 'Остановить' : 'Отправить');
    send.disabled = !state.running && busy;
  }

  /** The agent's questions as cards at the end of the transcript; answering sends the answer to the worker. */
  function renderPrompts(): void {
    transcript.querySelectorAll('.prompt-card').forEach(card => { if (!state.prompts.some(p => p.id === (card as HTMLElement).dataset.id)) card.remove(); });
    for (const prompt of state.prompts) {
      if (transcript.querySelector(`.prompt-card[data-id="${prompt.id}"]`)) continue;
      const card = document.createElement('div');
      card.className = 'prompt-card';
      card.dataset.id = prompt.id;
      const text = document.createElement('p');
      text.textContent = prompt.text;
      const row = document.createElement('div');
      row.className = 'row';
      const answer = (value: PanelAnswer) => client.post({type: 'answer', promptId: prompt.id, answer: value});
      const button = (label: string, value: PanelAnswer, cls = '') => {
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = label; if (cls) b.className = cls;
        b.onclick = () => { card.querySelectorAll('button').forEach(x => (x as HTMLButtonElement).disabled = true); answer(value); };
        return b;
      };
      if (prompt.kind === 'confirm') {
        row.append(button('Разрешить', 'allow', 'primary'));
        if (prompt.site) row.append(button(`Разрешать на ${prompt.site}`, 'allow-site'));
        row.append(button('Отклонить', 'deny', 'danger'));
      } else if (prompt.kind === 'takeover') {
        row.append(button('Готово', 'done', 'primary'), button('Отменить', 'cancel', 'danger'));
      } else {
        const field = document.createElement('input');
        field.placeholder = 'ваш ответ';
        const send = () => { const value = field.value.trim(); if (value) answer({text: value}); };
        field.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); send(); } });
        const ok = document.createElement('button');
        ok.type = 'button'; ok.className = 'primary'; ok.textContent = 'Ответить'; ok.onclick = send;
        row.append(field, ok, button('Не отвечать', 'cancel'));
      }
      card.append(text, row);
      transcript.append(card);
    }
  }

  /** «Продолжить» under the last reply of an agent task that was interrupted or stopped. */
  function renderContinue(): void {
    const last = state.messages.at(-1);
    const show = !state.running && !state.pendingRequestId && modeSelect.value === 'agent' && last?.role === 'assistant'
      && (last.status === 'interrupted' || last.status === 'stopped');
    let button = transcript.querySelector<HTMLButtonElement>('.continue-btn');
    if (!show) { button?.remove(); return; }
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'continue-btn';
      button.textContent = '↻ Продолжить';
      button.dataset.tip = 'Агент продолжит задачу с того места, где остановился';
      button.onclick = () => { input.value = CONTINUE_TEXT; void submit(); };
    }
    transcript.append(button);
  }

  // ——— Mode ———

  const prefMode = () => (pref('assistant:mode') === 'agent' ? 'agent' : 'chat') as ChatMode;
  const prefPermission = () => (pref('assistant:permission') === 'auto' ? 'auto' : 'ask') as PermissionMode;
  function showMode(mode: ChatMode, permission: PermissionMode): void {
    modeSelect.value = mode;
    permissionSelect.value = permission;
    permissionSelect.hidden = mode !== 'agent';
  }
  const onModeChange = () => {
    const mode = modeSelect.value as ChatMode, permission = permissionSelect.value as PermissionMode;
    showMode(mode, permission);
    setPref('assistant:mode', mode);
    setPref('assistant:permission', permission);
    if (state.conversationId) client.post({type: 'mode', conversationId: state.conversationId, mode, permission});
  };
  modeSelect.addEventListener('change', onModeChange);
  permissionSelect.addEventListener('change', onModeChange);

  function emptyHint(): HTMLElement {
    const hint = document.createElement('div');
    hint.className = 'chat-empty';
    hint.textContent = modelSelect.value
      ? 'Новый чат. Спросите что-нибудь.'
      : 'Выберите модель Ollama внизу или в настройках ⚙, затем задайте вопрос.';
    return hint;
  }

  // ——— Profiles and models ———

  async function loadProfiles(): Promise<void> {
    profiles = await listProfiles();
    const selected = profileSelect.value || pref(PROFILE);
    profileSelect.replaceChildren(...profiles.map(p => new Option(p.name, p.id)));
    profileSelect.value = profiles.some(p => p.id === selected) ? selected! : profiles[0].id;
  }

  async function loadModels(): Promise<void> {
    const settings = await getSettings();
    let models: string[] = [];
    try { models = await listModels(settings.ollamaUrl); } catch {}
    if (settings.model && !models.includes(settings.model)) models.unshift(settings.model);
    const options = models.map(m => new Option(m, m));
    if (!settings.model) options.unshift(new Option(models.length ? 'Выберите модель' : 'Нет связи с Ollama', ''));
    modelSelect.replaceChildren(...options);
    modelSelect.value = settings.model;
    if (!state.messages.length) render();
  }

  profileSelect.addEventListener('change', () => setPref(PROFILE, profileSelect.value));
  modelSelect.addEventListener('change', () => { void saveSettings({model: modelSelect.value}); });
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.settings) void loadModels(); });

  // ——— Sending ———

  /** The active tab of this panel's window: the page the read tools look at. */
  async function activeTab(): Promise<number | null> {
    try {
      const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
      return tab?.id ?? null;
    } catch {
      return null;
    }
  }

  async function submit(): Promise<void> {
    if (state.running && state.conversationId) {
      client.post({type: 'stop', conversationId: state.conversationId});
      return;
    }
    const text = input.value.trim();
    if (!text || state.pendingRequestId) return;
    const requestId = crypto.randomUUID();
    state = {...state, pendingRequestId: requestId};
    input.value = '';
    render();
    client.post({type: 'send', requestId, conversationId: state.conversationId, text, profileId: profileSelect.value, tabId: await activeTab(),
      mode: modeSelect.value as ChatMode, permission: permissionSelect.value as PermissionMode});
  }

  $('composer').addEventListener('submit', event => { event.preventDefault(); void submit(); });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!state.running) void submit(); }
  });

  // ——— Opening and outside changes ———

  async function open(conversationId: string | null): Promise<void> {
    const conversation = conversationId ? await getConversation(conversationId) : undefined;
    const id = conversation?.id ?? null;
    state = {conversationId: id, pendingRequestId: null, messages: id ? await listMessages(id) : [], running: id !== null && running.has(id),
      prompts: [...allPrompts.values()].filter(p => p.conversationId === id)};
    if (conversation && profiles.some(p => p.id === conversation.profileId)) profileSelect.value = conversation.profileId;
    showMode(conversation?.mode ?? prefMode(), conversation?.permission ?? prefPermission());
    setPref(LAST, id);
    nodes.clear();
    filled.clear();
    transcript.replaceChildren();
    render();
    transcript.scrollTop = transcript.scrollHeight;
    input.focus();
  }

  onAssistantChange(async ({conversationId}) => {
    if (!conversationId) { await loadProfiles(); return; }
    if (conversationId !== state.conversationId) return;
    if (!await getConversation(conversationId)) { if (conversationId === state.conversationId) await open(null); return; }
    if (state.running || state.pendingRequestId) return;
    const messages = await listMessages(conversationId);
    // Read the state again after the awaits: a worker event may have arrived meanwhile and is newer than the database.
    if (conversationId !== state.conversationId || state.running || state.pendingRequestId) return;
    state = {...state, messages};
    render();
  });

  function handle(event: WorkerToPanel): void {
    if (event.type === 'running') { running.clear(); event.conversationIds.forEach(id => running.add(id)); allPrompts.clear(); event.prompts?.forEach(p => allPrompts.set(p.id, p)); }
    if (event.type === 'prompt') allPrompts.set(event.prompt.id, event.prompt);
    if (event.type === 'prompt-closed') allPrompts.delete(event.promptId);
    if (event.type === 'started') running.add(event.conversation.id);
    if (event.type === 'finished' || event.type === 'deleted') running.delete(event.conversationId);
    if (event.type === 'deleted' && event.conversationId === state.conversationId) {
      runningListeners.forEach(l => l());
      void open(null);
      return;
    }
    const before = state.conversationId;
    state = applyEvent(state, event);
    if (state.conversationId !== before) setPref(LAST, state.conversationId);
    render();
    if (event.type !== 'delta' && event.type !== 'busy') runningListeners.forEach(l => l());
  }

  void (async () => {
    await loadProfiles();
    await open(pref(LAST));
    await loadModels();
  })();

  return {
    open,
    current: () => state.conversationId,
    running: () => running,
    onRunningChange: callback => { runningListeners.push(callback); },
    handle,
  };
}
