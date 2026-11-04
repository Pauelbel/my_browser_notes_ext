// Accessibility.getFullAXTree payload types and small helpers.

export interface AXValue { type: string; value?: unknown }
export interface AXProperty { name: string; value: AXValue }

export interface AXNode {
  nodeId: string;
  ignored: boolean;
  role?: AXValue;
  chromeRole?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: AXProperty[];
  parentId?: string;
  childIds?: string[];
  backendDOMNodeId?: number;
  frameId?: string;
}

export const roleOf = (n: AXNode): string => (typeof n.role?.value === 'string' ? n.role.value : '');
export const nameOf = (n: AXNode): string => (typeof n.name?.value === 'string' ? n.name.value : '');

export function valueOf(n: AXNode): string | undefined {
  const v = n.value?.value;
  return v === undefined || v === null ? undefined : String(v);
}

export function property(n: AXNode, name: string): unknown {
  return n.properties?.find(p => p.name === name)?.value.value;
}

/** Collapses whitespace runs and drops private-use glyphs (icon fonts). */
export function cleanText(input: string): string {
  return input.replace(/[-]/g, '').replace(/\s+/g, ' ').trim();
}
