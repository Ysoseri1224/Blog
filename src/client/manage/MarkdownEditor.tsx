import { defaultKeymap, history, historyKeymap, indentLess, indentMore, indentWithTab, redo, selectParentSyntax, undo } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { openSearchPanel, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, type Range } from '@codemirror/state';
import { Decoration, EditorView, keymap, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

export interface MarkdownEditorHandle {
  wrapSelection(before: string, after?: string): void;
  prefixLine(prefix: string): void;
  insert(text: string): void;
  indent(more: boolean): void;
  undo(): void;
  redo(): void;
  openSearch(replace?: boolean): void;
  selectStructure(): void;
  focus(): void;
}

interface Props { value: string; mode: 'live' | 'source'; onChange: (value: string) => void; onSave: () => void; }

function focusSource(view: EditorView, position: number): void {
  view.dispatch({ selection: { anchor: position }, scrollIntoView: true });
  view.focus();
}

class FrontmatterWidget extends WidgetType {
  constructor(private readonly source: string, private readonly from: number) { super(); }
  eq(other: FrontmatterWidget): boolean { return this.source === other.source && this.from === other.from; }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('section'); box.className = 'cm-live-properties';
    const title = document.createElement('strong'); title.textContent = 'Properties'; box.appendChild(title);
    const lines = this.source.split(/\r?\n/).slice(1, -1); let rendered = 0;
    for (const line of lines) {
      const match = line.match(/^\s*([^:#][^:]*):\s*(.*)$/); if (!match?.[1]) continue;
      const row = document.createElement('div'); const key = document.createElement('span'); const value = document.createElement('span');
      key.textContent = match[1].trim(); value.textContent = match[2]?.trim() || '—'; row.appendChild(key); row.appendChild(value); box.appendChild(row); rendered += 1;
    }
    if (!rendered) { const empty = document.createElement('p'); empty.textContent = '空属性区'; box.appendChild(empty); }
    box.addEventListener('mousedown', (event) => { event.preventDefault(); focusSource(view, this.from); });
    return box;
  }
}

class ImageWidget extends WidgetType {
  constructor(private readonly source: string, private readonly alt: string, private readonly from: number, private readonly block: boolean) { super(); }
  eq(other: ImageWidget): boolean { return this.source === other.source && this.alt === other.alt && this.from === other.from && this.block === other.block; }
  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement(this.block ? 'figure' : 'span'); root.className = this.block ? 'cm-live-image' : 'cm-live-image-inline';
    const source = this.source.match(/^media:\/\/([0-9a-f-]{36})$/i)?.[1];
    const safeSource = source ? `/api/public/media/${source}` : /^(?:https?:\/\/|\/)/i.test(this.source) ? this.source : '';
    if (safeSource) { const image = document.createElement('img'); image.src = safeSource; image.alt = this.alt; image.loading = 'lazy'; root.appendChild(image); }
    else { const missing = document.createElement('span'); missing.textContent = this.alt || '无法预览的图片'; root.appendChild(missing); }
    if (this.block && this.alt) { const caption = document.createElement('figcaption'); caption.textContent = this.alt; root.appendChild(caption); }
    root.addEventListener('mousedown', (event) => { event.preventDefault(); focusSource(view, this.from); });
    return root;
  }
}

class TableWidget extends WidgetType {
  constructor(private readonly source: string, private readonly from: number) { super(); }
  eq(other: TableWidget): boolean { return this.source === other.source && this.from === other.from; }
  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('div'); wrapper.className = 'cm-live-table'; const table = document.createElement('table');
    const rows = this.source.split(/\r?\n/).map((line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim()));
    const separator = rows.findIndex((row) => row.every((cell) => /^:?-{3,}:?$/.test(cell)));
    rows.forEach((cells, rowIndex) => {
      if (rowIndex === separator) return;
      const row = document.createElement('tr'); const header = separator > 0 && rowIndex < separator;
      cells.forEach((cell) => { const element = document.createElement(header ? 'th' : 'td'); element.textContent = cell; row.appendChild(element); });
      table.appendChild(row);
    });
    wrapper.appendChild(table); wrapper.addEventListener('mousedown', (event) => { event.preventDefault(); focusSource(view, this.from); }); return wrapper;
  }
}

class CalloutWidget extends WidgetType {
  constructor(private readonly source: string, private readonly from: number) { super(); }
  eq(other: CalloutWidget): boolean { return this.source === other.source && this.from === other.from; }
  toDOM(view: EditorView): HTMLElement {
    const lines = this.source.split(/\r?\n/).map((line) => line.replace(/^\s*>\s?/, '')); const marker = lines[0]?.match(/^\[!([^\]]+)]\s*(.*)$/i);
    const box = document.createElement('aside'); box.className = 'cm-live-callout'; box.dataset.type = marker?.[1]?.toLocaleLowerCase() ?? 'note';
    const title = document.createElement('strong'); title.textContent = marker?.[2] || marker?.[1] || 'Note'; box.appendChild(title);
    const body = lines.slice(1).join('\n').trim(); if (body) { const paragraph = document.createElement('p'); paragraph.textContent = body; box.appendChild(paragraph); }
    box.addEventListener('mousedown', (event) => { event.preventDefault(); focusSource(view, this.from); }); return box;
  }
}

