// CDP over chrome.debugger: one attachment per tab, commands with a timeout, events of the tab and its child sessions.
import {NOT_SUPPORTED_TEXT, PageError} from './errors.ts';

export type CdpHandler = (method: string, params: any, sessionId?: string) => void;

export interface Cdp {
  send<T = any>(method: string, params?: object, sessionId?: string, timeoutMs?: number): Promise<T>;
  on(handler: CdpHandler): () => void;
  /** Why the debugger detached, or null while attached. */
  readonly detached: string | null;
}

export interface AttachedCdp extends Cdp {
  detach(): Promise<void>;
  onDetach(callback: (reason: string) => void): void;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function detachText(reason: string): string {
  if (reason === 'canceled_by_user') return 'Отладка отключена пользователем (кнопка «Отмена» на плашке Chrome).';
  if (reason === 'target_closed') return 'Вкладка закрыта.';
  return `Отладчик отключился (${reason}).`;
}

function attachError(error: unknown): PageError {
  const message = error instanceof Error ? error.message : String(error);
  if (/Cannot access|Cannot attach|chrome:\/\/|chrome-extension:\/\/|extensions gallery|webstore/i.test(message)) {
    return new PageError('PAGE_NOT_SUPPORTED', NOT_SUPPORTED_TEXT);
  }
  if (/No tab with given id/i.test(message)) return new PageError('DETACHED', 'Вкладка закрыта.');
  return new PageError('INTERNAL', `Не удалось подключиться к вкладке: ${message}`);
}

export async function attachTab(tabId: number, api: typeof chrome.debugger = chrome.debugger): Promise<AttachedCdp> {
  try {
    await api.attach({tabId}, '1.3');
  } catch (error) {
    // Our own attachment left over from a worker that restarted: take it over once.
    if (!/already attached/i.test(error instanceof Error ? error.message : String(error))) throw attachError(error);
    await api.detach({tabId}).catch(() => {});
    try { await api.attach({tabId}, '1.3'); } catch (again) {
      throw /already attached/i.test(String(again))
        ? new PageError('INTERNAL', 'К вкладке уже подключён другой отладчик.')
        : attachError(again);
    }
  }

  const handlers = new Set<CdpHandler>();
  const detachCallbacks: ((reason: string) => void)[] = [];
  let detached: string | null = null;

  const onEvent = (source: chrome.debugger.DebuggerSession, method: string, params?: object) => {
    if (source.tabId !== tabId) return;
    for (const handler of handlers) handler(method, params ?? {}, source.sessionId);
  };
  const onDetach = (source: chrome.debugger.Debuggee, reason: string) => {
    if (source.tabId !== tabId || detached) return;
    detached = detachText(reason);
    cleanup();
    detachCallbacks.forEach(callback => callback(detached!));
  };
  const cleanup = () => {
    api.onEvent.removeListener(onEvent);
    api.onDetach.removeListener(onDetach);
  };
  api.onEvent.addListener(onEvent);
  api.onDetach.addListener(onDetach);

  return {
    get detached() { return detached; },
    on(handler) { handlers.add(handler); return () => handlers.delete(handler); },
    onDetach(callback) { detachCallbacks.push(callback); },
    async send<T>(method: string, params: object = {}, sessionId?: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
      if (detached) throw new PageError('DETACHED', detached, 'unknown');
      const target: chrome.debugger.DebuggerSession = sessionId ? {tabId, sessionId} : {tabId};
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PageError('TIMEOUT', `Страница не ответила на ${method} за ${timeoutMs} мс.`, 'unknown')), timeoutMs);
      });
      try {
        return await Promise.race([api.sendCommand(target, method, params) as Promise<T>, timeout]);
      } catch (error) {
        if (error instanceof PageError) throw error;
        if (detached) throw new PageError('DETACHED', detached, 'unknown');
        const message = error instanceof Error ? error.message : String(error);
        if (/not attached|Detached while handling/i.test(message)) throw new PageError('DETACHED', 'Отладчик отключился.', 'unknown');
        throw new PageError('INTERNAL', `${method}: ${message}`, 'unknown');
      } finally {
        clearTimeout(timer);
      }
    },
    async detach() {
      if (detached) return;
      detached = 'Отладчик отключён.';
      cleanup();
      await api.detach({tabId}).catch(() => {});
    },
  };
}
