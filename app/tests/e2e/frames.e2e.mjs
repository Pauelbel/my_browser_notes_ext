// Frames of a page with a same-site and a cross-site iframe; a browser page is refused with PAGE_NOT_SUPPORTED.
export default async function ({openPage, base, server, sleep, log}) {
  const dev = await openPage(`${base}/dev.html`);
  await dev.waitFor(`window.layer?.frames`);
  const tabId = await dev.eval(`layer.openTab(${JSON.stringify(`${server.origin}/frames.html?x=${server.crossOrigin}/frame-inner.html`)})`);
  await sleep(800);
  const frames = await dev.eval(`layer.frames(${tabId})`);
  log(JSON.stringify(frames.map(f => [f.url.replace(/^http:\/\/[^/]+/, ''), Boolean(f.sessionId), Boolean(f.parentFrameId)])));
  if (frames.length !== 3) throw new Error(`фреймов: ${frames.length}`);
  const cross = frames.find(f => f.url.startsWith(server.crossOrigin));
  const same = frames.find(f => f.url.includes('name=') && f.url.startsWith(server.origin));
  if (!cross?.sessionId) throw new Error('у фрейма другого сайта нет своей сессии');
  if (!cross.parentFrameId) throw new Error('у фрейма другого сайта нет родителя');
  if (!same || same.sessionId) throw new Error('фрейм того же сайта должен быть в сессии вкладки');
  const browserTab = await dev.eval(`layer.openTab('chrome://version')`);
  const error = await dev.eval(`layer.frames(${browserTab}).then(() => 'нет ошибки', e => e.code)`);
  if (error !== 'PAGE_NOT_SUPPORTED') throw new Error(`служебная страница: ${error}`);
}
