// Console errors and failed requests of a tab, collected in the background while the debugger is attached,
// and summarised for the model: grouped, counted, bounded. What happened before attaching is not visible.
import type {Cdp} from './cdp.ts';

export interface ConsoleEntry { level: 'error' | 'warning'; source: 'console' | 'exception' | 'log'; text: string; url?: string; line?: number; at: number;
  /** The page (main frame address) it happened on. */ page?: string;
  /** Replayed by Chrome on attaching: it happened before the debugger was there. */ before?: boolean }
export interface NetworkEntry { method: string; url: string; status?: number; error?: string; type?: string; at: number; page?: string }

const GROUPS_MAX = 30;
const TEXT_MAX = 300;
const URL_MAX = 500;
const REQUESTS_MAX = 1000;
const MUTE_TAIL_MS = 1500;

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
  readonly #requests = new Map<string, {method: string; url: string; type?: string; muted?: boolean}>();
  #page = '';
  #muted = new Set<string>();
  #mutedUntil = 0;
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

  /** Requests of the layer's own checks are not the page's: HEAD requests and these addresses are left out. */
  mute(urls: string[]): void { this.#muted = new Set(urls); this.#mutedUntil = Infinity; }
  /** Ends muting a moment later: the last responses of a check arrive after it returns. */
  unmute(): void { this.#mutedUntil = Date.now() + MUTE_TAIL_MS; }

  pendingRequests(): number { return this.#requests.size; }

  #isMuted(url: string, method?: string): boolean {
    return Date.now() < this.#mutedUntil && (method === 'HEAD' || this.#muted.has(url.split('#')[0]));
  }

  #pushConsole(entry: ConsoleEntry): void {
    entry.text = entry.text.slice(0, TEXT_MAX);
    if (entry.url) entry.url = entry.url.slice(0, URL_MAX);
    entry.page = this.#page || undefined;
    this.#console.push(entry);
    if (this.#console.length > this.#limit) { this.#console.shift(); this.#droppedConsole++; }
  }

  #pushNetwork(entry: NetworkEntry): void {
    entry.url = entry.url.slice(0, URL_MAX);
    entry.page = this.#page || undefined;
    this.#network.push(entry);
    if (this.#network.length > this.#limit) { this.#network.shift(); this.#droppedNetwork++; }
  }

  #event(method: string, params: any, sessionId?: string): void {
    const at = Date.now();
    // Chrome replays stored console messages and log entries when the domains are enabled: those carry older times.
    const before = typeof params?.timestamp === 'number' && params.timestamp < this.since - 100;
    if (method === 'Page.frameNavigated' && !sessionId && !params.frame?.parentId) { this.#page = params.frame?.url ?? ''; return; }
    if (method === 'Runtime.consoleAPICalled') {
      const level = params.type === 'error' || params.type === 'assert' ? 'error' : params.type === 'warning' ? 'warning' : null;
      if (!level) return;
      const frame = params.stackTrace?.callFrames?.[0];
      this.#pushConsole({level, source: 'console', text: (params.args ?? []).map(argText).join(' ').trim(), url: frame?.url, line: frame ? frame.lineNumber + 1 : undefined, at, before});
    } else if (method === 'Runtime.exceptionThrown') {
      const d = params.exceptionDetails ?? {};
      this.#pushConsole({level: 'error', source: 'exception', text: (d.exception?.description ?? d.text ?? '').split('\n')[0], url: d.url, line: d.lineNumber !== undefined ? d.lineNumber + 1 : undefined, at, before});
    } else if (method === 'Log.entryAdded') {
      const e = params.entry ?? {};
      if (e.level !== 'error' && e.level !== 'warning') return;
      if (e.url && this.#isMuted(e.url)) return;
      this.#pushConsole({level: e.level, source: 'log', text: e.text ?? '', url: e.url, line: e.lineNumber !== undefined ? e.lineNumber + 1 : undefined, at, before});
    } else if (method === 'Network.requestWillBeSent') {
      const url = params.request?.url ?? '', reqMethod = params.request?.method ?? 'GET';
      this.#requests.set(`${sessionId ?? ''}|${params.requestId}`, {method: reqMethod, url, type: params.type, muted: this.#isMuted(url, reqMethod)});
      // Long-lived pages make many requests: the table of open ones is bounded (oldest dropped first).
      while (this.#requests.size > REQUESTS_MAX) this.#requests.delete(this.#requests.keys().next().value!);
    } else if (method === 'Network.loadingFinished') {
      this.#requests.delete(`${sessionId ?? ''}|${params.requestId}`);
    } else if (method === 'Network.responseReceived') {
      const key = `${sessionId ?? ''}|${params.requestId}`;
      const status = params.response?.status ?? 0;
      const req = this.#requests.get(key);
      if (status < 400 || req?.muted) return;
      this.#pushNetwork({method: req?.method ?? 'GET', url: params.response?.url ?? req?.url ?? '', status, type: params.type ?? req?.type, at});
    } else if (method === 'Network.loadingFailed') {
      // A request the page or the user cancelled is not a failure.
      const key = `${sessionId ?? ''}|${params.requestId}`;
      const req = this.#requests.get(key);
      this.#requests.delete(key);
      if (params.canceled || req?.muted) return;
      const reason = params.corsErrorStatus?.corsError ? `CORS: ${params.corsErrorStatus.corsError}` : params.blockedReason ? `заблокирован: ${params.blockedReason}` : params.errorText;
      this.#pushNetwork({method: req?.method ?? 'GET', url: req?.url ?? '', error: reason, type: params.type ?? req?.type, at});
    }
  }
}

const clock = (t: number) => new Date(t).toTimeString().slice(0, 8);
const footer = (since: number) => `сеть видна с ${clock(since)} (с подключения к вкладке); консоль — и до него (Chrome хранит сообщения). `
  + 'Чтобы собрать запросы с начала загрузки, нужна перезагрузка страницы: reload: true (есть только в режиме «Агент»).';
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
  if (!entries.length) { lines.push(level === 'warning' ? 'Предупреждений нет.' : 'Ошибок нет.'); return lines.join('\n'); }
  const pages = new Set(entries.map(e => e.page ?? ''));
  const groups = grouped(entries, e => `${e.level}|${e.text}|${pages.size > 1 ? e.page : ''}`);
  lines.push(`Записей: ${entries.length}, разных: ${groups.length}.`);
  for (const {item, count} of groups.slice(0, GROUPS_MAX)) {
    const where = item.url ? ` · ${item.url}${item.line ? `:${item.line}` : ''}` : '';
    lines.push(`${item.level === 'error' ? 'ошибка' : 'предупреждение'}${count > 1 ? ` ×${count}` : ''}${item.source === 'exception' ? ' (необработанное исключение)' : ''}${item.before ? ' (до подключения)' : ''} · ${cut(item.text)}${where}${item.page ? ` · на странице ${item.page}` : ''}`);
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
    lines.push(`${item.method} ${item.status ?? item.error}${count > 1 ? ` ×${count}` : ''} · ${cut(base(item.url))}${item.type ? ` (${item.type.toLowerCase()})` : ''}${item.page ? ` · на странице ${item.page}` : ''}`);
  }
  if (groups.length > GROUPS_MAX) lines.push(`… и ещё ${groups.length - GROUPS_MAX}.`);
  if (d.dropped) lines.push(`Старые записи вытеснены лимитом: ${d.dropped}.`);
  return lines.join('\n');
}
