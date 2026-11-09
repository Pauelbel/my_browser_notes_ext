// Machine-readable outcome of a page action. It deliberately separates delivery, observed reaction and the
// requested end state: repeating a delivered action can be harmful, while a DOM mutation alone is not proof that
// the user's goal was reached.

export type EffectVerdict = 'changed' | 'unattributable' | 'none';
export type PostconditionVerdict = 'met' | 'unmet' | 'not_checked';
export type PageChange = 'none' | 'diff' | 'full';

export interface Expectation {
  /** The current address must contain this value. */
  url?: string;
  /** Visible/accessibility text that must be present. */
  text?: string;
  /** Visible/accessibility text that must be absent. */
  textGone?: string;
  /** A ref whose state/value is checked. Defaults to the action target when omitted. */
  ref?: string;
  gone?: boolean;
  value?: string;
  checked?: boolean;
}

export interface SemanticTarget {
  role: string;
  name: string;
  /** One-based occurrence when several exact matches are intentionally present. */
  nth?: number;
  /** Limit matching to the subtree of this already observed ref. */
  within?: string;
}

export interface ActionReceipt {
  action: string;
  target?: string;
  dispatched: boolean | 'unknown';
  /** Sending/deleting/submitting/etc.; success requires an explicit postcondition or a later observation. */
  consequential?: boolean;
  effect: {verdict: EffectVerdict; signals: string[]};
  postcondition: {verdict: PostconditionVerdict; details?: string};
  page: {revision: number; url: string; changed: PageChange};
}

/** Stable one-line form for the model and the saved history; page-derived details stay outside it. */
export function renderReceipt(receipt: ActionReceipt): string {
  const post = receipt.postcondition.details ? `:${receipt.postcondition.details.replace(/\s+/g, ' ').slice(0, 160)}` : '';
  return `[action-receipt dispatched=${receipt.dispatched} consequential=${Boolean(receipt.consequential)} effect=${receipt.effect.verdict}`
    + ` postcondition=${receipt.postcondition.verdict}${post} page.rev=${receipt.page.revision}`
    + ` changed=${receipt.page.changed}]`;
}
