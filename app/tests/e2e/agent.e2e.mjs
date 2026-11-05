// The agent with a real local model (needs Ollama with qwen3.5:35b-a3b; run with `pnpm e2e agent`): highlight a
// word, click a button, a delete that asks first (decline, then allow), follow a link and read the new page.
const MODEL = 'qwen3.5:35b-a3b';

export default async function ({openPage, base, server, sleep, log}) {
  const tags = await fetch('http://localhost:11434/api/tags').then(r => r.json()).catch(() => null);
  if (!tags?.models?.some(m => m.name === MODEL)) { log(`SKIP: нет Ollama с ${MODEL}`); return; }
  const dev = await openPage(`${base}/dev.html`);
  await dev.waitFor(`window.layer?.openTab`);
  const chat = await openPage(`${base}/index.html`);
  await chat.waitFor(`[...document.querySelectorAll('#modelSelect option')].some(o => o.value === '${MODEL}')`, 15000);
  await chat.eval(`(() => { const s = document.querySelector('#modelSelect'); s.value = '${MODEL}'; s.dispatchEvent(new Event('change')); })()`);
  const inTab = (tabId, expr) => dev.eval(`layer.rawEval(${tabId}, ${JSON.stringify(expr)})`);
  const must = (cond, message) => { if (!cond) throw new Error(message); };

  async function task(page, text, {permission = 'auto', onPrompt} = {}) {
    const tab = await dev.eval(`layer.openTab(${JSON.stringify(`${server.origin}/${page}`)})`);
    await sleep(800);
    await chat.eval(`document.getElementById('newChat').click()`);
    await sleep(300);
    await chat.eval(`(() => {
      const m = document.getElementById('modeSelect'); m.value = 'agent'; m.dispatchEvent(new Event('change'));
      const p = document.getElementById('permissionSelect'); p.value = '${permission}'; p.dispatchEvent(new Event('change'));
      chrome.tabs.query = async () => [{id: ${tab}}];
      const t = document.querySelector('#prompt'); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
    })()`);
    const started = Date.now();
    await chat.waitFor(`document.querySelector('.msg.assistant')`, 20000);
    for (;;) {
      if (onPrompt && await chat.eval(`Boolean(document.querySelector('.prompt-card button:not(:disabled)'))`)) {
        const cardText = await chat.eval(`document.querySelector('.prompt-card p').textContent`);
        await onPrompt(cardText);
      }
      if (await chat.eval(`!document.querySelector('.msg.assistant.streaming')`)) break;
      if (Date.now() - started > 300000) throw new Error(`задача не закончилась за 5 минут: ${text}`);
      await sleep(300);
    }
    const answer = await chat.eval(`document.querySelector('.msg.assistant:last-of-type .md')?.textContent ?? ''`);
    const steps = await chat.eval(`[...document.querySelectorAll('.msg.assistant .step')].map(s => s.textContent.slice(0, 60))`);
    const error = await chat.eval(`document.querySelector('.msg.assistant .msg-error:not([hidden])')?.textContent ?? ''`);
    log(`«${text}»: ${Math.round((Date.now() - started) / 1000)} с, шагов ${steps.length}: ${steps.map(s => s.split(' ').slice(0, 2).join(' ')).join(' | ')}`);
    log(`   ответ: ${answer.replace(/\s+/g, ' ').slice(0, 160)}${error ? ` · ошибка: ${error}` : ''}`);
    return {tab, answer, steps, error};
  }

  const one = await task('highlight.html', 'Выдели на странице все слова «настройки» жёлтым цветом.');
  must(one.steps.some(s => s.includes('highlight')), 'не было шага highlight');
  must(await inTab(one.tab, `[...CSS.highlights.keys()].some(k => k.startsWith('assistant-'))`), 'на странице нет подсветки');

  const two = await task('basic.html', 'Нажми кнопку «Изменить статус» и скажи, что изменилось на странице.');
  must(two.steps.some(s => s.includes('click')), 'не было шага click');
  must(await inTab(two.tab, `document.getElementById('status').textContent`) === 'Кнопка нажата', 'статус не изменился');
  must(two.answer.includes('Кнопка нажата'), `в ответе нет нового статуса: ${two.answer}`);

  let asked = '';
  const three = await task('danger.html', 'Удали черновик на этой странице.', {permission: 'ask', onPrompt: async text => {
    asked = text;
    await chat.eval(`[...document.querySelectorAll('.prompt-card button')].find(b => b.textContent === 'Отклонить')?.click()`);
  }});
  must(asked.includes('удаление'), `не было вопроса об удалении: ${asked}`);
  must(await inTab(three.tab, `document.getElementById('status').textContent`) === 'Статус: ждём', 'удалил без разрешения');
  const threeAllowed = await task('danger.html', 'Удали черновик на этой странице.', {permission: 'ask', onPrompt: async () => {
    await chat.eval(`[...document.querySelectorAll('.prompt-card button')].find(b => b.textContent === 'Разрешить')?.click()`);
  }});
  must(await inTab(threeAllowed.tab, `document.getElementById('status').textContent`) === 'Удалить черновик', 'не удалил после разрешения');

  const four = await task('basic.html', 'Перейди по ссылке на вторую страницу и скажи, какой там заголовок.');
  must(four.steps.some(s => /click|navigate/.test(s)), 'не было перехода');
  must(four.answer.includes('Вторая страница'), `в ответе нет заголовка: ${four.answer}`);
}
