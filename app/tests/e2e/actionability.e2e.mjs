// Checks before an action: covered by an overlay, disabled then enabled, stale labels, a button in a cross-site iframe.
export default async function ({openPage, base, server, sleep, log}) {
  const dev = await openPage(`${base}/dev.html`);
  await dev.waitFor(`window.layer?.debug`);
  const open = url => dev.eval(`layer.openTab(${JSON.stringify(url)})`);
  const call = (tabId, method, args = {}) => dev.eval(`layer.call(${tabId}, ${JSON.stringify(method)}, ${JSON.stringify(args)})`);
  const actionable = (tabId, ref) => dev.eval(`layer.debug.actionable(${tabId}, ${JSON.stringify(ref)})`);
  const refOf = async (tabId, role, name) => {
    const r = await call(tabId, 'find', {role, name});
    const m = r.text.match(new RegExp(`\\[([a-zA-Z]+\\d+)\\] ${role} "${name}`));
    if (!m) throw new Error(`нет метки для ${role} "${name}": ${r.text}`);
    return m[1];
  };
  const must = (cond, message) => { if (!cond) throw new Error(message); };

  const overlay = await open(`${server.origin}/overlay.html`);
  const covered = await actionable(overlay, await refOf(overlay, 'button', 'Купить'));
  log('overlay:', JSON.stringify(covered));
  must(covered.code === 'COVERED' && covered.message.includes('cookies'), `overlay: ${JSON.stringify(covered)}`);
  must(covered.ms >= 4500, `overlay: перекрытие должно перепроверяться до бюджета, прошло ${covered.ms} мс`);

  const late = await open(`${server.origin}/late.html`);
  const started = Date.now();
  const enabled = await actionable(late, await refOf(late, 'button', 'Станет активной'));
  must(enabled.ok && Date.now() - started < 5000, `late: ${JSON.stringify(enabled)}`);

  const basic = await open(`${server.origin}/basic.html`);
  const linkRef = await refOf(basic, 'link', 'Перейти на вторую страницу');
  await dev.eval(`layer.navigate(${basic}, ${JSON.stringify(`${server.origin}/basic2.html`)})`);
  await sleep(800);
  const stale = await actionable(basic, linkRef);
  must(stale.code === 'REF_STALE', `stale после перехода: ${JSON.stringify(stale)}`);

  const rerender = await open(`${server.origin}/rerender.html`);
  const targetRef = await refOf(rerender, 'button', 'Цель');
  await dev.eval(`layer.evalInTab(${rerender}, "document.querySelectorAll('button')[1].click()")`);
  await sleep(300);
  const gone = await actionable(rerender, targetRef);
  must(gone.code === 'REF_STALE', `stale после перерисовки: ${JSON.stringify(gone)}`);

  const frames = await open(`${server.origin}/frames.html?x=${server.crossOrigin}/frame-inner.html`);
  const inFrame = await actionable(frames, await refOf(frames, 'button', 'Кнопка: Чужой'));
  log('cross frame point:', JSON.stringify(inFrame.point));
  must(inFrame.ok && inFrame.point.x > 472 && inFrame.point.x < 876 && inFrame.point.y > 93 && inFrame.point.y < 257, `frames: ${JSON.stringify(inFrame)}`);
  const sameFrame = await actionable(frames, await refOf(frames, 'button', 'Кнопка: Свой'));
  must(sameFrame.ok && sameFrame.point.x > 24 && sameFrame.point.x < 428, `frames свой: ${JSON.stringify(sameFrame)}`);
}
