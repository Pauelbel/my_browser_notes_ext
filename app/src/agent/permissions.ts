// How much the agent may do on its own: the chat's mode and the user's per-site rules (as nanobrowser has them).
import type {PermissionMode, SiteRule} from '../store/types.ts';
export type {PermissionMode, SiteRule};

export {siteOf} from '../page/index.ts';

export function decideWrite(mode: PermissionMode, rule: SiteRule | undefined): 'allow' | 'ask' | 'block' {
  if (rule === 'block') return 'block';
  if (rule === 'allow') return 'allow';
  if (rule === 'ask') return 'ask';
  return mode === 'auto' ? 'allow' : 'ask';
}

/** The rule for a host: its own, or the nearest parent domain's (a rule for bank.ru covers online.bank.ru). */
export function ruleFor(rules: Record<string, SiteRule>, host: string): SiteRule | undefined {
  let best: string | undefined;
  for (const site of Object.keys(rules)) {
    if ((host === site || host.endsWith(`.${site}`)) && (!best || site.length > best.length)) best = site;
  }
  return best ? rules[best] : undefined;
}
