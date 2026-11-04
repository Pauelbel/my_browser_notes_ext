// Ollama's own API: the model list and a connection check with hints people can act on.
// Chat requests go through the OpenAI-compatible address (stream.ts); this file knows nothing about the browser UI.

/** Below this the agent's page descriptions do not fit; Ollama's default is smaller. */
export const MIN_CONTEXT = 16_384;

const ORIGINS_HINT = 'Ollama отклоняет запросы расширения. Запустите её с переменной OLLAMA_ORIGINS=chrome-extension://* и перезапустите.';
const CONTEXT_HINT = `задайте OLLAMA_CONTEXT_LENGTH не меньше ${MIN_CONTEXT} и перезапустите Ollama`;

export type OllamaCheck = {ok: true; models: string[]; warning?: string} | {ok: false; error: string};

class HttpError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) { super(message); this.statusCode = statusCode; }
}

async function getJson(url: string, fetchFn: typeof fetch): Promise<any> {
  const response = await fetchFn(url);
  if (!response.ok) throw new HttpError(response.status, `HTTP ${response.status}`);
  return response.json();
}

export async function listModels(baseUrl: string, fetchFn: typeof fetch = fetch): Promise<string[]> {
  const body = await getJson(`${baseUrl}/api/tags`, fetchFn);
  return (body.models ?? []).map((m: {name: string}) => m.name).sort((a: string, b: string) => a.localeCompare(b));
}

export async function checkOllama(baseUrl: string, model: string, fetchFn: typeof fetch = fetch): Promise<OllamaCheck> {
  let models: string[];
  try {
    models = await listModels(baseUrl, fetchFn);
  } catch (error) {
    return {ok: false, error: describeError(error, baseUrl)};
  }
  if (model && !models.includes(model)) return {ok: true, models, warning: `Модель «${model}» не найдена в Ollama. Выберите другую.`};
  if (model) {
    // /api/ps lists loaded models with the context they actually run with; an unloaded model says nothing yet.
    const running = await getJson(`${baseUrl}/api/ps`, fetchFn).catch(() => null);
    const loaded = running?.models?.find((m: {name: string}) => m.name === model);
    if (loaded?.context_length && loaded.context_length < MIN_CONTEXT) {
      return {ok: true, models, warning: `Модель работает с контекстом ${loaded.context_length} токенов — для агента мало: ${CONTEXT_HINT}.`};
    }
  }
  return {ok: true, models};
}

/** A message for the person: what went wrong and what to do about it. */
export function describeError(error: unknown, baseUrl: string): string {
  const status = error instanceof Response ? error.status
    : typeof (error as {statusCode?: unknown})?.statusCode === 'number' ? (error as {statusCode: number}).statusCode
    : undefined;
  if (status === 403) return ORIGINS_HINT;
  if (status === 404) return 'Модель не найдена в Ollama — проверьте имя модели в настройках.';
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
  if (error instanceof TypeError || /fetch failed|Failed to fetch|ECONNREFUSED|Cannot connect/i.test(`${message} ${cause}`)) {
    return `Нет связи с Ollama по адресу ${baseUrl}. Проверьте, что она запущена и адрес верный.`;
  }
  return message;
}

/** The context window the model runs with: from /api/ps when it is loaded, else a conservative 8192. */
export async function modelContext(baseUrl: string, model: string, fetchFn: typeof fetch = fetch): Promise<number> {
  const running = await getJson(`${baseUrl}/api/ps`, fetchFn).catch(() => null);
  const loaded = running?.models?.find((m: {name: string}) => m.name === model);
  return Number(loaded?.context_length) || 8192;
}
