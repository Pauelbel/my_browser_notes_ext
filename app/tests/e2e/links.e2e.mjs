// The link check on a page with 100+ links: at most 40 checked, dangerous links and other sites never requested,
// redirects to other sites not followed, done within 15 s; the checker's requests do not show up in network_log.
export default async function ({openPage, base, server, log}) {
  const dev = await openPage(`${base}/dev.html`);
  await dev.waitFor(`window.layer?.call`);
  const tab = await dev.eval(`layer.openTab(${JSON.stringify(`${server.origin}/links.html`)})`);
  const call = (method, args = {}) => dev.eval(`layer.call(${tab}, ${JSON.stringify(method)}, ${JSON.stringify(args)})`);
  const must = (cond, message) => { if (!cond) throw new Error(message); };
  await call('snapshot');
  server.requested.length = 0;
  const started = Date.now();
  const checks = await call('pageChecks');
  const ms = Date.now() - started;
  const hits = [...server.requested];
  log(`проверка за ${ms} мс, запросов к серверу: ${hits.length}`);
  log(checks.text.split('\n').filter(l => /Ссылки|опасн|не проверял/.test(l)).join(' | '));
  for (const path of ['/logout', '/account/delete', '/unsubscribe']) must(!hits.some(h => h.endsWith(path)), `запрошена опасная ссылка ${path}: ${hits.filter(h => h.includes(path))}`);
  must(hits.filter(h => h.includes('/basic.html')).length <= 40, 'проверено больше 40 ссылок');
  must(/опасн/.test(checks.text) && /Выйти|logout/.test(checks.text), `опасные ссылки не названы: ${checks.text}`);
  must(!/example\.com/.test(checks.text.split('Ссылки')[1]?.split('\n\n')[0] ?? '') || /не проверял/.test(checks.text), 'внешний сайт помечен сломанным');
  must(ms < 15000, `слишком долго: ${ms} мс`);
  const network = await call('networkLog');
  must(!/HEAD/.test(network.text), `запросы проверки попали в журнал сети: ${network.text}`);
}
