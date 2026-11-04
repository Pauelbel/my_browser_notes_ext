// Read tools of the layer on fixture pages: readiness, budget, masking, iframes, find, read.
export default async function ({openPage, base, server, sleep, log}) {
  const dev = await openPage(`${base}/dev.html`);
  await dev.waitFor(`window.layer?.call`);
  const open = url => dev.eval(`layer.openTab(${JSON.stringify(url)})`);
  const call = (tabId, method, args = {}, budget) => dev.eval(`layer.call(${tabId}, ${JSON.stringify(method)}, ${JSON.stringify(args)}, ${budget ?? 'undefined'})`);
  const must = (cond, message) => { if (!cond) throw new Error(message); };

  // Readiness: the button that appears after 800 ms is in a snapshot taken right away.
  const late = await open(`${server.origin}/late.html`);
  const lateResult = await call(late, 'snapshot');
  must(lateResult.ok && lateResult.text.includes('Появилась позже'), `late: ${lateResult.text}`);

  // Budget on a 3000-row page.
  const list = await open(`${server.origin}/long-list.html`);
  await sleep(500);
  const started = Date.now();
  const listResult = await call(list, 'snapshot', {}, 3000);
  const body = listResult.text.split('<<<page-content>>>')[1].split('<<<end-page-content>>>')[0];
  log(`long-list: ${Date.now() - started} мс, тело ${body.length} симв.`);
  must(body.length <= 3000 + 2, `long-list: тело ${body.length}`);
  must(listResult.text.includes('Ниже ещё'), 'long-list: нет уведомления «Ниже ещё»');
  must(Date.now() - started < 5000, 'long-list: дольше 5 с');

  // The password set by the page script never shows.
  const form = await open(`${server.origin}/form.html`);
  const formResult = await call(form, 'snapshot', {mode: 'all'});
  must(!formResult.text.includes('секрет-12345') && formResult.text.includes('(скрыто)'), `form: ${formResult.text}`);

  // A button inside a cross-site iframe is described.
  const frames = await open(`${server.origin}/frames.html?x=${server.crossOrigin}/frame-inner.html`);
  const framesResult = await call(frames, 'snapshot');
  must(framesResult.text.includes('Кнопка: Чужой'), `frames: ${framesResult.text}`);

  // find returns a labelled line.
  const overlay = await open(`${server.origin}/overlay.html`);
  const found = await call(overlay, 'find', {role: 'button', name: 'Принять'});
  must(/\[[a-zA-Z]+\d+\] button "Принять"/.test(found.text), `find: ${found.text}`);

  // read gives Markdown.
  const basic = await open(`${server.origin}/basic.html`);
  const read = await call(basic, 'read');
  const content = read.text.split('<<<page-content>>>')[1];
  must(content.split('\n').slice(2).join('\n').trim().startsWith('# Тестовая страница'), `read: ${read.text}`);
  must(/\[Перейти на вторую страницу\]\(.*basic2\.html\)/.test(read.text), `read: ${read.text}`);
}
