// Chat mode with a real local model (needs Ollama with qwen3.5:35b-a3b; run with `pnpm e2e chat-tools`):
// the model reads the open page through the snapshot tool, and the debugger is detached after the reply.
const MODEL = 'qwen3.5:35b-a3b';

export default async function ({openPage, base, server, sleep, log}) {
  const tags = await fetch('http://localhost:11434/api/tags').then(r => r.json()).catch(() => null);
  if (!tags?.models?.some(m => m.name === MODEL)) { log(`SKIP: нет Ollama с ${MODEL}`); return; }
  const dev = await openPage(`${base}/dev.html`);
  await dev.waitFor(`window.layer?.openTab`);
  const tab = await dev.eval(`layer.openTab(${JSON.stringify(`${server.origin}/basic.html`)})`);
  await sleep(800);

  const chat = await openPage(`${base}/index.html`);
  await chat.waitFor(`[...document.querySelectorAll('#modelSelect option')].some(o => o.value === '${MODEL}')`, 15000);
  await chat.eval(`(() => { const s = document.querySelector('#modelSelect'); s.value = '${MODEL}'; s.dispatchEvent(new Event('change')); })()`);
  // Opened as a tab, the chat's own window has the chat as its active tab; point it at the fixture tab instead.
  await chat.eval(`chrome.tabs.query = async () => [{id: ${tab}}]`);
  await sleep(300);
  await chat.eval(`(() => { const t = document.querySelector('#prompt'); t.value = 'Какие кнопки есть на открытой странице? Перечисли их названия.'; t.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})); })()`);
  await chat.waitFor(`document.querySelector('.msg.assistant') && !document.querySelector('.msg.assistant.streaming')`, 240000);
  const answer = await chat.eval(`document.querySelector('.msg.assistant .md').textContent`);
  const steps = await chat.eval(`document.querySelector('.msg.assistant .steps summary')?.textContent ?? ''`);
  const stepStates = await chat.eval(`[...document.querySelectorAll('.msg.assistant .step')].map(s => s.className).join(',')`);
  log(`шаги: ${steps} (${stepStates})`);
  log(`ответ: ${answer.slice(0, 200).replace(/\n/g, ' ')}`);
  if (!/snapshot|find|read/.test(steps)) throw new Error(`модель не посмотрела страницу: ${steps}`);
  if (/error/.test(stepStates)) throw new Error(`шаг с ошибкой: ${await chat.eval(`document.querySelector('.msg.assistant .steps-list').textContent`)}`);
  if (!answer.includes('Изменить статус')) throw new Error(`в ответе нет кнопки со страницы: ${answer}`);
  await sleep(500);
  const attached = await chat.eval(`chrome.debugger.getTargets().then(ts => ts.find(t => t.tabId === ${tab})?.attached)`);
  if (attached) throw new Error('отладчик остался подключён после ответа');
}
