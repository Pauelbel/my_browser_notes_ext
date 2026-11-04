// Tiptap wrapper, bundled into vendor/editor.js by build.mjs.
// Owns only its element: the toolbar and table controls live in app.js and call in through this API.
import {Editor} from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import {Markdown} from '@tiptap/markdown';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Image from '@tiptap/extension-image';
import {TableKit} from '@tiptap/extension-table';

const escapeAttribute = value => String(value || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const ResizableImage = Image.extend({
  renderMarkdown(node) {
    const {src = '', alt = '', title = '', width, height} = node.attrs || {};
    // Markdown has no image size syntax: fall back to <img> once resized so the size survives reload and export.
    if (width || height) {
      const size = `${width ? ` width="${Math.round(width)}"` : ''}${height ? ` height="${Math.round(height)}"` : ''}`;
      return `<img src="${escapeAttribute(src)}" alt="${escapeAttribute(alt)}"${size}>`;
    }
    return title ? `![${alt}](${src} "${title}")` : `![${alt}](${src})`;
  },
}).configure({
  allowBase64:true,
  resize:{enabled:true, directions:['bottom-right'], minWidth:80, minHeight:60, alwaysPreserveAspectRatio:true},
});

const commands = {
  bold:chain => chain.toggleBold(),
  italic:chain => chain.toggleItalic(),
  heading:chain => chain.toggleHeading({level:2}),
  bulletList:chain => chain.toggleBulletList(),
  orderedList:chain => chain.toggleOrderedList(),
  taskList:chain => chain.toggleTaskList(),
  blockquote:chain => chain.toggleBlockquote(),
  codeBlock:chain => chain.toggleCodeBlock(),
  clear:chain => chain.unsetAllMarks().clearNodes(),
  undo:chain => chain.undo(),
  redo:chain => chain.redo(),
  addRowAfter:chain => chain.addRowAfter(),
  addColumnAfter:chain => chain.addColumnAfter(),
  deleteRow:chain => chain.deleteRow(),
  deleteColumn:chain => chain.deleteColumn(),
  deleteTable:chain => chain.deleteTable(),
};

export function createEditor(element, {onChange}) {
  const selectionListeners = [];
  const editor = new Editor({
    element,
    extensions:[StarterKit.configure({link:{openOnClick:false}}), Markdown, TaskList, TaskItem.configure({nested:true}),
      ResizableImage, TableKit.configure({table:{resizable:false}})],
    content:'', contentType:'markdown',
    editorProps:{attributes:{'aria-label':'Текст заметки', 'aria-multiline':'true'}},
    onUpdate:() => onChange(),
    onTransaction:() => selectionListeners.forEach(listener => listener()),
  });
  const readImage = file => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  element.addEventListener('paste', event => {
    const file = [...(event.clipboardData?.files || [])].find(item => item.type.startsWith('image/'));
    if (!file || !editor.isEditable) return;
    event.preventDefault();
    readImage(file).then(src => editor.chain().focus().setImage({src}).run(), console.error);
  }, true);

  return {
    getMarkdown:() => editor.getMarkdown(),
    setMarkdown(markdown) {
      editor.commands.setContent(markdown, {contentType:'markdown', emitUpdate:false});
      // A fresh state drops the undo history of the previously shown note.
      editor.view.updateState(editor.state.constructor.create({doc:editor.state.doc, plugins:editor.state.plugins}));
    },
    run:command => commands[command]?.(editor.chain().focus()).run(),
    can:command => Boolean(commands[command]?.(editor.can().chain().focus()).run()),
    isActive:command => command === 'heading' ? editor.isActive('heading', {level:2}) : editor.isActive(command),
    inTable:() => editor.isActive('table'),
    // Screen box of the table cell holding the cursor, for placing the row/column controls.
    cellRect() {
      const position = editor.state.selection.$from;
      for (let depth = position.depth; depth > 0; depth--) {
        if (['tableCell', 'tableHeader'].includes(position.node(depth).type.name)) return editor.view.nodeDOM(position.before(depth))?.getBoundingClientRect() || null;
      }
      return null;
    },
    insertImage:src => editor.chain().focus().setImage({src}).run(),
    insertTable:(rows, cols) => editor.chain().focus().insertTable({rows, cols, withHeaderRow:true}).run(),
    readImage,
    focus:() => editor.commands.focus('end'),
    setEditable:on => editor.setEditable(on, false),
    onSelectionChange:listener => selectionListeners.push(listener),
  };
}
