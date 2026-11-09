// The gate before dangerous actions: questions by category, deny, allow, the user's own step, blocked sites.
export default async function ({openPage, base, server}) {
  const dev = await openPage(`${base}/dev.html`);
  await dev.waitFor(`window.layer?.setGate`);
  const tab = await dev.eval(`layer.openTab(${JSON.stringify(`${server.origin}/danger.html`)})`);
  const call = (method, args = {}) => dev.eval(`layer.call(${tab}, ${JSON.stringify(method)}, ${JSON.stringify(args)})`);
  const gate = (answers, blocked = [], beforeAnswer) => dev.eval(`layer.setGate(${tab}, ${JSON.stringify({answers, blocked, beforeAnswer})})`);
  const questions = () => dev.eval(`layer.questions.splice(0)`);
  const status = () => dev.eval(`layer.evalInTab(${tab}, "document.getElementById('status').textContent")`);
  const refOf = async (role, name) => {
    const r = await call('find', {role, name});
    const m = r.text.match(new RegExp(`\\[([a-zA-Z]+\\d+)\\] ${role} "${name}`));
    if (!m) throw new Error(`нет метки ${role} "${name}": ${r.text}`);
    return m[1];
  };
  const must = (cond, message) => { if (!cond) throw new Error(message); };

  await gate(['deny']);
  const denied = await call('click', {ref: await refOf('button', 'Удалить черновик')});
  const q1 = await questions();
  must(!denied.ok && denied.text.includes('USER_DECLINED') && q1[0]?.category === 'delete', `deny: ${denied.text} ${JSON.stringify(q1)}`);
  must(await status() === 'Статус: ждём', 'после отказа статус изменился');

  await gate(['allow']);
  const allowed = await call('click', {ref: await refOf('button', 'Удалить черновик')});
  must(allowed.ok && await status() === 'Удалить черновик', `allow: ${allowed.text}`);

  await gate(['user-did-it']);
  const paid = await call('click', {ref: await refOf('button', 'Оплатить 1 990 ₽')});
  const q2 = await questions();
  must(paid.ok && paid.text.includes('пользовател') && q2.at(-1)?.category === 'pay' && await status() === 'Удалить черновик', `pay: ${paid.text}`);

  await gate(['deny']);
  await call('type', {ref: await refOf('textbox', 'Пароль'), text: 'секрет'});
  must((await questions()).at(-1)?.category === 'secret', 'пароль без вопроса');

  await gate(['allow']);
  await call('click', {ref: await refOf('button', 'Сохранить')});
  must((await questions()).at(-1)?.category === 'submit', 'отправка формы без вопроса');

  await gate(['deny']);
  const selectDenied = await call('set', {ref: await refOf('combobox', 'Тариф'), value: 'Платный'});
  must(!selectDenied.ok && selectDenied.text.includes('USER_DECLINED') && (await questions()).at(-1)?.category === 'submit', `select без вопроса: ${selectDenied.text}`);

  await gate(['deny']);
  const reloadDenied = await call('navigate', {action: 'reload'});
  must(!reloadDenied.ok && reloadDenied.text.includes('USER_DECLINED') && (await questions()).at(-1)?.category === 'submit', `reload без вопроса: ${reloadDenied.text}`);

  await gate([]);
  const enterNoRef = await call('press', {key: 'Enter'});
  must(!enterNoRef.ok, `Enter без ref должен требовать ref: ${enterNoRef.text}`);
  const link = await call('click', {ref: await refOf('link', 'Обычная ссылка')});
  must(link.ok && (await questions()).length === 0, `обычная ссылка: ${link.text}`);

  await gate([], ['localhost']);
  const blocked = await call('navigate', {url: `${server.origin}/danger.html`});
  must(!blocked.ok && blocked.text.includes('SITE_BLOCKED'), `заблокированный сайт: ${blocked.text}`);

  // press Enter after an allow goes to the target, even if focus moved while the user decided.
  await gate([]);
  must((await call('navigate', {url: `${server.origin}/danger.html`})).ok, 'возврат на danger.html');
  await gate(['allow'], [], `[...document.querySelectorAll('button')].find(b => b.textContent === 'Выйти').focus()`);
  await call('snapshot');
  const pressed = await call('press', {key: 'Enter', ref: await refOf('button', 'Удалить черновик')});
  must(pressed.ok && await status() === 'Удалить черновик', `press после разрешения ушёл не туда: ${await status()} · ${pressed.text}`);

  // Accepting confirm('Удалить запись?') opened by an unnamed button asks first.
  await gate([]);
  must((await call('navigate', {url: `${server.origin}/confirm.html`})).ok, 'переход на confirm.html');
  await gate(['deny']);
  const trash = await call('click', {ref: await refOf('button', '🗑')});
  must(trash.text.includes('диалог'), `корзина: ${trash.text}`);
  const accepted = await call('handleDialog', {accept: true});
  must(!accepted.ok && accepted.text.includes('USER_DECLINED') && (await questions()).at(-1)?.category === 'delete', `confirm без вопроса: ${accepted.text}`);
  must((await call('handleDialog', {accept: false})).ok, 'отказ в диалоге не прошёл');
  must(await status() === 'Удаление отменено', `статус после отмены: ${await status()}`);

  // A tab that is on a blocked site is not worked on.
  await gate([], ['localhost']);
  const onBlocked = await call('snapshot');
  must(!onBlocked.ok && onBlocked.text.includes('SITE_BLOCKED'), `работа на заблокированном сайте: ${onBlocked.text}`);
}
