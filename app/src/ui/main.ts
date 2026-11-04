// Entry point of the assistant UI in the side panel and the tab. The notes UI (app.js) runs beside it.
import {openAssistantDb} from '../store/assistant-db.ts';
import {connect} from './client.ts';
import {initViews} from './views.ts';
import {initChat, type ChatView} from './chat.ts';
import {initHistory} from './history.ts';

initViews();
await openAssistantDb();
let chat: ChatView | null = null;
const client = connect(event => chat?.handle(event));
chat = initChat(client);
document.getElementById('newChat')!.addEventListener('click', () => { void chat!.open(null); });
initHistory(chat, client);
