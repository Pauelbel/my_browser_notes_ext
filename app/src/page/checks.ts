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

/** Pairs of controls drawn over each other: the overlap covers more than 30 % of the smaller one. A control inside
 * another (a button in a link, a wrapper with a click handler) is not an overlap. */
export function findOverlaps(items: {ref: string; label: string; box: Box; ancestors?: string[]}[], limit = 10): [string, string][] {
  const pairs: [string, string][] = [];
  for (let i = 0; i < items.length && pairs.length < limit; i++) {
    for (let j = i + 1; j < items.length && pairs.length < limit; j++) {
      if (items[i].ancestors?.includes(items[j].ref) || items[j].ancestors?.includes(items[i].ref)) continue;
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

/** Links whose address says they change something: never requested by the checker, even with HEAD. */
export const DANGEROUS_URL = /(log-?out|sign-?out|exit|delete|remove|destroy|unsubscribe|отпис|выход|удал)/i;

/** A short form of an address for reports: data: URLs by type and size, others cut to 200 characters. */
export function shortUrl(url: string): string {
  if (url.startsWith('data:')) {
    const type = url.slice(5, url.indexOf(';') > 0 ? url.indexOf(';') : url.indexOf(','));
    return `data:${type}… (${Math.max(1, Math.round(url.length * 0.75 / 1024))} КБ)`;
  }
  return url.length > 200 ? `${url.slice(0, 199)}…` : url;
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
    const pageOverflow = document.documentElement.scrollWidth - width;
    const found = [];
    // Elements are listed only when the page itself is wider than the window; a clipped carousel slide is not a bug.
    const clipped = el => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o !== 'visible') return true; } return false; };
    if (pageOverflow > 1) for (const el of document.body ? document.body.querySelectorAll('*') : []) {
      if (found.length >= 10) break;
      const r = el.getBoundingClientRect();
      if (r.right > width + 1 && r.width > 0 && !found.some(f => f.el.contains(el)) && getComputedStyle(el).position !== 'fixed' && !clipped(el)) {
        found.push({el, text: (el.innerText || el.getAttribute('aria-label') || el.tagName.toLowerCase()).replace(/\s+/g, ' ').slice(0, 60), right: Math.round(r.right)});
      }
    }
    return {pageOverflow, width, elements: found.map(({text, right}) => ({text, right}))};
  },
  controls() {
    const sel = 'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=link], [onclick]';
    const els = [...document.querySelectorAll(sel)].slice(0, 300)
      .filter(el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.opacity !== '0'; });
    return els.map(el => {
      const r = el.getBoundingClientRect();
      return {label: (el.innerText || el.value || el.getAttribute('aria-label') || el.tagName.toLowerCase()).replace(/\s+/g, ' ').trim().slice(0, 50),
        box: {x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height},
        ancestors: els.map((other, i) => (other !== el && other.contains(el) ? String(i) : null)).filter(Boolean)};
    });
  },
  sameSiteLinks(limit) {
    const seen = new Map();
    for (const a of document.querySelectorAll('a[href]')) {
      let u; try { u = new URL(a.href, location.href); } catch { continue; }
      if (u.origin !== location.origin || !/^https?:$/.test(u.protocol)) continue;
      u.hash = '';
      if (u.href === location.href.split('#')[0] || seen.has(u.href)) continue;
      const block = a.closest('li, p, div, nav') || a;
      seen.set(u.href, {url: u.href, text: (a.innerText || a.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        nearby: (block.innerText || '').replace(/\s+/g, ' ').slice(0, 120)});
      if (seen.size >= limit) break;
    }
    return [...seen.values()];
  },
  async checkLinks(urls, parallel, timeoutMs, deadlineMs) {
    // Without cookies and without following redirects: a check must not act as the user or wander to other sites.
    const bad = [], skipped = [];
    const deadline = Date.now() + deadlineMs;
    const attempt = async (url, method) => {
      const c = new AbortController(); const t = setTimeout(() => c.abort(), timeoutMs);
      try {
        const r = await fetch(url, {method, redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: c.signal});
        return r.type === 'opaqueredirect' ? 0 : r.status;
      } finally { clearTimeout(t); c.abort(); }
    };
    const one = async url => {
      try {
        let status = await attempt(url, 'HEAD');
        if (status === 405 || status === 501) status = await attempt(url, 'GET');
        if (status === 401 || status === 403) skipped.push({url, why: 'нужен вход'});
        else if (status >= 400) bad.push({url, status});
      } catch (e) { bad.push({url, error: e.name === 'AbortError' ? 'таймаут' : String(e.message || e)}); }
    };
    const queue = [...urls];
    await Promise.all(Array.from({length: parallel}, async () => {
      while (queue.length) { const url = queue.shift(); if (Date.now() > deadline) { skipped.push({url, why: 'время вышло'}); continue; } await one(url); }
    }));
    return {bad, skipped};
  },
`;
