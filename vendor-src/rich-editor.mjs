// Source of vendor/rich-editor.js (build: npm run build:vendor).
// A WYSIWYG Markdown editor for notes, the same stack Orca uses: TipTap 3 (ProseMirror) + @tiptap/markdown.
// The app has no bundler, so this file is bundled into one IIFE that sets window.RichMarkdownEditor,
// and workbench-tools.js loads it the first time a note opens.
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import Placeholder from '@tiptap/extension-placeholder';
import { TaskList, TaskItem } from '@tiptap/extension-list';

// Toolbar actions by name, so the page script stays free of TipTap details.
const actions = {
  paragraph: chain => chain.setParagraph(),
  h1: chain => chain.toggleHeading({ level: 1 }),
  h2: chain => chain.toggleHeading({ level: 2 }),
  h3: chain => chain.toggleHeading({ level: 3 }),
  bold: chain => chain.toggleBold(),
  italic: chain => chain.toggleItalic(),
  strike: chain => chain.toggleStrike(),
  code: chain => chain.toggleCode(),
  bulletList: chain => chain.toggleBulletList(),
  orderedList: chain => chain.toggleOrderedList(),
  taskList: chain => chain.toggleTaskList(),
  blockquote: chain => chain.toggleBlockquote(),
  codeBlock: chain => chain.toggleCodeBlock(),
  rule: chain => chain.setHorizontalRule()
};
const activeChecks = {
  paragraph: editor => editor.isActive('paragraph'),
  h1: editor => editor.isActive('heading', { level: 1 }),
  h2: editor => editor.isActive('heading', { level: 2 }),
  h3: editor => editor.isActive('heading', { level: 3 }),
  bold: editor => editor.isActive('bold'),
  italic: editor => editor.isActive('italic'),
  strike: editor => editor.isActive('strike'),
  code: editor => editor.isActive('code'),
  bulletList: editor => editor.isActive('bulletList'),
  orderedList: editor => editor.isActive('orderedList'),
  taskList: editor => editor.isActive('taskList'),
  blockquote: editor => editor.isActive('blockquote'),
  codeBlock: editor => editor.isActive('codeBlock')
};

function create({ element, markdown = '', placeholder = '', onChange, onSelection }) {
  const editor = new Editor({
    element,
    extensions: [
      // Links never navigate the app window on click; they are edited as text.
      StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder }),
      Markdown
    ],
    content: markdown,
    contentType: 'markdown',
    editorProps: { attributes: { class: 'rich-markdown chat-message', spellcheck: 'false' } },
    onUpdate: () => onChange?.(editor.getMarkdown()),
    onSelectionUpdate: () => onSelection?.(),
    onTransaction: () => onSelection?.()
  });
  return {
    getMarkdown: () => editor.getMarkdown(),
    setMarkdown: text => editor.commands.setContent(text, { contentType: 'markdown', emitUpdate: false }),
    run: name => actions[name]?.(editor.chain().focus()).run(),
    isActive: name => activeChecks[name]?.(editor) ?? false,
    setLink: href => {
      const chain = editor.chain().focus().extendMarkRange('link');
      (href ? chain.setLink({ href }) : chain.unsetLink()).run();
    },
    linkHref: () => editor.getAttributes('link').href ?? '',
    focus: () => editor.commands.focus(),
    destroy: () => editor.destroy()
  };
}

window.RichMarkdownEditor = { create };
