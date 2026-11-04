// Values that never reach the model: passwords, payment cards, one-time codes.
export const MASK = '••••';
const SECRET_AUTOCOMPLETE = /\b(cc-number|cc-csc|cc-exp|one-time-code|current-password|new-password)\b/i;

export function isSecretField(attrs: Record<string, string>): boolean {
  if ((attrs.type ?? '').toLowerCase() === 'password') return true;
  return SECRET_AUTOCOMPLETE.test(attrs.autocomplete ?? '');
}
