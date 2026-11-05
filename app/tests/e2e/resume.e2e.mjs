// A worker stopped in the middle of an agent task (needs Ollama with qwen3.5:35b-a3b; run with `pnpm e2e resume`):
// the reply shows as interrupted with its steps, and «Продолжить» lets the agent finish the task.
const MODEL = 'qwen3.5:35b-a3b';

export default async function ({openPage, base, server, send, sleep, log}) {
  const tags = await fetch('http://localhost:11434/api/tags').then(r => r.json()).catch(() => null);
  if (!tags?.models?.some(m => m.name === MODEL)) { log(`SKIP: нет Ollama с ${MODEL}`); return; }
  const dev = await openPage(`${base}/dev.html`);
  await dev.waitFor(`window.layer?.openTab`);
  const tab = await dev.eval(`layer.openTab(${JSON.stringify(`${server.origin}/highlight.html`)})`);
  await sleep(800);
  const must = (cond, message) => { if (!cond) throw new Error(message); };
  let chat = await openPage(`${base}/index.html`);
  await chat.waitFor(`[...document.querySelectorAll('#modelSelect option')].some(o => o.value === '${MODEL}')`, 15000);
  await chat.eval(`(() => { const s = document.querySelector('#modelSelect'); s.value = '${MODEL}'; s.dispatchEvent(new Event('change')); })()`);
  const prepare = `(() => { const m = document.getElementById('modeSelect'); m.value = 'agent'; m.dispatchEvent(new Event('change'));
    const p = document.getElementById('permissionSelect'); p.value = 'auto'; p.dispatchEvent(new Event('change'));
    chrome.tabs.query = async () => [{id: ${tab}}]; })()`;
  await chat.eval(prepare);
  await chat.eval(`(() => { const t = document.querySelector('#prompt'); t.value = 'Выдели на странице все слова «настройки» зелёным цветом, затем кнопку «Применить» красной рамкой.'; t.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true})); })()`);
  await chat.waitFor(`document.querySelectorAll('.msg.assistant .step').length >= 1`, 120000);
  await send('ServiceWorker.enable', {}, chat.sessionId);
  await send('ServiceWorker.stopAllWorkers', {}, chat.sessionId);
  await sleep(1500);
  await chat.eval(`location.reload()`).catch(() => {});
  await sleep(2000);
  await chat.waitFor(`document.querySelector('.msg.assistant .msg-status')?.textContent === 'прервано'`, 15000);
  const stepsBefore = await chat.eval(`document.querySelectorAll('.msg.assistant .step').length`);
  log(`прервано после шагов: ${stepsBefore}`);
  await chat.eval(prepare);
  await chat.waitFor(`document.querySelector('.continue-btn')`, 5000);
  await chat.eval(`document.querySelector('.continue-btn').click()`);
  await chat.waitFor(`document.querySelectorAll('.msg.assistant').length === 2 && !document.querySelector('.msg.assistant.streaming')`, 300000);
  const answer = await chat.eval(`[...document.querySelectorAll('.msg.assistant .md')].at(-1).textContent`);
  const steps = await chat.eval(`[...document.querySelectorAll('.msg.assistant')].at(-1).querySelectorAll('.step').length`);
  log(`продолжение: шагов ${steps}; ответ: ${answer.replace(/\s+/g, ' ').slice(0, 160)}`);
  const done = await dev.eval(`layer.rawEval(${tab}, "[[...CSS.highlights.keys()].some(k => k.startsWith('assistant-')), document.querySelectorAll('[data-assistant-overlay]').length]")`);
  must(done[0], 'после продолжения на странице нет подсветки текста');
  must(stepsBefore >= 1 && steps >= 1, 'нет шагов');
}
