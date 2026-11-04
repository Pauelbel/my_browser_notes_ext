// Tabs of an agent task: a frame around the page it works on, new tabs in one group, no switching to foreign
// tabs, everything released at the end.
export default async function ({openPage, base, server, sleep}) {
  const dev = await openPage(`${base}/dev.html`);
  await dev.waitFor(`window.layer?.agentTabs`);
  const start = await dev.eval(`layer.openTab(${JSON.stringify(`${server.origin}/basic.html`)})`);
  const foreign = await dev.eval(`layer.openTab(${JSON.stringify(`${server.origin}/basic2.html`)})`);
  const t = (expr) => dev.eval(`layer.agentTabs.${expr}`);
  const inTab = (tabId, expr) => dev.eval(`layer.rawEval(${tabId}, ${JSON.stringify(expr)})`);
  const must = (cond, message) => { if (!cond) throw new Error(message); };

  await t(`create(${start}, 'Тестовая задача агента')`);
  await t(`current()`);
  must(await inTab(start, `document.querySelectorAll('[data-assistant-overlay]').length`) >= 1, 'нет рамки');
  const opened = await t(`open(${JSON.stringify(`${server.origin}/basic2.html`)})`);
  must(/вкладка \d+/.test(opened), `open: ${opened}`);
  const second = Number(opened.match(/вкладка (\d+)/)[1]);
  await sleep(800);
  const groups = await dev.eval(`Promise.all([${start}, ${second}].map(id => chrome.tabs.get(id).then(t => t.groupId)))`);
  must(groups[0] !== -1 && groups[0] === groups[1], `группа: ${groups}`);
  const list = await t(`list()`);
  must(list.includes(`* [вкладка ${second}]`) && list.includes(`[вкладка ${start}]`), `list: ${list}`);
  const refused = await t(`switch(${foreign}).then(() => 'переключилась', e => e.message)`);
  must(refused !== 'переключилась', 'переключилась на чужую вкладку');
  await t(`current()`);
  await t(`releaseAll()`);
  await sleep(300);
  must(await inTab(start, `document.querySelectorAll('[data-assistant-overlay]').length`) === 0, 'рамка осталась после releaseAll');
  const attached = await dev.eval(`chrome.debugger.getTargets().then(ts => ts.filter(t => [${start}, ${second}].includes(t.tabId) && t.attached).length)`);
  must(attached === 0, `отладчик остался подключён: ${attached}`);
}
