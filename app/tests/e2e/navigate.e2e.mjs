// navigate and wait: HTTP status, back, waiting for text, a timeout, refused schemes.
export default async function ({openPage, base, server}) {
  const dev = await openPage(`${base}/dev.html`);
  await dev.waitFor(`window.layer?.call`);
  const tab = await dev.eval(`layer.openTab(${JSON.stringify(`${server.origin}/basic.html`)})`);
  const call = (method, args = {}) => dev.eval(`layer.call(${tab}, ${JSON.stringify(method)}, ${JSON.stringify(args)})`);
  const must = (cond, message) => { if (!cond) throw new Error(message); };

  const missing = await call('navigate', {url: `${server.origin}/missing`});
  must(missing.ok && missing.text.includes('404'), `404: ${missing.text}`);
  const back = await call('navigate', {action: 'back'});
  must(back.ok && back.text.includes('Тестовая страница'), `back: ${back.text}`);
  await call('navigate', {url: `${server.origin}/late.html`});
  const waited = await call('wait', {text: 'Станет активной'});
  must(waited.ok, `wait текст: ${waited.text}`);
  const timeout = await call('wait', {text: 'Такого текста нет', timeoutMs: 300});
  must(!timeout.ok && timeout.text.includes('TIMEOUT'), `wait таймаут: ${timeout.text}`);
  const js = await call('navigate', {url: 'javascript:alert(1)'});
  must(!js.ok && js.text.includes('PAGE_NOT_SUPPORTED'), `javascript: ${js.text}`);
  const reload = await call('navigate', {action: 'reload'});
  must(reload.ok && reload.text.includes('Поздняя отрисовка'), `reload: ${reload.text}`);
}
