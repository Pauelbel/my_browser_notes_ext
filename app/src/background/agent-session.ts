// One agent reply's world: its tabs, the gate that applies the user's rules to dangerous actions, and its tools.
import type {ToolSet} from 'ai';
import type {Gate, GateAnswer, GateQuestion, PageTools} from '../page/index.ts';
import {USER_STEP} from '../page/index.ts';
import {AgentTabs} from '../agent/agent-tabs.ts';
import {buildAgentTools, type ActTools} from '../agent/tools.ts';
import type {NotesApi} from '../agent/notes.ts';
import type {ScreenshotStore} from '../agent/screenshots.ts';
import {decideWrite, ruleFor} from '../agent/permissions.ts';
import type {PanelAnswer, PendingPrompt} from '../shared/protocol.ts';
import type {Conversation, Profile, Settings, SiteRule, ToolName} from '../store/types.ts';
import type {LocatorKind} from '../agent/locator-intent.ts';

type Ask = (prompt: Omit<PendingPrompt, 'id' | 'conversationId'>) => Promise<PanelAnswer>;

const CATEGORY_TEXT: Record<string, string> = {
  pay: 'оплата', access: 'выдача доступа', secret: 'ввод секрета', captcha: 'капча', delete: 'удаление', logout: 'выход из аккаунта', send: 'отправка', submit: 'отправка формы',
};

/** Page text in a card is cut short, so a long name cannot push the category out of sight. */
const short = (text: string) => (text.length > 80 ? `${text.slice(0, 79)}…` : text);

function actionText(q: GateQuestion): string {
  const name = short(q.name);
  if (q.action === 'type') return `Ввести текст в «${name}»`;
  if (q.action === 'handle_dialog') return `Ответить на диалог страницы «${name}»`;
  if (q.action.startsWith('press')) return `Нажать ${q.action.slice(6)} на «${name}»`;
  return `Нажать «${name}»`;
}

/**
 * The user's rules applied to dangerous actions. The chat's mode and the site rules are read at every question,
 * so a switch to Ask or a new block in the panel applies to the run already going.
 */
export function makeGate(opts: {permission: () => Promise<'ask' | 'auto'>; rules: () => Promise<Record<string, SiteRule>>; ask: Ask;
  setSiteRule(site: string, rule: SiteRule): Promise<unknown>}): Gate {
  return {
    blocked: async site => ruleFor(await opts.rules(), site) === 'block',
    async check(q): Promise<GateAnswer> {
      const where = q.site ? ` на ${q.site}` : '';
      if (USER_STEP.has(q.category)) {
        const answer = await opts.ask({kind: 'takeover', text: `Это ваш шаг (${CATEGORY_TEXT[q.category]}): ${actionText(q)}${where}. Сделайте это сами и нажмите «Готово».`, site: q.site, category: q.category});
        return {decision: answer === 'done' ? 'user-did-it' : 'cancel'};
      }
      const decision = decideWrite(await opts.permission(), ruleFor(await opts.rules(), q.site));
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
  /** Fresh settings and chat mode, read at every gate question. */
  readSettings: () => Promise<Settings>;
  readPermission: () => Promise<'ask' | 'auto'>;
  /** The chat's tabs and group, kept between replies. */
  memory: {members: Set<number>; groupId: number | null};
  ask: Ask;
  vision?: boolean;
  screenshots?: ScreenshotStore;
  locatorKind?: LocatorKind | null;
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
  const gate = makeGate({permission: deps.readPermission, rules: async () => (await deps.readSettings()).siteRules, ask: deps.ask, setSiteRule: deps.setSiteRule});
  const tabs = new AgentTabs(deps.tabId, {
    tabs: deps.tabsApi, tabGroups: deps.tabGroupsApi, border: deps.settings.border, title: deps.conversation.title,
    open: tabId => deps.openTab(tabId, gate), blocked: site => gate.blocked(site), memory: deps.memory,
  });
  const tools = buildAgentTools(deps.profile, {
    tabs: {current: async () => (await tabs.current()) as unknown as ActTools, list: () => tabs.list(), open: url => tabs.open(url),
      switch: id => tabs.switch(id), close: id => tabs.close(id)},
    notes: deps.notes ?? NO_NOTES,
    vision: deps.vision,
    screenshots: deps.screenshots,
    locatorKind: deps.locatorKind,
    ask: async ({question, kind}) => {
      const answer = await deps.ask({kind, text: question});
      if (kind === 'takeover') return answer === 'done' ? 'Пользователь сделал этот шаг и вернул вкладку.' : 'Пользователь отменил этот шаг: не пытайтесь сделать его другим способом.';
      return typeof answer === 'object' ? `Ответ пользователя: ${answer.text}` : 'Пользователь не ответил.';
    },
    confirmNotes: async what => {
      if (await deps.readPermission() === 'auto') return true;
      const answer = await deps.ask({kind: 'confirm', text: what});
      return answer === 'allow' || answer === 'allow-site';
    },
  });
  return {tools, names: Object.keys(tools) as ToolName[], release: () => tabs.releaseAll()};
}
