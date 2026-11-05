// Console errors and failed requests of a tab, collected in the background while the debugger is attached,
// and summarised for the model: grouped, counted, bounded. What happened before attaching is not visible.
import type {Cdp} from './cdp.ts';

export interface ConsoleEntry { level: 'error' | 'warning'; source: 'console' | 'exception' | 'log'; text: string; url?: string; line?: number; at: number }
export interface NetworkEntry { method: string; url: string; status?: number; error?: string; type?: string; at: number }

const GROUPS_MAX = 30;
const TEXT_MAX = 300;

function argText(arg: {value?: unknown; description?: string; type?: string}): string {
  if (arg.value !== undefined) return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value);
  return arg.description ?? arg.type ?? '';
}

export class Diagnostics {
  readonly since = Date.now();
  #since = this.since;
  readonly #limit: number;
  #console: ConsoleEntry[] = [];
  #network: NetworkEntry[] = [];
  #droppedConsole = 0;
  #droppedNetwork = 0;
  readonly #requests = new Map<string, {method: string; url: string; type?: string}>();
  readonly #off: () => void;

  constructor(cdp: Cdp, limit = 300) {
    this.#limit = limit;
    this.#off = cdp.on((method, params, sessionId) => this.#event(method, params, sessionId));
  }

  get collectedSince(): number { return this.#since; }

  console(): {entries: ConsoleEntry[]; dropped: number} { return {entries: [...this.#console], dropped: this.#droppedConsole}; }
  network(): {entries: NetworkEntry[]; dropped: number} { return {entries: [...this.#network], dropped: this.#droppedNetwork}; }

  reset(): void {
    this.#console = []; this.#network = []; this.#droppedConsole = 0; this.#droppedNetwork = 0; this.#since = Date.now();
  }

  stop(): void { this.#off(); }

  #pushConsole(entry: ConsoleEntry): void {
    this.#console.push(entry);
    if (this.#console.length > this.#limit) { this.#console.shift(); this.#droppedConsole++; }
  }

  #pushNetwork(entry: NetworkEntry): void {
    this.#network.push(entry);
    if (this.#network.length > this.#limit) { this.#network.shift(); this.#droppedNetwork++; }
  }

  #event(method: string, params: any, sessionId?: string): void {
    const at = Date.now();
    if (method === 'Runtime.consoleAPICalled') {
      const level = params.type === 'error' || params.type === 'assert' ? 'error' : params.type === 'warning' ? 'warning' : null;
      if (!level) return;
      const frame = params.stackTrace?.callFrames?.[0];
      this.#pushConsole({level, source: 'console', text: (params.args ?? []).map(argText).join(' ').trim(), url: frame?.url, line: frame ? frame.lineNumber + 1 : undefined, at});
    } else if (method === 'Runtime.exceptionThrown') {
      const d = params.exceptionDetails ?? {};
      this.#pushConsole({level: 'error', source: 'exception', text: (d.exception?.description ?? d.text ?? '').split('\n')[0], url: d.url, line: d.lineNumber !== undefined ? d.lineNumber + 1 : undefined, at});
    } else if (method === 'Log.entryAdded') {
      const e = params.entry ?? {};
      if (e.level !== 'error' && e.level !== 'warning') return;
      this.#pushConsole({level: e.level, source: 'log', text: e.text ?? '', url: e.url, line: e.lineNumber !== undefined ? e.lineNumber + 1 : undefined, at});
    } else if (method === 'Network.requestWillBeSent') {
      this.#requests.set(`${sessionId ?? ''}|${params.requestId}`, {method: params.request?.method ?? 'GET', url: params.request?.url ?? '', type: params.type});
    } else if (method === 'Network.responseReceived') {
      const status = params.response?.status ?? 0;
      if (status < 400) return;
      const req = this.#requests.get(`${sessionId ?? ''}|${params.requestId}`);
      this.#pushNetwork({method: req?.method ?? 'GET', url: params.response?.url ?? req?.url ?? '', status, type: params.type ?? req?.type, at});
    } else if (method === 'Network.loadingFailed') {
      // A request the page or the user cancelled is not a failure.
      if (params.canceled) return;
      const req = this.#requests.get(`${sessionId ?? ''}|${params.requestId}`);
      const reason = params.corsErrorStatus?.corsError ? `CORS: ${params.corsErrorStatus.corsError}` : params.blockedReason ? `заблокирован: ${params.blockedReason}` : params.errorText;
      this.#pushNetwork({method: req?.method ?? 'GET', url: req?.url ?? '', error: reason, type: params.type ?? req?.type, at});
    }
  }
}

const clock = (t: number) => new Date(t).toTimeString().slice(0, 8);
const footer = (since: number) => `собрано с ${clock(since)} (с подключения к вкладке); ошибки до этого не видны — чтобы собрать с начала загрузки, вызовите с reload: true`;
const cut = (s: string) => (s.length > TEXT_MAX ? `${s.slice(0, TEXT_MAX - 1)}…` : s);

function grouped<T>(items: T[], key: (t: T) => string): {item: T; count: number}[] {
  const groups = new Map<string, {item: T; count: number}>();
  for (const item of items) {
    const k = key(item);
    const g = groups.get(k);
    if (g) g.count++; else groups.set(k, {item, count: 1});
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

export function summarizeConsole(d: {entries: ConsoleEntry[]; dropped: number; since: number}, level: 'error' | 'warning' | 'all'): string {
  const entries = d.entries.filter(e => level === 'all' || e.level === level);
  const lines = [footer(d.since)];
  if (!entries.length) { lines.push('Ошибок нет.'); return lines.join('\n'); }
  const groups = grouped(entries, e => `${e.level}|${e.text}`);
  lines.push(`Записей: ${entries.length}, разных: ${groups.length}.`);
  for (const {item, count} of groups.slice(0, GROUPS_MAX)) {
    const where = item.url ? ` · ${item.url}${item.line ? `:${item.line}` : ''}` : '';
    lines.push(`${item.level === 'error' ? 'ошибка' : 'предупреждение'}${count > 1 ? ` ×${count}` : ''}${item.source === 'exception' ? ' (необработанное исключение)' : ''} · ${cut(item.text)}${where}`);
  }
  if (groups.length > GROUPS_MAX) lines.push(`… и ещё ${groups.length - GROUPS_MAX} разных сообщений.`);
  if (d.dropped) lines.push(`Старые записи вытеснены лимитом: ${d.dropped}.`);
  return lines.join('\n');
}

export function summarizeNetwork(d: {entries: NetworkEntry[]; dropped: number; since: number}): string {
  const lines = [footer(d.since)];
  if (!d.entries.length) { lines.push('Упавших запросов нет.'); return lines.join('\n'); }
  const base = (url: string) => url.split(/[?#]/)[0];
  const groups = grouped(d.entries, e => `${e.method}|${e.status ?? e.error}|${base(e.url)}`);
  lines.push(`Упавших запросов: ${d.entries.length}, разных: ${groups.length}.`);
  for (const {item, count} of groups.slice(0, GROUPS_MAX)) {
    lines.push(`${item.method} ${item.status ?? item.error}${count > 1 ? ` ×${count}` : ''} · ${cut(base(item.url))}${item.type ? ` (${item.type.toLowerCase()})` : ''}`);
  }
  if (groups.length > GROUPS_MAX) lines.push(`… и ещё ${groups.length - GROUPS_MAX}.`);
  if (d.dropped) lines.push(`Старые записи вытеснены лимитом: ${d.dropped}.`);
  return lines.join('\n');
}
