import type {LocatorKind} from '../agent/locator-intent.ts';

// DOM facts and selectors for one resolved element. The function is serialized and executed in the element's
// frame, so it deliberately has no references to module-level helpers.
export type ConcreteLocatorKind = Exclude<LocatorKind, 'best'>;
export type LocatorStability = 'high' | 'medium' | 'low';

export interface LocatorCandidate {
  kind: ConcreteLocatorKind;
  value: string;
  /** DOM.performSearch query used to prove uniqueness and identity. */
  query: string;
  stability: LocatorStability;
}

export interface LocatorInfo {
  tag: string;
  attributes: Record<string, string>;
  text: string;
  css: string;
  xpath: string | null;
  scope: 'document' | 'shadow-root';
  candidates: LocatorCandidate[];
}

export function inspectLocator(this: Element): LocatorInfo {
  const element = this;
  const root = element.getRootNode() as Document | ShadowRoot;
  const tag = element.localName.toLowerCase();
  const useful = ['id', 'data-testid', 'data-test', 'data-qa', 'aria-label', 'name', 'role', 'class', 'title', 'type'];
  const attributes: Record<string, string> = {};
  for (const name of useful) {
    const value = element.getAttribute(name);
    if (value) attributes[name] = value;
  }
  const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const cssValue = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ')}"`;
  const cssId = (value: string) => value.replace(/(^-?\d)|[^a-zA-Z0-9_-]/g, char => `\\${char.codePointAt(0)!.toString(16)} `);
  const selectsOnly = (selector: string, node: Element) => {
    try { const found = root.querySelectorAll(selector); return found.length === 1 && found[0] === node; } catch { return false; }
  };
  const uniqueCss = (selector: string) => {
    return selectsOnly(selector, element);
  };
  const looksGenerated = (value: string) => value.length > 72
    || /(?:^|[-_])(?:\d{5,}|[a-f0-9]{12,})(?:$|[-_])/i.test(value)
    || /^(?:ember|react|vue|radix|headlessui|:r)[-_:.]?\d/i.test(value);
  const stableId = attributes.id && !looksGenerated(attributes.id) ? `#${cssId(attributes.id)}` : '';
  const cssCandidates = [
    ...['data-testid', 'data-test', 'data-qa'].filter(name => attributes[name]).map(name => `${tag}[${name}=${cssValue(attributes[name])}]`),
    stableId,
    ...['aria-label', 'name', 'title', 'type'].filter(name => attributes[name]).map(name => `${tag}[${name}=${cssValue(attributes[name])}]`),
    attributes.id && !stableId ? `#${cssId(attributes.id)}` : '',
  ].filter(Boolean);
  let css = cssCandidates.find(uniqueCss) ?? '';
  if (!css) {
    const leaves = ['data-testid', 'data-test', 'data-qa', 'aria-label', 'name', 'title', 'type']
      .filter(name => attributes[name]).map(name => `${tag}[${name}=${cssValue(attributes[name])}]`);
    let ancestor = element.parentElement;
    while (ancestor && !css) {
      const currentAncestor = ancestor;
      const ancestorTag = ancestor.localName.toLowerCase();
      const anchors: string[] = [];
      const ancestorId = ancestor.getAttribute('id');
      if (ancestorId) anchors.push(`#${cssId(ancestorId)}`);
      for (const name of ['data-testid', 'data-test', 'data-qa', 'aria-label', 'name']) {
        const value = ancestor.getAttribute(name);
        if (value) anchors.push(`${ancestorTag}[${name}=${cssValue(value)}]`);
      }
      anchors.push(ancestorTag);
      for (const anchor of anchors.filter(candidate => selectsOnly(candidate, currentAncestor))) {
        css = leaves.map(leaf => `${anchor} ${leaf}`).find(uniqueCss) ?? '';
        if (css) break;
      }
      ancestor = ancestor.parentElement;
    }
  }
  if (!css) {
    const parts: string[] = [];
    let current: Element | null = element;
    while (current) {
      const currentTag = current.localName.toLowerCase();
      const currentName = current.localName;
      const parent: Element | null = current.parentElement;
      if (!parent) { parts.unshift(currentTag); break; }
      const same = Array.from(parent.children).filter((child: Element) => child.localName === currentName);
      parts.unshift(`${currentTag}:nth-of-type(${same.indexOf(current) + 1})`);
      const trial = parts.join(' > ');
      if (uniqueCss(trial)) break;
      current = parent;
    }
    css = parts.join(' > ');
  }

  let xpath: string | null = null;
  if (root.nodeType === 9) {
    const doc = root as Document;
    const literal = (value: string) => {
      if (!value.includes("'")) return `'${value}'`;
      if (!value.includes('"')) return `"${value}"`;
      return `concat(${value.split("'").map(part => `'${part}'`).join(`, "'", `)})`;
    };
    const uniqueXpath = (candidate: string) => {
      try {
        const result = doc.evaluate(candidate, doc, null, doc.defaultView!.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        return result.snapshotLength === 1 && result.snapshotItem(0) === element;
      } catch { return false; }
    };
    const xpathCandidates: string[] = [];
    for (const name of ['data-testid', 'data-test', 'data-qa']) if (attributes[name]) xpathCandidates.push(`//${tag}[@${name}=${literal(attributes[name])}]`);
    if (attributes.id && !looksGenerated(attributes.id)) xpathCandidates.push(`//*[@id=${literal(attributes.id)}]`);
    for (const name of ['aria-label', 'name', 'title', 'type']) if (attributes[name]) xpathCandidates.push(`//${tag}[@${name}=${literal(attributes[name])}]`);
    let ancestor = element.parentElement;
    const leaves = ['data-testid', 'data-test', 'data-qa', 'aria-label', 'name', 'title', 'type']
      .filter(name => attributes[name]).map(name => `${tag}[@${name}=${literal(attributes[name])}]`);
    while (ancestor) {
      const ancestorTag = ancestor.localName.toLowerCase();
      const anchors: string[] = [];
      const ancestorId = ancestor.getAttribute('id');
      if (ancestorId) anchors.push(`//*[@id=${literal(ancestorId)}]`);
      for (const name of ['data-testid', 'data-test', 'data-qa', 'aria-label', 'name']) {
        const value = ancestor.getAttribute(name);
        if (value) anchors.push(`//${ancestorTag}[@${name}=${literal(value)}]`);
      }
      anchors.push(`//${ancestorTag}`);
      for (const anchor of anchors) {
        for (const leaf of leaves) xpathCandidates.push(`${anchor}//${leaf}`);
      }
      ancestor = ancestor.parentElement;
    }
    if (text && text.length <= 160) xpathCandidates.push(`//${tag}[normalize-space(.)=${literal(text)}]`);
    if (attributes.id && looksGenerated(attributes.id)) xpathCandidates.push(`//*[@id=${literal(attributes.id)}]`);
    xpath = xpathCandidates.find(uniqueXpath) ?? null;
    if (!xpath) {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current) {
        const currentName = current.localName;
        const parent: Element | null = current.parentElement;
        const siblings = parent ? Array.from(parent.children).filter((child: Element) => child.localName === currentName) : [current];
        parts.unshift(`${current.localName.toLowerCase()}[${siblings.indexOf(current) + 1}]`);
        current = parent;
      }
      const absolute = `/${parts.join('/')}`;
      if (uniqueXpath(absolute)) xpath = absolute;
    }
  }
  const candidates: LocatorCandidate[] = [];
  if (attributes.id) {
    const query = `#${cssId(attributes.id)}`;
    if (uniqueCss(query)) candidates.push({kind: 'id', value: attributes.id, query, stability: looksGenerated(attributes.id) ? 'low' : 'high'});
  }
  for (const name of ['data-testid', 'data-test', 'data-qa']) if (attributes[name]) {
    const query = `${tag}[${name}=${cssValue(attributes[name])}]`;
    if (uniqueCss(query)) candidates.push({kind: 'testid', value: query, query, stability: 'high'});
  }
  if (attributes['aria-label']) {
    const query = `${tag}[aria-label=${cssValue(attributes['aria-label'])}]`;
    if (uniqueCss(query)) candidates.push({kind: 'aria', value: query, query, stability: 'medium'});
  }
  if (attributes.name) {
    const query = `${tag}[name=${cssValue(attributes.name)}]`;
    if (uniqueCss(query)) candidates.push({kind: 'name', value: query, query, stability: 'medium'});
  }
  if (attributes.role) {
    const query = `${tag}[role=${cssValue(attributes.role)}]`;
    if (uniqueCss(query)) candidates.push({kind: 'role', value: query, query, stability: 'medium'});
  }
  for (const name of Array.from(element.classList)) {
    const query = `.${cssId(name)}`;
    if (uniqueCss(query)) {
      candidates.push({kind: 'class', value: query, query, stability: looksGenerated(name) ? 'low' : 'medium'});
      break;
    }
  }
  if (uniqueCss(tag)) candidates.push({kind: 'tag', value: tag, query: tag, stability: 'medium'});
  if (css) candidates.push({kind: 'css', value: css, query: css, stability: css.includes(':nth-of-type') ? 'low' : 'high'});
  if (xpath && root.nodeType === 9) candidates.push({kind: 'xpath', value: xpath, query: xpath,
    stability: xpath.startsWith('/html[') || /^\/(?:[^/]+\[\d+\]\/)+/.test(xpath) ? 'low' : 'high'});
  return {tag, attributes, text, css, xpath, scope: root.nodeType === 9 ? 'document' : 'shadow-root', candidates};
}

