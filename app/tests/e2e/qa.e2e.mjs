// QA tools of the layer on a page with known bugs: console, network (collected from a reload), page checks.
export default async function ({openPage, base, server, log}) {
  const dev = await openPage(`${base}/dev.html`);
  await dev.waitFor(`window.layer?.call`);
  const tab = await dev.eval(`layer.openTab(${JSON.stringify(`${server.origin}/qa.html`)})`);
  const call = (method, args = {}) => dev.eval(`layer.call(${tab}, ${JSON.stringify(method)}, ${JSON.stringify(args)})`);
  const must = (cond, message) => { if (!cond) throw new Error(message); };

  await new Promise(r => setTimeout(r, 1000));
  const before = await call('consoleLog');
  must(before.text.includes('reload: true'), `нет пояснения про момент сбора: ${before.text}`);
  // Errors from before attaching come from Chrome's replay of stored messages.
  must(/Не удалось загрузить настройки/.test(before.text) && /до подключения/.test(before.text), `нет сообщений до подключения: ${before.text}`);
  const consoleLog = await call('consoleLog', {reload: true});
  log(consoleLog.text.split('\n').slice(2, 6).join(' | '));
  must(/×3 · Не удалось загрузить настройки/.test(consoleLog.text), `консоль: ${consoleLog.text}`);
  must(/необработанное исключение/.test(consoleLog.text) && consoleLog.text.includes('undefinedFunctionCall'), `исключение: ${consoleLog.text}`);
  const network = await call('networkLog');
  must(/GET 404 · .*\/missing-api/.test(network.text), `404: ${network.text}`);
  must(/ERR_CONNECTION_REFUSED|ERR_/.test(network.text) && network.text.includes('127.0.0.1:9'), `ошибка сети: ${network.text}`);

  const started = Date.now();
  const checks = await call('pageChecks');
  const ms = Date.now() - started;
  log(`проверки за ${ms} мс`);
  log(checks.text.replace(/\n+/g, ' | ').slice(0, 600));
  must(checks.text.includes('Битые картинки: 1') && checks.text.includes('/nope.png'), 'битая картинка');
  must(/Ссылки этого сайта с ошибкой: 1/.test(checks.text) && /404 · .*\/missing/.test(checks.text), 'сломанная ссылка');
  must(/Элементы без подписи[^:]*: 1/.test(checks.text) && /\[[a-zA-Z]+\d+\] button/.test(checks.text), 'кнопка без подписи');
  must(/Картинки без alt: 1/.test(checks.text), 'картинка без alt');
  must(/Переполнение по ширине: страница шире окна/.test(checks.text) && checks.text.includes('Очень широкий блок'), 'переполнение');
  must(/Перекрывающиеся элементы: 1/.test(checks.text) && checks.text.includes('Нижняя кнопка'), 'перекрытие');
  must(ms < 15000, `проверки слишком долгие: ${ms} мс`);

  const shot = await dev.eval(`layer.call(${tab}, 'screenshot').then(r => ({ok: r.ok, text: r.text, size: r.image ? r.image.length : 0, jpeg: r.image ? r.image.startsWith('/9j/') : false}))`);
  log(`скриншот: ${shot.text.replace(/<<<[^>]*>>>|\n/g, ' ').trim()}, ${shot.size} символов base64`);
  must(shot.ok && shot.jpeg && /\d+×\d+/.test(shot.text) && Number(shot.text.match(/(\d+)×/)[1]) <= 1280, `скриншот: ${JSON.stringify(shot)}`);

  // On a HiDPI screen (devicePixelRatio 2) the image itself must still be at most 1280 px wide.
  await dev.eval(`layer.emulateDpr(${tab}, 2)`);
  const hidpi = await dev.eval(`layer.call(${tab}, 'screenshot').then(r => r.image || '')`);
  const jpeg = Buffer.from(hidpi, 'base64');
  let width = 0;
  for (let i = 2; i < jpeg.length - 9; i++) {
    if (jpeg[i] === 0xFF && (jpeg[i + 1] === 0xC0 || jpeg[i + 1] === 0xC2)) { width = jpeg.readUInt16BE(i + 7); break; }
  }
  log(`скриншот при DPR 2: ширина ${width} px`);
  must(width > 0 && width <= 1280, `ширина JPEG при DPR 2: ${width}`);
}
