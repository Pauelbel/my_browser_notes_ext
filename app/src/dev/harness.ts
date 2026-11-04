// dev.html: exposes the page layer as window.layer for the e2e scenarios in tests/e2e.
// Fixture tabs open in their own window, so both they and this page stay visible and their timers run at full speed.
import {acquire, release, type PageSession} from '../page/index.ts';
import {capture} from '../page/capture.ts';

async function withSession<T>(tabId: number, fn: (session: PageSession) => Promise<T>): Promise<T> {
  const session = await acquire(tabId);
  try { return await fn(session); } finally { await release(session); }
}

const layer = {
  ping: () => 'pong',
  async openTab(url: string): Promise<number> {
    const win = await chrome.windows.create({url, width: 1000, height: 760});
    return win!.tabs![0].id!;
  },
  frames: (tabId: number) => withSession(tabId, async session => session.frames.list()),
  capture: (tabId: number) => withSession(tabId, capture),
};
Object.assign(window, {layer});
