// The two views of the panel, Chat and Notes. view-init.js applies the saved one before the first paint.
export type View = 'chat' | 'notes';
const KEY = 'assistant:view';

export function getView(): View {
  try { return localStorage.getItem(KEY) === 'notes' ? 'notes' : 'chat'; } catch { return 'chat'; }
}

export function setView(view: View): void {
  document.documentElement.dataset.view = view;
  try { localStorage.setItem(KEY, view); } catch {}
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-view-button]')) {
    button.setAttribute('aria-pressed', String(button.dataset.viewButton === view));
  }
}

export function initViews(): void {
  setView(getView());
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-view-button]')) {
    button.addEventListener('click', () => setView(button.dataset.viewButton as View));
  }
}
