// The harness page of the extension answers, and a fixture page is served.
export default async function ({openPage, base, server}) {
  const page = await openPage(`${server.origin}/basic.html`);
  const title = await page.waitFor(`document.querySelector('h1')?.textContent`);
  if (!title.includes('Тестовая страница')) throw new Error(`заголовок: ${title}`);
  const dev = await openPage(`${base}/dev.html`);
  const pong = await dev.waitFor(`window.layer?.ping()`);
  if (pong !== 'pong') throw new Error(`ping: ${pong}`);
}
