// Actions on fixture pages: clicks with evidence and diff, navigation, new tab, dialogs, typing, select, checkbox,
// Enter, hover menu, clickable divs, shadow DOM, a cross-site iframe, scrolling.
export default async function ({openPage, base, server, sleep, log}) {
  const dev = await openPage(`${base}/dev.html`);
  await dev.waitFor(`window.layer?.call`);
  const open = url => dev.eval(`layer.openTab(${JSON.stringify(url)})`);
  const call = (tabId, method, args = {}) => dev.eval(`layer.call(${tabId}, ${JSON.stringify(method)}, ${JSON.stringify(args)})`);
  const refOf = async (tabId, role, name) => {
    const r = await call(tabId, 'find', {role, name});
    const m = r.text.match(new RegExp(`\\[([a-zA-Z]+\\d+)\\] ${role} "${name}`));
    if (!m) throw new Error(`нет метки для ${role} "${name}": ${r.text}`);
    return m[1];
  };
  const status = tabId => dev.eval(`layer.evalInTab(${tabId}, "document.getElementById('status')?.textContent")`);
  const must = (cond, message) => { if (!cond) throw new Error(message); };

  // basic: click changes the status; a link navigates; target=_blank opens a tab.
  const basic = await open(`${server.origin}/basic.html`);
  await call(basic, 'snapshot', {mode: 'all'});
  const clicked = await call(basic, 'click', {ref: await refOf(basic, 'button', 'Изменить статус')});
  log('click:', clicked.text.replace(/\n/g, ' | '));
  must(clicked.ok && clicked.text.includes('реакция: страница изменилась') && clicked.text.includes('+ text "Кнопка нажата"'), `click: ${clicked.text}`);
  const blank = await call(basic, 'click', {ref: await refOf(basic, 'link', 'Открыть в новой вкладке')});
  must(blank.ok && blank.text.includes('новая вкладка'), `blank: ${blank.text}`);
  const nav = await call(basic, 'click', {ref: await refOf(basic, 'link', 'Перейти на вторую страницу')});
  must(nav.ok && nav.text.includes('переход') && nav.text.includes('basic2.html'), `nav: ${nav.text}`);

  // dialog: alert is reported fast, then answered.
  const dialog = await open(`${server.origin}/dialog.html`);
  const alertRef = await refOf(dialog, 'button', 'Показать alert');
  const t0 = Date.now();
  const alerted = await call(dialog, 'click', {ref: alertRef});
  log(`alert: ${Date.now() - t0} мс`);
  must(alerted.text.includes('диалог') && alerted.text.includes('Привет из alert') && Date.now() - t0 <= 2500, `alert: ${alerted.text}`);
  const blocked = await call(dialog, 'snapshot');
  must(!blocked.ok && blocked.text.includes('DIALOG_OPEN'), `snapshot при диалоге: ${blocked.text}`);
  const answered = await call(dialog, 'handleDialog', {accept: true});
  must(answered.ok, `handleDialog: ${answered.text}`);
  const after = await call(dialog, 'snapshot', {mode: 'all'});
  must(after.ok && after.text.includes('alert закрыт'), `после диалога: ${after.text}`);

  // form: typing, password never echoed, select, checkboxes (incl. hidden one via its label), Enter submits.
  const form = await open(`${server.origin}/form.html`);
  must((await call(form, 'type', {ref: await refOf(form, 'textbox', 'Имя'), text: 'Павел'})).ok, 'type имя');
  const typedPw = await call(form, 'type', {ref: await refOf(form, 'textbox', 'Пароль'), text: 'новый-пароль-99', clear: true});
  must(typedPw.ok && !typedPw.text.includes('новый-пароль-99'), `пароль в квитанции: ${typedPw.text}`);
  must((await call(form, 'set', {ref: await refOf(form, 'combobox', 'Город'), value: 'Санкт-Петербург'})).ok, 'set город');
  must((await call(form, 'set', {ref: await refOf(form, 'checkbox', 'Согласен с правилами'), value: true})).ok, 'set согласие');
  const news = await call(form, 'set', {ref: await refOf(form, 'checkbox', 'Получать рассылку'), value: true});
  must(news.ok && news.text.includes('связанной подписи'), `рассылка: ${news.text}`);
  const submitted = await call(form, 'type', {ref: await refOf(form, 'textbox', 'Email'), text: 'p@example.com', submit: true});
  must(submitted.ok, `email+Enter: ${submitted.text}`);
  const formStatus = await status(form);
  must(formStatus === 'Отправлено: Павел / p@example.com / spb / согласие / рассылка', `статус формы: ${formStatus}`);

  // hover menu.
  const hover = await open(`${server.origin}/hover.html`);
  must((await call(hover, 'hover', {ref: await refOf(hover, 'button', 'Профиль')})).ok, 'hover');
  const menu = await call(hover, 'click', {ref: await refOf(hover, 'button', 'Выйти из профиля')});
  must(menu.ok && (await status(hover)) === 'Выход выбран', `меню: ${menu.text}`);

  // clickable divs, shadow DOM, cross-site iframe.
  const divs = await open(`${server.origin}/divbuttons.html`);
  await call(divs, 'click', {ref: await refOf(divs, 'clickable', 'Удалить черновик')});
  must((await status(divs)) === 'Удалить черновик нажата', 'div-кнопка');
  const shadow = await open(`${server.origin}/shadow.html`);
  await call(shadow, 'click', {ref: await refOf(shadow, 'button', 'Закрытая тень')});
  must((await status(shadow)) === 'Закрытая нажата', 'закрытая тень');
  await call(shadow, 'click', {ref: await refOf(shadow, 'button', 'Открытая тень')});
  must((await status(shadow)) === 'Открытая нажата', 'открытая тень');
  const frames = await open(`${server.origin}/frames.html?x=${server.crossOrigin}/frame-inner.html`);
  const crossClick = await call(frames, 'click', {ref: await refOf(frames, 'button', 'Кнопка: Чужой')});
  must(crossClick.ok && crossClick.text.includes('Чужой нажата'), `iframe другого сайта: ${crossClick.text}`);

  // scrolling a long list.
  const list = await open(`${server.origin}/long-list.html`);
  const scrolled = await call(list, 'scroll', {direction: 'down'});
  must(scrolled.ok, `scroll: ${scrolled.text}`);
  const snap = await call(list, 'snapshot');
  must(!/видно 0–/.test(snap.text), `после прокрутки: ${snap.text.split('\n')[0]}`);
}
