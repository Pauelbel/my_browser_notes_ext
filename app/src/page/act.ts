// Element-level helpers for actions: focusing and typing with a check of the value, choosing an option,
// reading a checkbox. They run in the probe's isolated world on the resolved target.
import {PageError} from './errors.ts';
import {insertText, pressKey, click, type DialogInfo} from './input.ts';
import type {Point} from './geometry.ts';
import {callOn, type Target} from './resolve.ts';
import type {PageSession} from './session.ts';

export const isFocused = (session: PageSession, t: Target) => callOn<boolean>(session, t.frame, t.objectId,
  'function () { const f = __assistant.focusInfo(); return f === this || (f && this.contains(f)); }');

export async function focusTarget(session: PageSession, t: Target, point: Point, dialog: Promise<DialogInfo>): Promise<void> {
  await session.cdp.send('DOM.focus', {backendNodeId: t.record.backendNodeId}, t.frame.sessionId).catch(() => {});
  if (await isFocused(session, t)) return;
  await click(session, point, dialog);
  if (!await isFocused(session, t)) throw new PageError('NOT_EDITABLE', `Не удалось поставить курсор в элемент ${t.record.ref}.`, true);
}

export async function typeInto(session: PageSession, t: Target, text: string, clear: boolean, dialog: Promise<DialogInfo>): Promise<void> {
  if (clear) {
    await callOn(session, t.frame, t.objectId, `function () {
      if (typeof this.select === 'function') { this.select(); return; }
      const r = document.createRange(); r.selectNodeContents(this); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    }`);
    if (!text) await pressKey(session, 'Backspace', dialog);
  } else {
    await callOn(session, t.frame, t.objectId, 'function () { if (typeof this.setSelectionRange === "function" && typeof this.value === "string") this.setSelectionRange(this.value.length, this.value.length); }').catch(() => {});
  }
  if (text) await insertText(session, text);
  const value = await callOn<string>(session, t.frame, t.objectId, 'function () { return typeof this.value === "string" ? this.value : this.innerText; }');
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const ok = clear ? norm(value) === norm(text) : norm(value).endsWith(norm(text));
  // The value itself is never put in the message: the field may be secret.
  if (!ok) throw new PageError('VALUE_MISMATCH', `После ввода в элементе ${t.record.ref} оказалось не то значение (страница могла изменить или ограничить ввод).`, true);
}

export async function selectOption(session: PageSession, t: Target, value: string): Promise<string> {
  const r = await callOn<{ok: boolean; text?: string; options?: string[]}>(session, t.frame, t.objectId, `function (v) {
    const opts = [...this.options]; const want = String(v).trim().toLowerCase();
    const o = opts.find(o => o.text.trim().toLowerCase() === want) || opts.find(o => o.value.toLowerCase() === want)
      || opts.find(o => o.text.trim().toLowerCase().includes(want));
    if (!o) return {ok: false, options: opts.map(o => o.text.trim())};
    this.value = o.value;
    this.dispatchEvent(new Event('input', {bubbles: true}));
    this.dispatchEvent(new Event('change', {bubbles: true}));
    return {ok: true, text: o.text.trim()};
  }`, [{value}]);
  if (!r.ok) throw new PageError('NOT_FOUND', `В списке ${t.record.ref} нет варианта «${value}». Есть: ${r.options!.slice(0, 30).join(', ')}.`);
  return r.text!;
}

export const isChecked = (session: PageSession, t: Target) => callOn<boolean>(session, t.frame, t.objectId,
  'function () { const c = this.control || this; return typeof c.checked === "boolean" ? c.checked : c.getAttribute("aria-checked") === "true"; }');

/** The facts the classifier needs about a target: what it is, whether it submits a form, what is written around it. */
export const targetFacts = (session: PageSession, t: Target) => callOn<{tag: string; type: string; inForm: boolean; formHasPassword: boolean;
  attrs: Record<string, string>; nearby: string; href: string}>(session, t.frame, t.objectId, `function () {
    const el = this.nodeType === 1 ? this : this.parentElement;
    const control = el.control || el;
    const form = control.form || el.closest('form');
    const block = el.closest('form, section, article, li, tr, p, div') || el;
    return {tag: control.tagName.toLowerCase(), type: (control.getAttribute('type') || '').toLowerCase(), inForm: Boolean(form),
      formHasPassword: Boolean(form && form.querySelector('input[type=password]')),
      attrs: {type: control.getAttribute('type') || '', autocomplete: control.getAttribute('autocomplete') || ''},
      nearby: (block.innerText || '').replace(/\s+/g, ' ').slice(0, 200), href: (el.closest('a') || {}).href || ''};
  }`);

export const isSelect = (session: PageSession, t: Target) => callOn<boolean>(session, t.frame, t.objectId, 'function () { return this.tagName === "SELECT"; }');
