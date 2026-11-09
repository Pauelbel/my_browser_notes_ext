// Service worker: opens the side panel on the toolbar icon and runs chat replies for every open panel.
import {PORT_NAME, type PanelToWorker, type WorkerToPanel} from '../shared/protocol.ts';
import {openAssistantDb, markInterrupted} from '../store/assistant-db.ts';
import {getSettings, setSiteRule} from '../store/settings.ts';
import {notesApi} from '../agent/notes.ts';
import {ollamaStream} from '../llm/stream.ts';
import {ChatRunner} from './chat-runner.ts';
import {acquire, release, PageTools, pageBudget} from '../page/index.ts';
import {modelCapabilities, modelContext} from '../llm/ollama.ts';

chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: true}).catch(console.error);

const ports = new Set<chrome.runtime.Port>();
const emit = (event: WorkerToPanel) => { for (const port of ports) port.postMessage(event); };
let metricQueue: Promise<void> = Promise.resolve();
const runner = new ChatRunner({
  stream: ollamaStream, settings: () => getSettings(), emit,
  heartbeat: () => { void chrome.runtime.getPlatformInfo(); },
  // The debugger attaches only for a reply that reads the page, and detaches when that reply ends.
  page: async (tabId, ownerId) => {
    const settings = await getSettings();
    const [session, context] = await Promise.all([acquire(tabId), modelContext(settings.ollamaUrl, settings.model)]);
    const tools = new PageTools(session, {budget: pageBudget(context), ownerId});
    return {tools, release: async () => { tools.dispose(); await release(session); }};
  },
  // Agent mode: each tab of a task gets page tools with that reply's gate.
  openTab: async (tabId, gate, ownerId) => {
    const settings = await getSettings();
    const [session, context] = await Promise.all([acquire(tabId), modelContext(settings.ollamaUrl, settings.model)]);
    const tools = new PageTools(session, {budget: pageBudget(context), gate, ownerId});
    return {tools, release: async () => { tools.dispose(); await release(session); }};
  },
  currentTab: async tabId => { const tab = await chrome.tabs.get(tabId); return {title: tab.title, url: tab.url}; },
  tabsApi: chrome.tabs,
  tabGroupsApi: chrome.tabGroups,
  notes: notesApi,
  setSiteRule: (site, rule) => setSiteRule(site, rule),
  capabilities: settings => modelCapabilities(settings.ollamaUrl, settings.model),
  contextTokens: settings => modelContext(settings.ollamaUrl, settings.model),
  clearHighlights: async (tabId, ownerId) => {
    const session = await acquire(tabId);
    const tools = new PageTools(session, {budget: pageBudget(8192), ownerId});
    try { await tools.clearHighlights(); } finally { tools.dispose(); await release(session); }
  },
  // Kept in session storage: it survives a worker restart, not a browser restart (tab ids change then anyway).
  tabMemory: {
    get: async id => (await chrome.storage.session.get(`tabs:${id}`))[`tabs:${id}`] as {members: number[]; groupId: number | null} | undefined,
    set: async (id, m) => { await chrome.storage.session.set({[`tabs:${id}`]: m}); },
    delete: async id => { await chrome.storage.session.remove(`tabs:${id}`); },
  },
  highlightMemory: {
    get: async id => (await chrome.storage.session.get(`highlights:${id}`))[`highlights:${id}`] as number[] | undefined,
    set: async (id, tabs) => { await chrome.storage.session.set({[`highlights:${id}`]: tabs}); },
    delete: async id => { await chrome.storage.session.remove(`highlights:${id}`); },
  },
  recordMetric: (name, ok, summary) => {
    metricQueue = metricQueue.then(async () => {
      const key = 'agent:metrics';
      const current = (await chrome.storage.local.get(key))[key] as Record<string, {total: number; ok: number; outcomes: Record<string, number>}> | undefined ?? {};
      const code = summary.match(/ошибка\s+([A-Z_]+)/)?.[1]
        ?? summary.match(/effect=(changed|unattributable|none)/)?.[1]
        ?? (ok ? 'ok' : 'error');
      const item = current[name] ?? {total: 0, ok: 0, outcomes: {}};
      item.total++; if (ok) item.ok++; item.outcomes[code] = (item.outcomes[code] ?? 0) + 1;
      current[name] = item;
      await chrome.storage.local.set({[key]: current});
    }).catch(() => {});
  },
});

// A worker that starts has no replies in progress: any left `streaming` belonged to a worker that was stopped.
const ready = openAssistantDb().then(() => markInterrupted()).catch(console.error);

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== PORT_NAME) return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  // After `ready`, so replies a stopped worker left are already marked interrupted when the panel hears nothing runs.
  void ready.then(() => port.postMessage({type: 'running', conversationIds: runner.running(), prompts: runner.pending()} satisfies WorkerToPanel));
  port.onMessage.addListener(async (message: PanelToWorker) => {
    await ready;
    if (message.type === 'send') runner.send(message).catch(console.error);
    else if (message.type === 'stop') runner.stop(message.conversationId);
    else if (message.type === 'delete') runner.delete(message.conversationId, message.tabId).catch(console.error);
    else if (message.type === 'answer') runner.answer(message.promptId, message.answer);
    else if (message.type === 'mode') runner.setMode(message.conversationId, message.mode, message.permission).catch(console.error);
  });
});
