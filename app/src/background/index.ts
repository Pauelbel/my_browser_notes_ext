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
const runner = new ChatRunner({
  stream: ollamaStream, settings: () => getSettings(), emit,
  heartbeat: () => { void chrome.runtime.getPlatformInfo(); },
  // The debugger attaches only for a reply that reads the page, and detaches when that reply ends.
  page: async tabId => {
    const settings = await getSettings();
    const [session, context] = await Promise.all([acquire(tabId), modelContext(settings.ollamaUrl, settings.model)]);
    const tools = new PageTools(session, {budget: pageBudget(context)});
    return {tools, release: async () => { tools.dispose(); await release(session); }};
  },
  // Agent mode: each tab of a task gets page tools with that reply's gate.
  openTab: async (tabId, gate) => {
    const settings = await getSettings();
    const [session, context] = await Promise.all([acquire(tabId), modelContext(settings.ollamaUrl, settings.model)]);
    const tools = new PageTools(session, {budget: pageBudget(context), gate});
    return {tools, release: async () => { tools.dispose(); await release(session); }};
  },
  tabsApi: chrome.tabs,
  tabGroupsApi: chrome.tabGroups,
  notes: notesApi,
  setSiteRule: (site, rule) => setSiteRule(site, rule),
  capabilities: settings => modelCapabilities(settings.ollamaUrl, settings.model),
  contextTokens: settings => modelContext(settings.ollamaUrl, settings.model),
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
    else if (message.type === 'delete') runner.delete(message.conversationId).catch(console.error);
    else if (message.type === 'answer') runner.answer(message.promptId, message.answer);
    else if (message.type === 'mode') runner.setMode(message.conversationId, message.mode, message.permission).catch(console.error);
  });
});
