// Settings live under one key in chrome.storage.local, so the worker and every panel read the same values.
import type {Settings, SiteRule} from './types.ts';

export type KeyValueArea = Pick<chrome.storage.StorageArea, 'get' | 'set'>;

export const DEFAULT_SETTINGS: Settings = {ollamaUrl: 'http://localhost:11434', model: '', siteRules: {}, border: true};
const KEY = 'settings';

/** Accepts what people type: no scheme, trailing slashes, the /v1 suffix of the OpenAI-compatible address. */
export function normalizeOllamaUrl(input: string): string {
  let url = input.trim();
  if (!url) return DEFAULT_SETTINGS.ollamaUrl;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;
  url = url.replace(/\/+$/, '').replace(/\/v1$/, '').replace(/\/+$/, '');
  return url;
}

/** A canonical HTTP(S) hostname for a site rule; rejects ports, paths and public-suffix-like input. */
export function normalizeRuleSite(input: string): string | null {
  let value = input.trim().toLowerCase();
  if (!value) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
  // URL drops an explicit default port (https://x:443 -> port ""), so reject it before parsing.
  if (/:\d+(?:[/?#]|$)/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.port || url.username || url.password) return null;
    if (url.pathname !== '/' || url.search || url.hash) return null;
    const host = url.hostname.replace(/^www\./, '');
    const domain = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
    if (host !== 'localhost' && !domain.test(host)) return null;
    return host;
  } catch {
    return null;
  }
}

const defaultArea = (): KeyValueArea => chrome.storage.local;

export async function getSettings(area: KeyValueArea = defaultArea()): Promise<Settings> {
  const stored = (await area.get(KEY))[KEY] as Partial<Settings> | undefined;
  return {...DEFAULT_SETTINGS, ...stored, siteRules: {...stored?.siteRules}};
}

export async function saveSettings(patch: Partial<Settings>, area: KeyValueArea = defaultArea()): Promise<Settings> {
  const next = {...await getSettings(area), ...patch};
  next.ollamaUrl = normalizeOllamaUrl(next.ollamaUrl);
  await area.set({[KEY]: next});
  return next;
}

/** Sets or (with null) removes the rule for a site. Only the user changes rules: no agent call reaches this. */
export async function setSiteRule(site: string, rule: SiteRule | null, area: KeyValueArea = defaultArea()): Promise<Settings> {
  const current = await getSettings(area);
  const siteRules = {...current.siteRules};
  if (rule) siteRules[site] = rule; else delete siteRules[site];
  return saveSettings({siteRules}, area);
}