class TaskWidget extends WidgetType {
  constructor(private readonly checked: boolean, private readonly from: number) { super(); }
  eq(other: TaskWidget): boolean { return this.checked === other.checked && this.from === other.from; }
  toDOM(view: EditorView): HTMLElement {
    const input = document.createElement('input'); input.type = 'checkbox'; input.className = 'cm-live-task'; input.checked = this.checked; input.setAttribute('aria-label', this.checked ? '标记为未完成' : '标记为完成');
    input.addEventListener('change', () => view.dispatch({ changes: { from: this.from + 1, to: this.from + 2, insert: input.checked ? 'x' : ' ' } })); return input;
  }
  ignoreEvent(): boolean { return true; }
}

class BulletWidget extends WidgetType {
  toDOM(): HTMLElement { const bullet = document.createElement('span'); bullet.className = 'cm-live-bullet'; bullet.textContent = '•'; return bullet; }
}

function lineIsActive(view: EditorView, position: number): boolean {
  const line = view.state.doc.lineAt(position);
  return view.state.selection.ranges.some((range) => range.from <= line.to && range.to >= line.from);
}

function selectionTouches(view: EditorView, from: number, to: number): boolean {
  return view.state.selection.ranges.some((range) => range.from <= to && range.to >= from);
}

function hideRange(from: number, to: number): Range<Decoration> | null {
  return to > from ? Decoration.replace({}).range(from, to) : null;
}

function buildDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = []; const doc = view.state.doc; const text = doc.toString();
  const frontmatter = text.match(/^---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)/); let frontmatterTo = 0;
  if (frontmatter) {
    frontmatterTo = frontmatter[0].length;
    if (!selectionTouches(view, 0, frontmatterTo)) ranges.push(Decoration.replace({ widget: new FrontmatterWidget(frontmatter[0], 0), block: true }).range(0, frontmatterTo));
  }
  syntaxTree(view.state).iterate({ enter(node) {
    if (frontmatterTo && node.to <= frontmatterTo) return false;
    const name = node.name; const source = text.slice(node.from, node.to); const activeLine = lineIsActive(view, node.from);
    if (name === 'Image' && !selectionTouches(view, node.from, node.to)) {
      const match = source.match(/^!\[([^\]]*)]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)$/); if (!match?.[2]) return;
      const line = doc.lineAt(node.from); const block = line.text.trim() === source.trim(); const from = block ? line.from : node.from; const to = block ? line.to : node.to;
      ranges.push(Decoration.replace({ widget: new ImageWidget(match[2], match[1] ?? '', from, block), block }).range(from, to)); return false;
    }
    if (name === 'Table' && !selectionTouches(view, node.from, node.to)) { ranges.push(Decoration.replace({ widget: new TableWidget(source, node.from), block: true }).range(node.from, node.to)); return false; }
    if (name === 'Blockquote' && /^\s*>\s*\[![^\]]+]/i.test(source) && !selectionTouches(view, node.from, node.to)) { ranges.push(Decoration.replace({ widget: new CalloutWidget(source, node.from), block: true }).range(node.from, node.to)); return false; }

    let className = '';
    if (/^ATXHeading[1-6]$/.test(name)) className = `cm-live-h${name.at(-1)}`;
    else if (name === 'StrongEmphasis') className = 'cm-live-strong';
    else if (name === 'Emphasis') className = 'cm-live-em';
    else if (name === 'InlineCode') className = 'cm-live-code';
    else if (name === 'FencedCode') className = 'cm-live-codeblock';
    else if (name === 'Link') className = 'cm-live-link';
    else if (name === 'Strikethrough') className = 'cm-live-strike';
    if (className && node.to > node.from) ranges.push(Decoration.mark({ class: className }).range(node.from, node.to));

    if (!activeLine && (name.endsWith('Mark') || name === 'HeaderMark')) {
      let to = node.to; if (name === 'HeaderMark' && text[to] === ' ') to += 1;
      const hidden = hideRange(node.from, to); if (hidden) ranges.push(hidden);
    } else if (!activeLine && name === 'URL') {
      const hidden = hideRange(node.from, node.to); if (hidden) ranges.push(hidden);
    } else if (!activeLine && name === 'TaskMarker') {
      ranges.push(Decoration.replace({ widget: new TaskWidget(/[xX]/.test(source), node.from) }).range(node.from, node.to));
    } else if (!activeLine && name === 'ListMark') {
      const line = doc.lineAt(node.from); const isTask = /^\s*[-+*]\s+\[[ xX]]/.test(line.text);
      if (isTask) { const hidden = hideRange(node.from, node.to); if (hidden) ranges.push(hidden); }
      else if (/^[-+*]$/.test(source)) ranges.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to));
    }
  }});
  return Decoration.set(ranges, true);
}

