// Settings sections of the assistant: the Ollama connection and the profile editor.
// They live in the notes UI's settings dialog and refresh every time it opens.
import type {Profile, ToolName} from '../store/types.ts';
import {getSettings, saveSettings, setSiteRule} from '../store/settings.ts';
import type {SiteRule} from '../store/types.ts';
import {checkOllama} from '../llm/ollama.ts';
import {deleteProfile, listProfiles, putProfile} from '../store/assistant-db.ts';
import {DEFAULT_PROFILES, TOOL_CATALOGUE, validateProfile, type ToolGroup} from '../agent/profiles.ts';
import {confirmDialog} from './dialogs.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const GROUPS: [ToolGroup, string][] = [['read', 'Чтение'], ['act', 'Действия'], ['qa', 'QA-проверки']];

export function initSettings(): void {
  const url = $<HTMLInputElement>('ollamaUrl');
  const model = $<HTMLSelectElement>('settingsModel');
  const status = $('ollamaStatus');
  const profileList = $<HTMLSelectElement>('profileList');
  const name = $<HTMLInputElement>('profileName');
  const prompt = $<HTMLTextAreaElement>('profilePrompt');
  const error = $('profileError');
  const tools = $('profileTools');
  let profiles: Profile[] = [];
  /** The profile being edited; kept here because the select's value is lost while its options are rebuilt. */
  let currentId = '';

  // ——— Model ———

  function setStatus(text: string, state: 'ok' | 'warning' | 'error' | '' = ''): void {
    status.textContent = text;
    status.dataset.state = state;
  }

  async function check(): Promise<void> {
    const settings = await getSettings();
    url.value = settings.ollamaUrl;
    setStatus('Проверка…');
    const result = await checkOllama(settings.ollamaUrl, settings.model);
    const models = result.ok ? result.models : [];
    const names = settings.model && !models.includes(settings.model) ? [settings.model, ...models] : models;
    model.replaceChildren(...(settings.model ? [] : [new Option(models.length ? 'Выберите модель' : '—', '')]), ...names.map(m => new Option(m, m)));
    model.value = settings.model;
    if (!result.ok) setStatus(result.error, 'error');
    else if (result.warning) setStatus(result.warning, 'warning');
    else setStatus(`Подключено, моделей: ${models.length}`, 'ok');
  }

  url.addEventListener('change', async () => { await saveSettings({ollamaUrl: url.value}); await check(); });
  model.addEventListener('change', async () => { await saveSettings({model: model.value}); await check(); });
  $('checkOllama').addEventListener('click', () => { void check(); });

  // ——— Profiles ———

  const selected = () => profiles.find(p => p.id === currentId) ?? profiles[0];

  function renderTools(profile: Profile): void {
    const parts: HTMLElement[] = [tools.querySelector('legend')!];
    for (const [group, title] of GROUPS) {
      const heading = document.createElement('h4');
      heading.textContent = title;
      parts.push(heading);
      for (const tool of TOOL_CATALOGUE.filter(t => t.group === group)) {
        const label = document.createElement('label');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.value = tool.name;
        box.checked = profile.tools.includes(tool.name);
        label.append(box, tool.label);
        parts.push(label);
      }
    }
    tools.replaceChildren(...parts);
  }

  function renderProfile(): void {
    const profile = selected();
    profileList.replaceChildren(...profiles.map(p => new Option(p.name, p.id)));
    profileList.value = profile.id;
    name.value = profile.name;
    prompt.value = profile.prompt;
    error.hidden = true;
    renderTools(profile);
    $<HTMLButtonElement>('deleteProfile').disabled = profiles.length <= 1;
  }

  async function loadProfiles(selectId?: string): Promise<void> {
    profiles = await listProfiles();
    if (selectId) currentId = selectId;
    if (!profiles.some(p => p.id === currentId)) currentId = profiles[0].id;
    renderProfile();
  }

  async function saveProfile(): Promise<void> {
    const profile = selected();
    const problem = validateProfile({name: name.value, prompt: prompt.value});
    error.hidden = !problem;
    error.textContent = problem ?? '';
    if (problem) return;
    const checked = [...tools.querySelectorAll<HTMLInputElement>('input:checked')].map(b => b.value as ToolName);
    const next: Profile = {...profile, name: name.value.trim(), prompt: prompt.value, tools: checked};
    profiles = profiles.map(p => p.id === next.id ? next : p);
    await putProfile(next);
    profileList.selectedOptions[0].text = next.name;
  }

  profileList.addEventListener('change', () => { currentId = profileList.value; renderProfile(); });
  name.addEventListener('change', () => { void saveProfile(); });
  prompt.addEventListener('change', () => { void saveProfile(); });
  tools.addEventListener('change', () => { void saveProfile(); });
  $('newProfile').addEventListener('click', async () => {
    const profile: Profile = {id: crypto.randomUUID(), name: 'Новый профиль', prompt: '', tools: [...DEFAULT_PROFILES[0].tools], createdAt: Date.now()};
    await putProfile(profile);
    await loadProfiles(profile.id);
    name.select();
  });
  $('deleteProfile').addEventListener('click', async () => {
    const profile = selected();
    if (!await confirmDialog(`Удалить профиль «${profile.name}»?`, 'Удалить')) return;
    await deleteProfile(profile.id);
    await loadProfiles();
  });

  // ——— Agent: frame and site rules ———

  const border = $<HTMLInputElement>('borderToggle');
  const rules = $('siteRules');
  const RULE_TEXT: Record<SiteRule, string> = {allow: 'разрешать', ask: 'спрашивать', block: 'блокировать'};

  async function renderAgent(): Promise<void> {
    const settings = await getSettings();
    border.checked = settings.border;
    const entries = Object.entries(settings.siteRules).sort(([a], [b]) => a.localeCompare(b));
    rules.replaceChildren(...entries.map(([site, rule]) => {
      const row = document.createElement('div');
      row.className = 'row';
      const name = document.createElement('span');
      name.className = 'site'; name.textContent = site;
      const select = document.createElement('select');
      for (const value of ['allow', 'ask', 'block'] as SiteRule[]) select.append(new Option(RULE_TEXT[value], value));
      select.value = rule;
      select.onchange = async () => { await setSiteRule(site, select.value as SiteRule); };
      const remove = document.createElement('button');
      remove.type = 'button'; remove.textContent = 'Убрать';
      remove.onclick = async () => { await setSiteRule(site, null); await renderAgent(); };
      row.append(name, select, remove);
      return row;
    }));
    if (!entries.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = 'Правил пока нет.'; rules.append(empty); }
  }
  border.addEventListener('change', () => { void saveSettings({border: border.checked}); });
  $('addSiteRule').addEventListener('click', async () => {
    const input = $<HTMLInputElement>('siteRuleSite');
    const site = input.value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    if (!site) return;
    await setSiteRule(site, $<HTMLSelectElement>('siteRuleValue').value as SiteRule);
    input.value = '';
    await renderAgent();
  });

  $('openSettings').addEventListener('click', () => {
    void loadProfiles();
    void check();
    void renderAgent();
  });
}
