export const LOCATOR_KINDS = ['xpath', 'css', 'id', 'testid', 'aria', 'name', 'class', 'tag', 'role', 'best'] as const;
export type LocatorKind = typeof LOCATOR_KINDS[number];

/** Derive the requested locator type from the user's words; do not entrust this choice to the model. */
export function detectLocatorIntent(text: string): LocatorKind | null {
  const value = text.toLocaleLowerCase('ru-RU');
  const request = /(?:напиши|дай|найди|покажи|подбери|сгенерируй|составь|получи|нужен|нужна|какой|какая|give|find|write|generate|show|need)|(?:xpath|x[\s_-]*path|css|\bid\b|локатор|селектор|locator|selector)\s+(?:для|кнопк|элемент|пол)/i.test(value);
  if (!request) return null;
  if (/(?:data[\s_-]*test[\s_-]*id|test[\s_-]*id|тест[\s_-]*айди|дата[\s_-]*тест)/i.test(value)) return 'testid';
  if (/(?:xpath|x[\s_-]*path|икс[\s_-]*пат|хпат)/i.test(value)) return 'xpath';
  if (/(?:css[\s_-]*(?:selector|селектор)?|цсс[\s_-]*селектор)/i.test(value)) return 'css';
  if (/(?:\baria\b|aria[\s_-]*label|ариа[\s_-]*(?:метк|селектор))/i.test(value)) return 'aria';
  if (/(?:\bname\b|атрибут\s+name)/i.test(value)) return 'name';
  if (/(?:\bclass(?:name)?\b|класс(?:а|ом)?(?:\s+элемента)?)/i.test(value)) return 'class';
  if (/(?:\btag(?:name)?\b|тег(?:а|ом)?(?:\s+элемента)?)/i.test(value)) return 'tag';
  if (/(?:\brole\b|роль(?:ю|\s+элемента)?)/i.test(value)) return 'role';
  if (/(?:\bid\b|\bайди\b|идентификатор\s+(?:элемента|кнопки|поля|локатор))/i.test(value)) return 'id';
  if (/(?:локатор|селектор|locator|selector)/i.test(value)) return 'best';
  return null;
}

// Unlike page-content markers, these survive pageText() neutralization. lastIndexOf below also prevents a URL or
// other page-derived prefix from shadowing the host-generated answer that is appended last.
const START = '[[[assistant-verified-locator-answer:v1]]]';
const END = '[[[end-assistant-verified-locator-answer:v1]]]';

export function wrapLocatorAnswer(answer: string): string {
  return `${START}\n${answer.trim()}\n${END}`;
}

export function extractLocatorAnswer(text: string): string | null {
  const from = text.lastIndexOf(START);
  if (from < 0) return null;
  const start = from + START.length;
  const to = text.indexOf(END, start);
  return to < 0 ? null : text.slice(start, to).trim();
}

export const locatorKindLabel = (kind: Exclude<LocatorKind, 'best'>): string => ({
  xpath: 'XPath', css: 'CSS', id: 'ID', testid: 'Test ID', aria: 'ARIA', name: 'Name', class: 'Class', tag: 'Tag', role: 'Role',
})[kind];
