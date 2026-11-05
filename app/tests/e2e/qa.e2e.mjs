// QA tools of the layer on a page with known bugs: console, network (collected from a reload), page checks.
export default async function ({openPage, base, server, log}) {
  const dev = await openPage(`${base}/dev.html`);
  await dev.waitFor(`window.layer?.call`);
  const tab = await dev.eval(`layer.openTab(${JSON.stringify(`${server.origin}/qa.html`)})`);
  const call = (method, args = {}) => dev.eval(`layer.call(${tab}, ${JSON.stringify(method)}, ${JSON.stringify(args)})`);
  const must = (cond, message) => { if (!cond) throw new Error(message); };

  const before = await call('consoleLog');
  must(before.text.includes('reload: true'), `нет пояснения про момент сбора: ${before.text}`);
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
}
