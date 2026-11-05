// The tabs of one agent task: the tab it started in and the ones it opened (or a page opened for it). They are kept
// in one tab group named after the chat, and the page the agent works on gets a frame while the debugger is attached.
import {PageError, normalizeUrl, pageText, siteOf, type PageTools} from '../page/index.ts';

export interface TabsDeps {
  tabs: typeof chrome.tabs;
  tabGroups?: typeof chrome.tabGroups;
  open: (tabId: number) => Promise<{tools: PageTools; release(): Promise<void>}>;
  border: boolean;
  title: string;
  /** Sites the user blocked: no tab is opened there. */
  blocked?: (site: string) => boolean | Promise<boolean>;
  /** The chat's tabs and group, shared by its replies (a new reply continues in the same tabs and group). */
  memory?: {members: Set<number>; groupId: number | null};
}

const TITLE_MAX = 20;

export class AgentTabs {
  readonly #deps: TabsDeps;
  readonly #start: number;
  #current: number;
  readonly #members: Set<number>;
  readonly #handles = new Map<number, Promise<{tools: PageTools; release(): Promise<void>}>>();
  readonly #memory: {members: Set<number>; groupId: number | null};
  readonly #onCreated = (tab: chrome.tabs.Tab) => {
    if (tab.id !== undefined && tab.openerTabId !== undefined && this.#members.has(tab.openerTabId)) this.adopt(tab.id);
  };

  constructor(startTabId: number, deps: TabsDeps) {
    this.#deps = deps;
    this.#start = startTabId;
    this.#current = startTabId;
    this.#memory = deps.memory ?? {members: new Set(), groupId: null};
    this.#members = this.#memory.members;
    this.#members.add(startTabId);
    deps.tabs.onCreated?.addListener(this.#onCreated);
  }

  async current(): Promise<PageTools> {
    const tabId = this.#current;
    let handle = this.#handles.get(tabId);
    if (!handle) {
      handle = this.#deps.open(tabId).then(async h => {
        await this.#group(tabId);
        if (this.#deps.border) await h.tools.border(true);
        return h;
      });
      this.#handles.set(tabId, handle);
      handle.catch(() => this.#handles.delete(tabId));
    }
    return (await handle).tools;
  }

  async list(): Promise<string> {
    const lines: string[] = [];
    for (const id of this.#members) {
      const tab = await this.#deps.tabs.get(id).catch(() => null);
      if (!tab) { this.#members.delete(id); continue; }
      lines.push(`${id === this.#current ? '* ' : '  '}[вкладка ${id}] ${tab.title ?? ''} — ${tab.url ?? ''}`);
    }
    // Titles and addresses come from pages: they are data like any page text.
    return pageText('Вкладки задачи (* — текущая):', lines.join('\n'), []);
  }

  async open(url: string): Promise<string> {
    const target = normalizeUrl(url);
    const site = siteOf(target);
    if (site && await this.#deps.blocked?.(site)) throw new PageError('SITE_BLOCKED', `Сайт ${site} заблокирован пользователем: вкладку не открываю.`);
    const tab = await this.#deps.tabs.create({url: target, active: true, openerTabId: this.#current});
    this.#members.add(tab.id!);
    this.#current = tab.id!;
    await this.#group(tab.id!);
    return `открыта вкладка ${tab.id}: ${target}; она теперь текущая`;
  }

  async switch(tabId: number): Promise<string> {
    if (!this.#members.has(tabId)) throw new PageError('NOT_FOUND', `Вкладка ${tabId} не из этой задачи: работать можно только во вкладках задачи (tabs list).`);
    await this.#deps.tabs.update(tabId, {active: true});
    this.#current = tabId;
    return `текущая вкладка ${tabId}`;
  }

  async close(tabId: number): Promise<string> {
    if (tabId === this.#start) throw new PageError('NOT_FOUND', 'Стартовую вкладку задачи закрывать нельзя.');
    if (!this.#members.has(tabId)) throw new PageError('NOT_FOUND', `Вкладка ${tabId} не из этой задачи.`);
    await this.#releaseTab(tabId);
    await this.#deps.tabs.remove(tabId).catch(() => {});
    this.#members.delete(tabId);
    if (this.#current === tabId) this.#current = this.#start;
    return `вкладка ${tabId} закрыта; текущая — ${this.#current}`;
  }

  adopt(tabId: number): void {
    if (this.#members.has(tabId)) return;
    this.#members.add(tabId);
    void this.#group(tabId);
  }

  async releaseAll(): Promise<void> {
    this.#deps.tabs.onCreated?.removeListener(this.#onCreated);
    await Promise.all([...this.#handles.keys()].map(id => this.#releaseTab(id)));
  }

  async #releaseTab(tabId: number): Promise<void> {
    const handle = this.#handles.get(tabId);
    this.#handles.delete(tabId);
    if (!handle) return;
    try {
      const h = await handle;
      await h.tools.border(false);
      await h.release();
    } catch {
      // A tab that failed to open or is gone has nothing to release.
    }
  }

  async #group(tabId: number): Promise<void> {
    try {
      if (this.#memory.groupId === null) {
        this.#memory.groupId = await this.#deps.tabs.group({tabIds: [tabId]});
        await this.#deps.tabGroups?.update(this.#memory.groupId, {title: this.#deps.title.slice(0, TITLE_MAX), color: 'blue'});
      } else {
        await this.#deps.tabs.group({groupId: this.#memory.groupId, tabIds: [tabId]}).catch(async () => {
          // The group was closed or emptied since the last reply: start a new one.
          this.#memory.groupId = await this.#deps.tabs.group({tabIds: [tabId]});
        });
      }
    } catch {
      // Grouping is a convenience: a tab in another window or a browser without groups works ungrouped.
    }
  }
}
