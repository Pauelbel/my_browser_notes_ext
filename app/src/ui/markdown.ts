// Model replies as HTML: Markdown through marked, then DOMPurify, since the text comes from a model and may echo pages.
// Only a Markdown subset survives: no styles, forms or frames (a reply must not restyle or cover the panel),
// and no images from the network (rendering one would send a request to a third party).
import {marked} from 'marked';
import createDOMPurify, {type DOMPurify} from 'dompurify';

const FORBID_TAGS = ['style', 'form', 'input', 'button', 'textarea', 'select', 'option', 'iframe', 'frame', 'object', 'embed', 'link', 'meta', 'base'];
const LOCAL_SOURCE = /^(data|blob):/i;

let purifier: DOMPurify | null = null;

function purify(): DOMPurify {
  if (purifier) return purifier;
  purifier = createDOMPurify(window as unknown as Window & typeof globalThis);
  purifier.addHook('uponSanitizeAttribute', (_node, data) => {
    if (data.attrName === 'src' && !LOCAL_SOURCE.test(data.attrValue.trim())) data.keepAttr = false;
  });
  purifier.addHook('afterSanitizeAttributes', node => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
    if (node.tagName === 'IMG' && !node.hasAttribute('src')) node.remove();
  });
  return purifier;
}

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, {gfm: true, breaks: true, async: false});
  return purify().sanitize(html, {FORBID_TAGS, FORBID_ATTR: ['style', 'srcset']});
}
