// Recent chats: a popover under the history button with search, rename and delete.
// Deleting goes through the worker, which stops a reply in progress before the chat is removed.
import type {Conversation} from '../store/types.ts';
import type {Client} from './client.ts';
import type {ChatView} from './chat.ts';
import {listConversations, onAssistantChange, renameConversation} from '../store/assistant-db.ts';
import {filterConversations} from './history-filter.ts';
import {confirmDialog, promptDialog} from './dialogs.ts';
import {TITLE_LENGTH} from '../store/title.ts';
import {icons} from '../../icons.js'; // plain JS, shared with the notes UI

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const clock = new Intl.DateTimeFormat('ru', {hour: '2-digit', minute: '2-digit'});
const day = new Intl.DateTimeFormat('ru', {day: '2-digit', month: '2-digit'});
const when = (time: number) => new Date(time).toDateString() === new Date().toDateString() ? clock.format(time) : day.format(time);
const zoom = () => parseFloat(getComputedStyle(document.documentElement).zoom) || 1;

export function initHistory(chat: ChatView, client: Client): void {
  const button = $<HTMLButtonElement>('openHistory');
  const popover = $('historyMenu');
  const search = $<HTMLInputElement>('historySearch');
  const list = $('historyList');
  const itemMenu = $('historyItemMenu');
  let conversations: Conversation[] = [];
  let menuTarget: Conversation | null = null;

  function place(element: HTMLElement, rect: DOMRect, alignRight = false): void {
    element.hidden = false;
    const z = zoom(), width = element.offsetWidth * z, height = element.offsetHeight * z;
    let x = alignRight ? rect.right - width : rect.left;
    x = Math.max(4, Math.min(x, innerWidth - width - 4));
    let y = rect.bottom + 4;
    if (y + height > innerHeight - 4) y = Math.max(4, rect.top - 4 - height);
    element.style.left = `${x / z}px`;
    element.style.top = `${y / z}px`;
  }

  function render(): void {
    const shown = filterConversations(conversations, search.value);
    if (!shown.length) {
      const empty = document.createElement('div');
      empty.className = 'h-empty';
      empty.textContent = conversations.length ? 'Ничего не найдено' : 'Чатов пока нет';
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(...shown.map(c => {
      const row = document.createElement('div');
      row.className = 'h-row';
      row.classList.toggle('active', c.id === chat.current());
      const open = document.createElement('button');
      open.className = 'h-open';
      open.innerHTML = '<span class="h-dot"></span><span class="h-title"></span><span class="h-time"></span>';
      open.querySelector('.h-dot')!.classList.toggle('on', chat.running().has(c.id));
      open.querySelector('.h-title')!.textContent = c.title;
      open.querySelector('.h-time')!.textContent = when(c.updatedAt);
      open.onclick = () => { close(); void chat.open(c.id); };
      const more = document.createElement('button');
      more.className = 't-more';
      more.innerHTML = icons.more;
      more.setAttribute('aria-label', 'Действия с чатом');
      more.onclick = event => { event.stopPropagation(); menuTarget = c; place(itemMenu, more.getBoundingClientRect(), true); };
      row.append(open, more);
      return row;
    }));
  }

  async function refresh(): Promise<void> {
    conversations = await listConversations();
    if (!popover.hidden) render();
  }

  function close(): void {
    popover.hidden = true;
    itemMenu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  }

  button.addEventListener('click', async () => {
    if (!popover.hidden) { close(); return; }
    conversations = await listConversations();
    search.value = '';
    render();
    place(popover, button.getBoundingClientRect());
    button.setAttribute('aria-expanded', 'true');
    search.focus();
  });
  search.addEventListener('input', render);
  document.addEventListener('pointerdown', event => {
    const target = event.target as Element;
    if (!target.closest('#historyItemMenu')) itemMenu.hidden = true;
    if (!target.closest('#historyMenu, #historyItemMenu, #openHistory')) close();
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });

  itemMenu.addEventListener('click', async event => {
    const action = (event.target as Element).closest<HTMLButtonElement>('button')?.dataset.action;
    const target = menuTarget;
    itemMenu.hidden = true;
    if (!target || !action) return;
    if (action === 'rename') {
      const title = await promptDialog('Название чата', target.title, TITLE_LENGTH);
      if (title) await renameConversation(target.id, title);
    } else if (action === 'delete' && await confirmDialog(`Удалить чат «${target.title}» навсегда?`)) {
      client.post({type: 'delete', conversationId: target.id});
      if (target.id === chat.current()) await chat.open(null);
    }
  });

  onAssistantChange(() => { void refresh(); });
  chat.onRunningChange(() => { if (!popover.hidden) render(); });
}
