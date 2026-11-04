// Service worker: opens the side panel on the toolbar icon and runs chat replies for every open panel.
import {PORT_NAME, type PanelToWorker, type WorkerToPanel} from '../shared/protocol.ts';
import {openAssistantDb, markInterrupted} from '../store/assistant-db.ts';
import {getSettings} from '../store/settings.ts';
import {ollamaStream} from '../llm/stream.ts';
import {ChatRunner} from './chat-runner.ts';

chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: true}).catch(console.error);

const ports = new Set<chrome.runtime.Port>();
const emit = (event: WorkerToPanel) => { for (const port of ports) port.postMessage(event); };
const runner = new ChatRunner({
  stream: ollamaStream, settings: () => getSettings(), emit,
  heartbeat: () => { void chrome.runtime.getPlatformInfo(); },
});

// A worker that starts has no replies in progress: any left `streaming` belonged to a worker that was stopped.
const ready = openAssistantDb().then(() => markInterrupted()).catch(console.error);

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== PORT_NAME) return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  // After `ready`, so replies a stopped worker left are already marked interrupted when the panel hears nothing runs.
  void ready.then(() => port.postMessage({type: 'running', conversationIds: runner.running()} satisfies WorkerToPanel));
  port.onMessage.addListener(async (message: PanelToWorker) => {
    await ready;
    if (message.type === 'send') runner.send(message).catch(console.error);
    else if (message.type === 'stop') runner.stop(message.conversationId);
    else if (message.type === 'delete') runner.delete(message.conversationId).catch(console.error);
  });
});
