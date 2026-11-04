// The panel's connection to the service worker. The worker can be stopped by Chrome at any time;
// the port then disconnects and is opened again, and the worker greets it with the replies in progress.
import {PORT_NAME, type PanelToWorker, type WorkerToPanel} from '../shared/protocol.ts';

export interface Client {
  post(message: PanelToWorker): void;
}

export function connect(onEvent: (event: WorkerToPanel) => void): Client {
  let port: chrome.runtime.Port | null = null;
  const open = () => {
    port = chrome.runtime.connect({name: PORT_NAME});
    port.onMessage.addListener(onEvent);
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      port = null;
      setTimeout(() => { if (!port) open(); }, 200);
    });
    return port;
  };
  open();
  return {post(message) { (port ?? open()).postMessage(message); }};
}
