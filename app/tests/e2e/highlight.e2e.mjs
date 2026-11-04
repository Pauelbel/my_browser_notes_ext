// Highlighting: text by colour (checked on screenshot pixels), an element frame that does not block clicks,
// clearing, restoring after going back, and the overlay never showing up in a snapshot.
import {decodePng, yellowShare} from './png.mjs';

export default async function ({openPage, base, server, send, sleep, log}) {
  const dev = await openPage(`${base}/dev.html`);
  await dev.waitFor(`window.layer?.call`);
  const url = `${server.origin}/highlight.html`;
  const tab = await dev.eval(`layer.openTab(${JSON.stringify(url)})`);
  const call = (method, args = {}) => dev.eval(`layer.call(${tab}, ${JSON.stringify(method)}, ${JSON.stringify(args)})`);
  const inTab = expr => dev.eval(`layer.evalInTab(${tab}, ${JSON.stringify(expr)})`);
  const must = (cond, message) => { if (!cond) throw new Error(message); };
  // Our own CDP session on the fixture tab, for screenshots.
  const {targetInfos} = await send('Target.getTargets');
  const target = targetInfos.find(t => t.url === url);
  const {sessionId} = await send('Target.attachToTarget', {targetId: target.targetId, flatten: true});
  const rectOfWord = () => inTab(`(() => { const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode());) { const i = n.data.indexOf('Все настройки'); if (i >= 0) { const r = document.createRange(); r.setStart(n, i + 4); r.setEnd(n, i + 13); const b = r.getBoundingClientRect(); return {x: b.x, y: b.y, width: b.width, height: b.height}; } } })()`);
  const share = async () => {
    const {data} = await send('Page.captureScreenshot', {format: 'png'}, sessionId);
    return yellowShare(decodePng(Buffer.from(data, 'base64')), await rectOfWord());
  };

  const nodesBefore = await inTab(`document.querySelectorAll('*').length`);
  const lit = await call('highlight', {text: 'настройки', color: 'yellow'});
  must(lit.ok && lit.text.includes('3'), `highlight текст: ${lit.text}`);
  await sleep(200);
  const litShare = await share();
  log(`доля жёлтого в слове: ${litShare.toFixed(2)}`);
  must(litShare > 0.2, `подсветка не видна на скриншоте (${litShare})`);
  must(await inTab(`document.querySelectorAll('*').length`) === nodesBefore, 'подсветка текста изменила DOM');

  const snap = await call('snapshot', {mode: 'all'});
  const ref = snap.text.match(/\[([a-zA-Z]+\d+)\] button "Применить"/)?.[1];
  must(ref, `нет метки кнопки: ${snap.text}`);
  const framed = await call('highlight', {ref, color: 'red'});
  must(framed.ok, `highlight элемента: ${framed.text}`);
  must(await inTab(`document.querySelectorAll('[data-assistant-overlay]').length`) === 1, 'нет слоя подсветки');
  await inTab(`document.querySelector('button').onclick = () => document.title = 'нажата'`);
  const clicked = await call('click', {ref});
  must(clicked.ok && await inTab('document.title') === 'нажата', `клик сквозь слой: ${clicked.text}`);
  const again = await call('snapshot', {mode: 'all'});
  must(!again.text.includes('assistant-overlay') && (again.text.match(/button "Применить"/g) ?? []).length === 1, `слой в описании: ${again.text}`);

  const cleared = await call('clearHighlights');
  must(cleared.ok, `clear: ${cleared.text}`);
  await sleep(200);
  must(await share() < 0.05, 'подсветка не снялась');

  await call('highlight', {text: 'настройки'});
  await call('navigate', {url: `${server.origin}/basic2.html`});
  await call('navigate', {action: 'back'});
  await sleep(800);
  const restored = await share();
  log(`после возврата: ${restored.toFixed(2)}`);
  must(restored > 0.2, `подсветка не восстановилась (${restored})`);
}