const livePreview = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = buildDecorations(view); }
  update(update: ViewUpdate) { if (update.docChanged || update.selectionSet || update.viewportChanged) this.decorations = buildDecorations(update.view); }
}, { decorations: (plugin) => plugin.decorations });

function prefixSelectedLines(view: EditorView, prefix: string): void {
  const range = view.state.selection.main; const first = view.state.doc.lineAt(range.from); const last = view.state.doc.lineAt(range.to);
  const changes: Array<{ from: number; insert: string }> = [];
  for (let number = first.number; number <= last.number; number += 1) changes.push({ from: view.state.doc.line(number).from, insert: prefix });
  view.dispatch({ changes, selection: { anchor: range.anchor + prefix.length, head: range.head + prefix.length * changes.length } }); view.focus();
}

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, Props>(function MarkdownEditor({ value, mode, onChange, onSave }, ref) {
  const hostRef = useRef<HTMLDivElement>(null); const viewRef = useRef<EditorView | null>(null); const modeCompartment = useRef(new Compartment()); const callbackRef = useRef(onChange); const saveRef = useRef(onSave); const initialValue=useRef(value); const initialMode=useRef(mode);
  callbackRef.current = onChange; saveRef.current = onSave;
  useEffect(() => {
    if (!hostRef.current) return;
    const state = EditorState.create({ doc: initialValue.current, extensions: [
      markdown(), history(), syntaxHighlighting(defaultHighlightStyle), EditorView.lineWrapping,
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab, { key: 'Mod-s', run: () => { saveRef.current(); return true; } }]),
      EditorView.updateListener.of((update) => { if (update.docChanged) callbackRef.current(update.state.doc.toString()); }),
      modeCompartment.current.of(initialMode.current === 'live' ? livePreview : EditorView.editorAttributes.of({ class: 'cm-source-mode' })),
    ] });
    const view = new EditorView({ state, parent: hostRef.current }); viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
  }, []);
  useEffect(() => { const view = viewRef.current; if (view) view.dispatch({ effects: modeCompartment.current.reconfigure(mode === 'live' ? livePreview : EditorView.editorAttributes.of({ class: 'cm-source-mode' })) }); }, [mode]);
  useEffect(() => { const view = viewRef.current; if (view && view.state.doc.toString() !== value) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } }); }, [value]);
  useImperativeHandle(ref, () => ({
    wrapSelection(before, after = before) { const view = viewRef.current; if (!view) return; const range = view.state.selection.main; const selected = view.state.sliceDoc(range.from, range.to); const text = !selected && before === '`' ? 'code' : selected; view.dispatch({ changes: { from: range.from, to: range.to, insert: `${before}${text}${after}` }, selection: { anchor: range.from + before.length, head: range.from + before.length + text.length } }); view.focus(); },
    prefixLine(prefix) { const view = viewRef.current; if (view) prefixSelectedLines(view, prefix); },
    insert(text) { const view = viewRef.current; if (!view) return; const range = view.state.selection.main; view.dispatch({ changes: { from: range.from, to: range.to, insert: text }, selection: { anchor: range.from + text.length } }); view.focus(); },
    indent(more) { const view = viewRef.current; if (view) (more ? indentMore : indentLess)(view); },
    undo() { const view = viewRef.current; if (view) undo(view); },
    redo() { const view = viewRef.current; if (view) redo(view); },
    openSearch(replace = false) { const view = viewRef.current; if (!view) return; openSearchPanel(view); if (replace) requestAnimationFrame(() => view.dom.querySelector<HTMLInputElement>('.cm-search input[name="replace"]')?.focus()); },
    selectStructure() { const view = viewRef.current; if (view) selectParentSyntax(view); },
    focus() { viewRef.current?.focus(); },
  }), []);
  return <div className="editor-host" ref={hostRef}/>;
});
