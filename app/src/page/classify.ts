// What an action will do, from the target's accessible name and structural facts: deterministic, Russian and English.
// The vocabulary errs toward inclusion: a false positive costs one question, a false negative an irreversible action.
export type Category = 'pay' | 'access' | 'secret' | 'captcha' | 'delete' | 'logout' | 'send' | 'submit';

/** Categories that are the user's own step: the agent prepares everything around them but never does them. */
export const USER_STEP: ReadonlySet<Category> = new Set<Category>(['pay', 'access', 'secret', 'captcha']);

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
  /** A contenteditable element (chat and comment boxes are often not form fields). */
  contentEditable?: boolean;
}

/** Whole words or word stems (a trailing * takes any ending), not inside other words; Cyrillic-aware. */
function vocabulary(words: string[]): RegExp {
  const parts = words.map(w => w.endsWith('*') ? `${w.slice(0, -1).replace(/\s+/g, '\\s+')}\\p{L}*` : w.replace(/\s+/g, '\\s+'));
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${parts.join('|')})(?![\\p{L}\\p{N}])`, 'iu');
}

const PAY = vocabulary(['оплат*', 'купить', 'заказать', 'оформить заказ', 'перейти к оплате', 'подписаться', 'пожертвовать', 'перевести деньги',
  'пополнить', 'pay', 'payment', 'buy', 'buy now', 'purchase', 'checkout', 'check out', 'place order', 'subscribe', 'donate', 'top up']);
const ACCESS = vocabulary(['разрешить', 'разрешить доступ', 'предоставить доступ', 'предоставить', 'авторизовать', 'authorize', 'allow', 'allow access', 'grant', 'grant access', 'connect account']);
/** Field names that ask for a secret even without type=password or autocomplete. */
const SECRET_FIELD = vocabulary(['пароль', 'password', 'номер карты', 'карта', 'card number', 'cvv', 'cvc', 'код из смс', 'код из sms', 'код подтверждения', 'одноразовый код', 'sms code', 'verification code', 'pin', 'пин', 'пин-код']);
const CAPTCHA = vocabulary(['не робот', 'не являюсь роботом', 'not a robot', 'captcha', 'капча', 'recaptcha', 'hcaptcha']);
const DELETE = vocabulary(['удал*', 'стереть', 'очистить всё', 'очистить все', 'delete', 'remove', 'erase', 'destroy']);
const LOGOUT = vocabulary(['выйти', 'выход', 'log out', 'logout', 'sign out']);
const SEND = vocabulary(['отправить', 'опубликовать', 'send', 'post', 'publish', 'reply']);
const GENERIC_CONFIRM = vocabulary(['подтвердить', 'продолжить', 'confirm', 'continue']);
const MONEY = /\d[\d\s.,]*\s*(₽|руб|\$|€|usd|eur)|(₽|\$|€)\s*\d/iu;

const fold = (s: string) => s.replace(/ё/gi, 'е');

export function classify(f: ActionFacts): Category | null {
  const name = fold(f.name);
  if (f.action === 'type') return f.secretField || SECRET_FIELD.test(name) ? 'secret' : null;
  if (CAPTCHA.test(name)) return 'captcha';
  if (PAY.test(name) || (GENERIC_CONFIRM.test(name) && (MONEY.test(name) || MONEY.test(f.nearbyText)))) return 'pay';
  if (MONEY.test(name) && f.action === 'activate' && ['button', 'link', 'clickable'].includes(f.role)) return 'pay';
  if (ACCESS.test(name)) return 'access';
  if (DELETE.test(name)) return 'delete';
  if (LOGOUT.test(name)) return 'logout';
  if (SEND.test(name)) return 'send';
  if (f.action === 'enter' && !f.inForm && (f.tag === 'textarea' || f.contentEditable)) return 'send';
  const submits = f.action === 'activate'
    ? f.inForm && (f.type === 'submit' || f.type === 'image' || (f.tag === 'button' && f.type === ''))
    : f.inForm;
  return submits ? 'submit' : null;
}
