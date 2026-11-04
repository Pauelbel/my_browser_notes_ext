// How much the agent may do on its own: the chat's mode and the user's per-site rules (as nanobrowser has them).
export type PermissionMode = 'ask' | 'auto';
export type SiteRule = 'allow' | 'ask' | 'block';

export {siteOf} from '../page/index.ts';

export function decideWrite(mode: PermissionMode, rule: SiteRule | undefined): 'allow' | 'ask' | 'block' {
  if (rule === 'block') return 'block';
  if (rule === 'allow') return 'allow';
  if (rule === 'ask') return 'ask';
  return mode === 'auto' ? 'allow' : 'ask';
}