export const locatorFunction = `function () { return (${inspectLocator.toString()}).call(this); }`;

/**
 * Verifies a selector through CDP's DOM search, the same backend used by browser tooling. Local querySelector/XPath
 * validation alone is insufficient for a locator that the user will paste into the top-level DevTools search.
 */
export async function verifyCdpLocator(
  send: <T>(method: string, params?: object, sessionId?: string) => Promise<T>,
  query: string,
  backendNodeId: number,
  sessionId?: string,
): Promise<boolean> {
  let searchId = '';
  try {
    // Search result nodeIds are only bound to the frontend DOM tree after its root has been requested.
    await send('DOM.getDocument', {depth: 0, pierce: true}, sessionId);
    const found = await send<{searchId: string; resultCount: number}>('DOM.performSearch',
      {query, includeUserAgentShadowDOM: true}, sessionId);
    searchId = found.searchId;
    if (found.resultCount !== 1) return false;
    const result = await send<{nodeIds: number[]}>('DOM.getSearchResults', {searchId, fromIndex: 0, toIndex: 1}, sessionId);
    if (result.nodeIds.length !== 1) return false;
    const described = await send<{node: {backendNodeId: number}}>('DOM.describeNode', {nodeId: result.nodeIds[0]}, sessionId);
    return described.node.backendNodeId === backendNodeId;
  } catch {
    return false;
  } finally {
    if (searchId) await send('DOM.discardSearchResults', {searchId}, sessionId).catch(() => {});
  }
}
