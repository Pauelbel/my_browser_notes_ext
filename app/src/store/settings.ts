// Settings live under one key in chrome.storage.local, so the worker and every panel read the same values.
import type {Settings} from './types.ts';

export type KeyValueArea = Pick<chrome.storage.StorageArea, 'get' | 'set'>;

export const DEFAULT_SETTINGS: Settings = {ollamaUrl: 'http://localhost:11434', model: ''};
const KEY = 'settings';

/** Accepts what people type: no scheme, trailing slashes, the /v1 suffix of the OpenAI-compatible address. */
export function normalizeOllamaUrl(input: string): string {
  let url = input.trim();
  if (!url) return DEFAULT_SETTINGS.ollamaUrl;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;
  url = url.replace(/\/+$/, '').replace(/\/v1$/, '').replace(/\/+$/, '');
  return url;
}

const defaultArea = (): KeyValueArea => chrome.storage.local;

export async function getSettings(area: KeyValueArea = defaultArea()): Promise<Settings> {
  const stored = (await area.get(KEY))[KEY] as Partial<Settings> | undefined;
  return {...DEFAULT_SETTINGS, ...stored};
}

export async function saveSettings(patch: Partial<Settings>, area: KeyValueArea = defaultArea()): Promise<Settings> {
  const next = {...await getSettings(area), ...patch};
  next.ollamaUrl = normalizeOllamaUrl(next.ollamaUrl);
  await area.set({[KEY]: next});
  return next;
}
