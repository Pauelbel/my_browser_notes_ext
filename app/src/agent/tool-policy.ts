import type {ToolName} from '../store/types.ts';

/** Tools whose interrupted delivery cannot be assumed safe to retry. */
export const MUTATING_TOOLS = new Set<ToolName>([
  'click', 'hover', 'scroll', 'type', 'set', 'press', 'navigate', 'handle_dialog', 'tabs',
  'highlight', 'clear_highlights', 'notes_create', 'notes_append',
]);

export const isMutatingTool = (name: ToolName): boolean => MUTATING_TOOLS.has(name);
