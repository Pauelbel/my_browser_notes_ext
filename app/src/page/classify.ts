// What an action will do, from the target's accessible name and structural facts: deterministic, Russian and English.
// The vocabulary errs toward inclusion: a false positive costs one question, a false negative an irreversible action.
export type Category = 'pay' | 'access' | 'secret' | 'delete' | 'logout' | 'send' | 'submit';

/** Categories that are the user's own step: the agent prepares everything around them but never does them. */
export const USER_STEP: ReadonlySet<Category> = new Set<Category>(['pay', 'access', 'secret']);

export interface ActionFacts {
  /** activate: a click or Enter/Space on a control; enter: Enter in a field; type: typing text. */
  action: 'activate' | 'enter' | 'type';
  role: string;
  name: string;
  tag: string;
  type: string;
  inForm: boolean;
  formHasPassword: boolean;
  secretField: boolean;
  /** Text around the target (its block), for amounts next to a generic "confirm". */
  nearbyText: string;
}

/** Whole words or word stems (a trailing * takes any ending), not inside other words; Cyrillic-aware. */
function vocabulary(words: string[]): RegExp {
  const parts = words.map(w => w.endsWith('*') ? `${w.slice(0, -1).replace(/\s+/g, '\\s+')}\\p{L}*` : w.replace(/\s+/g, '\\s+'));
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${parts.join('|')})(?![\\p{L}\\p{N}])`, 'iu');
}

const PAY = vocabulary(['оплат*', 'купить', 'заказать', 'оформить заказ', 'перейти к оплате', 'подписаться', 'пожертвовать', 'перевести деньги',
  'пополнить', 'pay', 'payment', 'buy', 'buy now', 'purchase', 'checkout', 'check out', 'place order', 'subscribe', 'donate', 'top up']);
const ACCESS = vocabulary(['разрешить доступ', 'предоставить доступ', 'авторизовать', 'authorize', 'allow access', 'grant access', 'connect account']);
const DELETE = vocabulary(['удал*', 'стереть', 'очистить всё', 'очистить все', 'delete', 'remove', 'erase', 'destroy']);
const LOGOUT = vocabulary(['выйти', 'выход', 'log out', 'logout', 'sign out']);
const SEND = vocabulary(['отправить', 'опубликовать', 'send', 'post', 'publish', 'reply']);
const GENERIC_CONFIRM = vocabulary(['подтвердить', 'продолжить', 'confirm', 'continue']);
const MONEY = /\d[\d\s.,]*\s*(₽|руб|\$|€|usd|eur)/iu;

const fold = (s: string) => s.replace(/ё/gi, 'е');

export function classify(f: ActionFacts): Category | null {
  if (f.action === 'type') return f.secretField ? 'secret' : null;
  const name = fold(f.name);
  if (PAY.test(name) || (GENERIC_CONFIRM.test(name) && (MONEY.test(name) || MONEY.test(f.nearbyText)))) return 'pay';
  if (MONEY.test(name) && f.action === 'activate' && ['button', 'link', 'clickable'].includes(f.role)) return 'pay';
  if (ACCESS.test(name)) return 'access';
  if (DELETE.test(name)) return 'delete';
  if (LOGOUT.test(name)) return 'logout';
  if (SEND.test(name)) return 'send';
  const submits = f.action === 'activate'
    ? f.inForm && (f.type === 'submit' || f.type === 'image' || (f.tag === 'button' && f.type === ''))
    : f.inForm;
  return submits ? 'submit' : null;
}
