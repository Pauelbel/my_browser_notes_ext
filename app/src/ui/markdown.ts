// Model replies as HTML: Markdown through marked, then DOMPurify, since the text comes from a model and may echo pages.
import {marked} from 'marked';
import DOMPurify from 'dompurify';

DOMPurify.addHook('afterSanitizeAttributes', node => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, {gfm: true, breaks: true, async: false});
  return DOMPurify.sanitize(html);
}
