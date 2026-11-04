// One agent reply's world: its tabs, the gate that applies the user's rules to dangerous actions, and its tools.
import type {ToolSet} from 'ai';
import type {Gate, GateAnswer, GateQuestion, PageTools} from '../page/index.ts';
import {USER_STEP} from '../page/index.ts';
import {AgentTabs} from '../agent/agent-tabs.ts';
import {buildAgentTools, type ActTools} from '../agent/tools.ts';
import type {NotesApi} from '../agent/notes.ts';
import {decideWrite} from '../agent/permissions.ts';
import type {PanelAnswer, PendingPrompt} from '../shared/protocol.ts';
import type {Conversation, Profile, Settings, SiteRule, ToolName} from '../store/types.ts';

type Ask = (prompt: Omit<PendingPrompt, 'id' | 'conversationId'>) => Promise<PanelAnswer>;

const CATEGORY_TEXT: Record<string, string> = {
  pay: 'оплата', access: 'выдача доступа', secret: 'ввод секрета', delete: 'удаление', logout: 'выход из аккаунта', send: 'отправка', submit: 'отправка формы',
};

function actionText(q: GateQuestion): string {
  if (q.action === 'type') return `Ввести текст в «${q.name}»`;
  if (q.action === 'handle_dialog') return `Ответить на диалог страницы «${q.name}»`;
  if (q.action.startsWith('press')) return `Нажать ${q.action.slice(6)} на «${q.name}»`;
  return `Нажать «${q.name}»`;
}

export function makeGate(opts: {permission: 'ask' | 'auto'; settings: Settings; ask: Ask; setSiteRule(site: string, rule: SiteRule): Promise<unknown>}): Gate {
  return {
    blocked: site => opts.settings.siteRules[site] === 'block',
    async check(q): Promise<GateAnswer> {
      const where = q.site ? ` на ${q.site}` : '';
      if (USER_STEP.has(q.category)) {
        const answer = await opts.ask({kind: 'takeover', text: `Это ваш шаг (${CATEGORY_TEXT[q.category]}): ${actionText(q)}${where}. Сделайте это сами и нажмите «Готово».`, site: q.site, category: q.category});
        return {decision: answer === 'done' ? 'user-did-it' : 'cancel'};
      }
      const decision = decideWrite(opts.permission, opts.settings.siteRules[q.site]);
      if (decision === 'block') return {decision: 'deny'};
      if (decision === 'allow') return {decision: 'allow'};
      const answer = await opts.ask({kind: 'confirm', text: `${actionText(q)}${where} (${CATEGORY_TEXT[q.category]})?`, site: q.site, category: q.category});
      if (answer === 'allow-site' && q.site) await opts.setSiteRule(q.site, 'allow');
      return {decision: answer === 'allow' || answer === 'allow-site' ? 'allow' : answer === 'cancel' ? 'cancel' : 'deny'};
    },
  };
}

export interface AgentDeps {
  tabId: number;
  profile: Profile;
  conversation: Conversation;
  settings: Settings;
  ask: Ask;
  openTab: (tabId: number, gate: Gate) => Promise<{tools: PageTools; release(): Promise<void>}>;
  tabsApi: typeof chrome.tabs;
  tabGroupsApi?: typeof chrome.tabGroups;
  notes?: NotesApi;
  setSiteRule(site: string, rule: SiteRule): Promise<unknown>;
}

const NO_NOTES: NotesApi = {
  search: async () => 'Заметки недоступны.', read: async () => 'Заметки недоступны.', create: async () => 'Заметки недоступны.', append: async () => 'Заметки недоступны.',
};

export function createAgentSession(deps: AgentDeps): {tools: ToolSet; names: ToolName[]; release(): Promise<void>} {
  const gate = makeGate({permission: deps.conversation.permission, settings: deps.settings, ask: deps.ask, setSiteRule: deps.setSiteRule});
  const tabs = new AgentTabs(deps.tabId, {
    tabs: deps.tabsApi, tabGroups: deps.tabGroupsApi, border: deps.settings.border, title: deps.conversation.title,
    open: tabId => deps.openTab(tabId, gate),
  });
  const tools = buildAgentTools(deps.profile, {
    tabs: {current: async () => (await tabs.current()) as unknown as ActTools, list: () => tabs.list(), open: url => tabs.open(url),
      switch: id => tabs.switch(id), close: id => tabs.close(id)},
    notes: deps.notes ?? NO_NOTES,
    ask: async ({question, kind}) => {
      const answer = await deps.ask({kind, text: question});
      if (kind === 'takeover') return answer === 'done' ? 'Пользователь сделал этот шаг и вернул вкладку.' : 'Пользователь отменил этот шаг: не пытайтесь сделать его другим способом.';
      return typeof answer === 'object' ? `Ответ пользователя: ${answer.text}` : 'Пользователь не ответил.';
    },
    confirmNotes: async what => {
      if (deps.conversation.permission === 'auto') return true;
      const answer = await deps.ask({kind: 'confirm', text: what});
      return answer === 'allow' || answer === 'allow-site';
    },
  });
  return {tools, names: Object.keys(tools) as ToolName[], release: () => tabs.releaseAll()};
}
