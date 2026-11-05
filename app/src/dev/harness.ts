// dev.html: exposes the page layer as window.layer for the e2e scenarios in tests/e2e.
// Fixture tabs open in their own window, so both they and this page stay visible and their timers run at full speed.
import {acquire, release, PageTools, type PageSession} from '../page/index.ts';
import {capture} from '../page/capture.ts';
import {AgentTabs} from '../agent/agent-tabs.ts';

async function withSession<T>(tabId: number, fn: (session: PageSession) => Promise<T>): Promise<T> {
  const session = await acquire(tabId);
  try { return await fn(session); } finally { await release(session); }
}

/** One session and one PageTools per tab for the whole scenario, so labels stay valid between calls. */
const open = new Map<number, Promise<PageTools>>();
function toolsFor(tabId: number, budget: number): Promise<PageTools> {
  let tools = open.get(tabId);
  if (!tools) { tools = acquire(tabId).then(session => new PageTools(session, {budget})); open.set(tabId, tools); }
  return tools;
}

const layer = {
  ping: () => 'pong',
  async openTab(url: string): Promise<number> {
    const win = await chrome.windows.create({url, width: 1000, height: 760});
    return win!.tabs![0].id!;
  },
  frames: (tabId: number) => withSession(tabId, async session => session.frames.list()),
  capture: (tabId: number) => withSession(tabId, capture),
  async call(tabId: number, method: string, args: object = {}, budget = 26214) {
    const tools = await toolsFor(tabId, budget);
    tools.budget = budget;
    return (tools as unknown as Record<string, (a: object) => Promise<unknown>>)[method](args);
  },
  debug: {
    actionable: async (tabId: number, ref: string) => (await toolsFor(tabId, 26214)).debugActionable(ref),
  },
  async emulateDpr(tabId: number, dpr: number) {
    const tools = await toolsFor(tabId, 26214);
    await tools.session.cdp.send('Emulation.setDeviceMetricsOverride', {width: 0, height: 0, deviceScaleFactor: dpr, mobile: false});
  },
  async navigate(tabId: number, url: string) { await chrome.tabs.update(tabId, {url}); },
  async evalInTab(tabId: number, expression: string) {
    const tools = await toolsFor(tabId, 26214);
    const r = await tools.session.cdp.send<{result: {value: unknown}}>('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
    return r.result.value;
  },
  questions: [] as unknown[],
  /** Evaluates in a tab through a shared or temporary debugger session. */
  rawEval: (tabId: number, expression: string) => withSession(tabId, async session =>
    (await session.cdp.send<{result: {value: unknown}}>('Runtime.evaluate', {expression, returnByValue: true})).result.value),
  agentTabs: {
    instance: null as AgentTabs | null,
    create(startTabId: number, title: string) {
      this.instance = new AgentTabs(startTabId, {tabs: chrome.tabs, tabGroups: chrome.tabGroups, border: true, title,
        open: async tabId => { const session = await acquire(tabId); const tools = new PageTools(session, {budget: 26214}); return {tools, release: async () => { tools.dispose(); await release(session); }}; }});
      return true;
    },
    async current() { await this.instance!.current(); return true; },
    open(url: string) { return this.instance!.open(url); },
    list() { return this.instance!.list(); },
    switch(tabId: number) { return this.instance!.switch(tabId); },
    releaseAll() { return this.instance!.releaseAll(); },
  },
  /** A scripted gate for scenarios: answers in order, and the blocked sites. */
  async setGate(tabId: number, script: {answers: string[]; blocked: string[]; beforeAnswer?: string}) {
    const tools = await toolsFor(tabId, 26214);
    const answers = [...script.answers];
    tools.gate = {
      check: async q => {
        layer.questions.push(q);
        // A scenario can change the page while "the user" decides, as a person clicking around would.
        if (script.beforeAnswer) await tools.session.cdp.send('Runtime.evaluate', {expression: script.beforeAnswer});
        return {decision: (answers.shift() ?? 'deny') as 'allow'};
      },
      blocked: site => script.blocked.includes(site),
    };
  },
  async done(tabId: number) {
    const tools = await open.get(tabId);
    open.delete(tabId);
    if (tools) { tools.dispose(); await release(tools.session); }
  },
};
Object.assign(window, {layer});
