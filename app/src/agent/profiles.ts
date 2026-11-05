// The tool catalogue and the two example profiles the assistant starts with.
import type {Profile, ToolName} from '../store/types.ts';

export type ToolGroup = 'read' | 'act' | 'qa';

export const TOOL_CATALOGUE: {name: ToolName; label: string; group: ToolGroup}[] = [
  {name: 'snapshot', label: 'Описание страницы', group: 'read'},
  {name: 'find', label: 'Найти элементы', group: 'read'},
  {name: 'read', label: 'Прочитать текст страницы', group: 'read'},
  {name: 'screenshot', label: 'Скриншот', group: 'read'},
  {name: 'notes_search', label: 'Поиск по заметкам', group: 'read'},
  {name: 'notes_read', label: 'Чтение заметок', group: 'read'},
  {name: 'tabs', label: 'Вкладки', group: 'act'},
  {name: 'navigate', label: 'Переходы', group: 'act'},
  {name: 'click', label: 'Клик', group: 'act'},
  {name: 'hover', label: 'Наведение', group: 'act'},
  {name: 'scroll', label: 'Прокрутка', group: 'act'},
  {name: 'type', label: 'Ввод текста', group: 'act'},
  {name: 'set', label: 'Выбор в списках и флажках', group: 'act'},
  {name: 'press', label: 'Клавиши', group: 'act'},
  {name: 'wait', label: 'Ожидание', group: 'act'},
  {name: 'handle_dialog', label: 'Диалоги страницы', group: 'act'},
  {name: 'highlight', label: 'Подсветка', group: 'act'},
  {name: 'clear_highlights', label: 'Снять подсветку', group: 'act'},
  {name: 'ask_user', label: 'Вопрос пользователю', group: 'act'},
  {name: 'notes_create', label: 'Создать заметку', group: 'act'},
  {name: 'notes_append', label: 'Дописать в заметку', group: 'act'},
  {name: 'done', label: 'Завершить задачу', group: 'act'},
  {name: 'console_log', label: 'Ошибки консоли', group: 'qa'},
  {name: 'network_log', label: 'Упавшие запросы', group: 'qa'},
  {name: 'page_checks', label: 'Проверки страницы', group: 'qa'},
];

const toolsOf = (...groups: ToolGroup[]) => TOOL_CATALOGUE.filter(t => groups.includes(t.group)).map(t => t.name);

export const DEFAULT_PROFILES: Profile[] = [
  {
    id: 'assistant',
    name: 'Помощник',
    prompt: 'Ты помогаешь пользователю с тем, что открыто в браузере, и с его заметками. '
      + 'Отвечаешь на вопросы по странице, находишь нужное на сайтах, кликаешь и выделяешь найденное цветом. '
      + 'Если задача неясна, коротко уточни, что именно нужно.',
    tools: toolsOf('read', 'act'),
    createdAt: 0,
  },
  {
    id: 'qa',
    name: 'QA-тестировщик',
    prompt: 'Ты опытный QA-инженер и ищешь баги на сайте. Работай по порядку:\n'
      + '1. Посмотри страницу (snapshot) и собери факты: console_log, network_log и page_checks (с reload: true, если нужна картина с начала загрузки).\n'
      + '2. Если модель видит изображения — сделай screenshot и проверь вёрстку глазами: наложения, обрезанный текст, пустые места.\n'
      + '3. Пройди по основным разделам сайта (ссылки меню) и повтори проверки на каждой странице.\n'
      + '4. Для каждого бага укажи: страница, шаги воспроизведения, ожидаемый и фактический результат, доказательство (строка из инструмента).\n'
      + '5. В итоговом отчёте перечисли все проблемы, которые показали инструменты — ошибки консоли, упавшие запросы, проблемы из page_checks и со скриншота, — ничего не пропуская.\n'
      + 'Пиши только то, что подтверждено инструментами; предположения отмечай как предположения. Ничего не отправляй и не удаляй ради проверки.',
    tools: toolsOf('read', 'act', 'qa'),
    createdAt: 1,
  },
];

/** Default prompts of earlier versions: a profile still holding one gets the current default (the user never edited it). */
export const LEGACY_PROMPTS: Record<string, string[]> = {
  qa: [
    'Ты опытный QA-инженер и ищешь баги на сайте. Работай по порядку:\n'
          + '1. Посмотри страницу (snapshot) и собери факты: console_log, network_log и page_checks (с reload: true, если нужна картина с начала загрузки).\n'
          + '2. Если модель видит изображения — сделай screenshot и проверь вёрстку глазами: наложения, обрезанный текст, пустые места.\n'
          + '3. Пройди по основным разделам сайта (ссылки меню) и повтори проверки на каждой странице.\n'
          + '4. Для каждого бага укажи: страница, шаги воспроизведения, ожидаемый и фактический результат, доказательство (строка из инструмента).\n'
          + 'Пиши только то, что подтверждено инструментами; предположения отмечай как предположения. Ничего не отправляй и не удаляй ради проверки.',
   'Ты опытный QA-инженер и ищешь баги на сайте. ' + 'Обходи разделы сайта, собирай ошибки консоли и упавшие сетевые запросы, проверяй страницы на битые картинки и ссылки, ' + 'элементы без подписей и проблемы вёрстки. ' + 'Для каждого бага указывай страницу, шаги воспроизведения, ожидаемый и фактический результат. ' + 'Отделяй подтверждённые факты от предположений.'],
};

export const PROFILE_NAME_MAX = 40;
export const PROFILE_PROMPT_MAX = 4000;

/** The error text to show, or null when the profile can be saved. */
export function validateProfile(profile: Pick<Profile, 'name' | 'prompt'>): string | null {
  const name = profile.name.trim();
  if (!name) return 'Введите название профиля';
  if (name.length > PROFILE_NAME_MAX) return `Название не длиннее ${PROFILE_NAME_MAX} символов`;
  if (profile.prompt.length > PROFILE_PROMPT_MAX) return `Промпт не длиннее ${PROFILE_PROMPT_MAX} символов`;
  return null;
}
