// The confirm and prompt dialogs of index.html, shared with the notes UI (which has its own copies of these helpers).
const $ = (id: string) => document.getElementById(id)!;

export function confirmDialog(text: string, ok = 'Удалить навсегда'): Promise<boolean> {
  const dialog = $('confirmDialog') as HTMLDialogElement;
  $('confirmText').textContent = text;
  $('confirmOk').textContent = ok;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise(resolve => {
    dialog.onclose = () => { $('confirmOk').textContent = 'Удалить навсегда'; resolve(dialog.returnValue === 'ok'); };
  });
}

export function promptDialog(label: string, value = '', maxLength = 70): Promise<string | null> {
  const dialog = $('promptDialog') as HTMLDialogElement;
  const input = $('promptInput') as HTMLInputElement;
  $('promptTitle').textContent = label;
  input.value = value;
  input.maxLength = maxLength;
  dialog.returnValue = '';
  dialog.showModal();
  input.select();
  return new Promise(resolve => {
    dialog.onclose = () => { input.maxLength = 70; resolve(dialog.returnValue === 'ok' ? input.value.trim() || null : null); };
  });
}
