// Chat chrome without a model: persisted context usage is shown, and clearing removes the conversation and resets it.
export default async function ({openPage, base}) {
  const chat = await openPage(`${base}/index.html`);
  await chat.waitFor(`document.querySelector('#profileSelect').options.length > 0`);
  const id = `ui-${Date.now()}`;
  await chat.eval(`(async () => {
    const id = ${JSON.stringify(id)};
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('assistant', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['conversations', 'messages'], 'readwrite');
      tx.objectStore('conversations').put({id, title: 'Контекст UI', titleByUser: false, profileId: 'assistant', mode: 'chat', permission: 'ask', createdAt: 1, updatedAt: 2});
      tx.objectStore('messages').put({id: id + '-u', conversationId: id, role: 'user', text: 'Привет', reasoning: '', status: 'done', createdAt: 1});
      tx.objectStore('messages').put({id: id + '-a', conversationId: id, role: 'assistant', text: 'Ответ', reasoning: '', status: 'done', createdAt: 2,
        context: {used: 2048, limit: 8192, system: 300, tools: 400, history: 1348}});
      tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error);
    });
    db.close();
    localStorage.setItem('assistant:last', id);
    location.reload();
  })()`);
  await chat.waitFor(`!document.querySelector('#contextUsage').hidden && !document.querySelector('#clearChat').disabled`);
  const context = await chat.eval(`({text: document.querySelector('#contextText').textContent, tip: document.querySelector('#contextUsage').dataset.tip, width: document.querySelector('#contextFill').style.width})`);
  if (!context.text.includes('25%') || context.width !== '25%' || !context.tip.includes('история')) throw new Error(`индикатор контекста: ${JSON.stringify(context)}`);

  await chat.eval(`document.querySelector('#clearChat').click()`);
  await chat.waitFor(`document.querySelector('#confirmDialog').open`);
  await chat.eval(`document.querySelector('#confirmOk').click()`);
  await chat.waitFor(`document.querySelector('#clearChat').disabled && document.querySelector('#contextUsage').hidden && document.querySelector('.chat-empty')`);
  const remains = await chat.eval(`new Promise((resolve, reject) => { const r = indexedDB.open('assistant', 1); r.onsuccess = () => { const q = r.result.transaction('conversations').objectStore('conversations').get(${JSON.stringify(id)}); q.onsuccess = () => resolve(Boolean(q.result)); q.onerror = () => reject(q.error); }; r.onerror = () => reject(r.error); })`);
  if (remains) throw new Error('очищенный чат остался в IndexedDB');
}
