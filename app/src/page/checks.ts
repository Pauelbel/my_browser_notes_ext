// Page checks for finding bugs: what the probe measures in the page, and the pure parts that judge it.
import type {ONode} from './outline.ts';
import type {Box} from './layout.ts';

export function findUnnamed(roots: ONode[]): ONode[] {
  const out: ONode[] = [];
  const walk = (nodes: ONode[]) => { for (const n of nodes) { if (n.interactive && !n.name.trim() && n.role !== 'clickable') out.push(n); walk(n.children); } };
  walk(roots);
  return out;
}

const area = (b: Box) => Math.max(0, b.width) * Math.max(0, b.height);

/** Pairs of controls drawn over each other: the overlap covers more than 30 % of the smaller one. */
export function findOverlaps(items: {ref: string; label: string; box: Box}[], limit = 10): [string, string][] {
  const pairs: [string, string][] = [];
  for (let i = 0; i < items.length && pairs.length < limit; i++) {
    for (let j = i + 1; j < items.length && pairs.length < limit; j++) {
      const a = items[i].box, b = items[j].box;
      const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (w <= 0 || h <= 0) continue;
      const smaller = Math.min(area(a), area(b));
      if (smaller > 0 && (w * h) / smaller > 0.3) pairs.push([items[i].ref, items[j].ref]);
    }
  }
  return pairs;
}

/** Probe functions, added to the isolated world's __assistant object. */
export const CHECKS_SOURCE = `
  brokenImages() {
    return [...document.images].filter(i => i.getClientRects().length && i.complete && i.naturalWidth === 0)
      .slice(0, 20).map(i => ({src: i.currentSrc || i.src, alt: i.getAttribute('alt') || ''}));
  },
  imagesWithoutAlt() {
    return [...document.images].filter(i => i.getClientRects().length && !i.hasAttribute('alt')).slice(0, 20).map(i => i.currentSrc || i.src);
  },
  overflow() {
    const width = document.documentElement.clientWidth;
    const found = [];
    for (const el of document.body ? document.body.querySelectorAll('*') : []) {
      if (found.length >= 10) break;
      const r = el.getBoundingClientRect();
      if (r.right > width + 1 && r.width > 0 && !found.some(f => f.el.contains(el)) && getComputedStyle(el).position !== 'fixed') {
        found.push({el, text: (el.innerText || el.getAttribute('aria-label') || el.tagName.toLowerCase()).replace(/\\\\s+/g, ' ').slice(0, 60), right: Math.round(r.right)});
      }
    }
    return {pageOverflow: document.documentElement.scrollWidth - width, width, elements: found.map(({text, right}) => ({text, right}))};
  },
  controls() {
    const sel = 'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=link], [onclick]';
    return [...document.querySelectorAll(sel)].slice(0, 300).map(el => ({el, r: el.getBoundingClientRect()}))
      .filter(({el, r}) => r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden')
      .map(({el, r}) => ({label: (el.innerText || el.value || el.getAttribute('aria-label') || el.tagName.toLowerCase()).replace(/\\\\s+/g, ' ').trim().slice(0, 50),
        box: {x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height}}));
  },
  sameSiteLinks(limit) {
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      const u = new URL(a.href, location.href);
      if (u.origin !== location.origin || !/^https?:$/.test(u.protocol)) continue;
      u.hash = '';
      if (u.href !== location.href.split('#')[0]) seen.add(u.href);
      if (seen.size >= limit) break;
    }
    return [...seen];
  },
  async checkLinks(urls, parallel, timeoutMs) {
    const bad = [];
    const one = async url => {
      const attempt = async method => {
        const c = new AbortController(); const t = setTimeout(() => c.abort(), timeoutMs);
        try { return (await fetch(url, {method, redirect: 'follow', signal: c.signal, credentials: 'same-origin'})).status; } finally { clearTimeout(t); }
      };
      try {
        let status = await attempt('HEAD');
        if (status === 405 || status === 501) status = await attempt('GET');
        if (status >= 400) bad.push({url, status});
      } catch (e) { bad.push({url, error: e.name === 'AbortError' ? 'таймаут' : String(e.message || e)}); }
    };
    const queue = [...urls];
    await Promise.all(Array.from({length: parallel}, async () => { while (queue.length) await one(queue.shift()); }));
    return bad;
  },
`;
