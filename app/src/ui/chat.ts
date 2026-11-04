// The Chat view: the transcript of the open conversation and the composer under it.
// Replies are produced by the service worker; this view renders its events and reads history from the database.
import type {WorkerToPanel} from '../shared/protocol.ts';
import type {Message, Profile} from '../store/types.ts';
import type {Client} from './client.ts';
import {applyEvent, emptyChat, type ChatState} from './chat-state.ts';
import {renderMarkdown} from './markdown.ts';
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

export function initChat(client: Client): ChatView {
  let state: ChatState = emptyChat;
  let profiles: Profile[] = [];
  const running = new Set<string>();
  const runningListeners: (() => void)[] = [];
  const nodes = new Map<string, HTMLElement>();
  const transcript = $('transcript');
  const input = $<HTMLTextAreaElement>('prompt');
  const send = $<HTMLButtonElement>('sendButton');
  const profileSelect = $<HTMLSelectElement>('profileSelect');
  const modelSelect = $<HTMLSelectElement>('modelSelect');

  // ——— Rendering ———

  function messageNode(message: Message): HTMLElement {
    let node = nodes.get(message.id);
    if (!node) {
      node = document.createElement('div');
      node.className = `msg ${message.role}`;
      if (message.role === 'assistant') {
        node.innerHTML = '<details class="reasoning" hidden><summary>Рассуждения</summary><div class="reasoning-text"></div></details>'
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
    node.querySelector('.md')!.innerHTML = renderMarkdown(message.text);
    const status = node.querySelector('.msg-status')!;
    status.textContent = message.status === 'streaming' ? (message.text ? '' : 'печатает…') : STATUS_TEXT[message.status] ?? '';
    node.classList.toggle('streaming', message.status === 'streaming');
    const error = node.querySelector<HTMLElement>('.msg-error')!;
    error.hidden = message.status !== 'failed';
    error.textContent = message.error ?? '';
  }

  function render(): void {
    const nearBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
    const keep = new Set(state.messages.map(m => m.id));
    for (const [id, node] of nodes) if (!keep.has(id)) { node.remove(); nodes.delete(id); }
    if (!state.messages.length) {
      transcript.replaceChildren(emptyHint());
    } else {
      transcript.querySelector('.chat-empty')?.remove();
      state.messages.forEach((message, index) => {
        const node = messageNode(message);
        fill(node, message);
        if (transcript.children[index] !== node) transcript.insertBefore(node, transcript.children[index] ?? null);
      });
    }
    if (nearBottom) transcript.scrollTop = transcript.scrollHeight;
    const busy = state.running || state.pendingRequestId !== null;
    send.innerHTML = icons[state.running ? 'stop' : 'send'];
    send.dataset.tip = state.running ? 'Остановить' : 'Отправить (Enter)';
    send.setAttribute('aria-label', state.running ? 'Остановить' : 'Отправить');
    send.disabled = !state.running && busy;
  }

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

  function submit(): void {
    if (state.running && state.conversationId) {
      client.post({type: 'stop', conversationId: state.conversationId});
      return;
    }
    const text = input.value.trim();
    if (!text || state.pendingRequestId) return;
    const requestId = crypto.randomUUID();
    state = {...state, pendingRequestId: requestId};
    client.post({type: 'send', requestId, conversationId: state.conversationId, text, profileId: profileSelect.value});
    input.value = '';
    render();
  }

  $('composer').addEventListener('submit', event => { event.preventDefault(); submit(); });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!state.running) submit(); }
  });

  // ——— Opening and outside changes ———

  async function open(conversationId: string | null): Promise<void> {
    const conversation = conversationId ? await getConversation(conversationId) : undefined;
    const id = conversation?.id ?? null;
    state = {conversationId: id, pendingRequestId: null, messages: id ? await listMessages(id) : [], running: id !== null && running.has(id)};
    if (conversation && profiles.some(p => p.id === conversation.profileId)) profileSelect.value = conversation.profileId;
    setPref(LAST, id);
    nodes.clear();
    transcript.replaceChildren();
    render();
    transcript.scrollTop = transcript.scrollHeight;
    input.focus();
  }

  onAssistantChange(async ({conversationId}) => {
    if (!conversationId) { await loadProfiles(); return; }
    if (conversationId !== state.conversationId || state.running || state.pendingRequestId) return;
    if (!await getConversation(conversationId)) { await open(null); return; }
    const messages = await listMessages(conversationId);
    // Read the state again after the awaits: a worker event may have arrived meanwhile and is newer than the database.
    if (conversationId !== state.conversationId || state.running || state.pendingRequestId) return;
    state = {...state, messages};
    render();
  });

  function handle(event: WorkerToPanel): void {
    if (event.type === 'running') { running.clear(); event.conversationIds.forEach(id => running.add(id)); }
    if (event.type === 'started') running.add(event.conversation.id);
    if (event.type === 'finished') running.delete(event.conversationId);
    const before = state.conversationId;
    state = applyEvent(state, event);
    if (state.conversationId !== before) setPref(LAST, state.conversationId);
    render();
    if (event.type === 'running' || event.type === 'started' || event.type === 'finished') runningListeners.forEach(l => l());
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
