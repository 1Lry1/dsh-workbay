/**
 * dsh-workbay-files:editor — the lazily loaded CodeMirror 6 editing surface for
 * the Files page.
 *
 * The files client is a single-file `window.__ModuleLoader__.load({...})`
 * bundle that cannot rely on npm packages, so this module is bundled separately
 * by `scripts/build-chunks.mjs` into `lib/chunks/editor.js` and served by the
 * host at `/dsh-workbay-files/chunk/editor.js`. The wrapper handed to the
 * client is:
 *
 *   globalThis.__dshChunks__['dsh-workbay-files:editor'] = (env) => { ... }
 *
 * It must stay DOM-only: no React, no Node built-ins, no dynamic loading. All
 * CodeMirror language packages are statically imported here and tree-shaken by
 * esbuild, so the chunk has no network dependency beyond its own file.
 *
 * Public API (framework agnostic):
 *
 *   const { createEditor, languageFor } = await loadChunk('dsh-workbay-files:editor')
 *   const handle = createEditor(container, {
 *     content, language, readOnly, line,
 *     onChange(text), onSave(), onCursor(line, col),
 *   })
 *   handle.setContent(text) / handle.getContent() / handle.setLanguage(lang)
 *   handle.setReadOnly(flag) / handle.focus() / handle.destroy()
 */

import { Compartment, EditorState, Prec, Transaction } from '@codemirror/state'
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view'
import {
  HighlightStyle,
  StreamLanguage,
  bracketMatching,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { tags } from '@lezer/highlight'

import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { go } from '@codemirror/lang-go'
import { rust } from '@codemirror/lang-rust'
import { java } from '@codemirror/lang-java'
import { cpp } from '@codemirror/lang-cpp'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/lang-yaml'
import { sql } from '@codemirror/lang-sql'

/* Legacy stream modes cover the languages without a native CodeMirror 6
 * package: C#, shell, and PowerShell. */
import { csharp } from '@codemirror/legacy-modes/mode/clike'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { powerShell } from '@codemirror/legacy-modes/mode/powershell'

/** Key used by the client loader (`env.modules` is unused here — no React). */
export const CHUNK_KEY = 'dsh-workbay-files:editor'

const TAB_SIZE = 2

/* ------------------------------------------------------------------------- *
 * Language resolution
 * ------------------------------------------------------------------------- */

/**
 * Extension (lowercase, no leading dot) -> factory that builds a CodeMirror
 * language extension. Factories are lazy so a plain-text file never pays for
 * constructing a parser.
 */
const LANGUAGE_FACTORIES = {
  js: () => javascript(),
  mjs: () => javascript(),
  cjs: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  ts: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  json: () => json(),
  md: () => markdown(),
  markdown: () => markdown(),
  py: () => python(),
  go: () => go(),
  rust: () => rust(),
  rs: () => rust(),
  java: () => java(),
  c: () => cpp(),
  h: () => cpp(),
  cpp: () => cpp(),
  hpp: () => cpp(),
  cs: () => StreamLanguage.define(csharp),
  html: () => html(),
  htm: () => html(),
  css: () => css(),
  xml: () => xml(),
  yaml: () => yaml(),
  yml: () => yaml(),
  sql: () => sql(),
  sh: () => StreamLanguage.define(shell),
  bash: () => StreamLanguage.define(shell),
  ps1: () => StreamLanguage.define(powerShell),
}

const languageCache = new Map()

/** Normalize `photo.TSX`, `.tsx` and `tsx` to `tsx`; returns '' when unknown. */
function normalizeExtension(filenameOrExt) {
  if (typeof filenameOrExt !== 'string') return ''
  let value = filenameOrExt.trim().toLowerCase()
  if (value === '') return ''
  const slash = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
  if (slash !== -1) value = value.slice(slash + 1)
  const dot = value.lastIndexOf('.')
  if (dot !== -1) value = value.slice(dot + 1)
  return value
}

/**
 * Pure language lookup: accepts a filename (`main.tsx`) or a bare extension
 * (`tsx`, `.tsx`) and returns a CodeMirror language extension, or `null` for
 * unknown input (the editor then uses plain text).
 *
 * Pure on purpose: the node test asserts the map without a DOM.
 */
export function languageFor(filenameOrExt) {
  const ext = normalizeExtension(filenameOrExt)
  if (ext === '') return null
  const factory = LANGUAGE_FACTORIES[ext]
  if (!factory) return null
  let language = languageCache.get(ext)
  if (!language) {
    language = factory()
    languageCache.set(ext, language)
  }
  return language
}

/** Extensions the editor knows about, in stable order (used by tests/docs). */
export const supportedExtensions = Object.freeze(Object.keys(LANGUAGE_FACTORIES))

/* ------------------------------------------------------------------------- *
 * Theme
 * ------------------------------------------------------------------------- */

const LIGHT = {
  dark: false,
  bg: '#ffffff',
  layer: '#f6f8fa',
  border: '#e1e4e8',
  text: '#1f2328',
  muted: '#6e7781',
  brand: '#4d6bfe',
  activeLine: 'rgba(77, 107, 254, 0.06)',
  activeLineGutter: 'rgba(77, 107, 254, 0.10)',
  selection: 'rgba(77, 107, 254, 0.22)',
  selectionMatch: 'rgba(77, 107, 254, 0.12)',
  searchMatch: 'rgba(255, 196, 0, 0.35)',
  searchMatchSelected: 'rgba(255, 140, 0, 0.45)',
  matchingBracket: 'rgba(77, 107, 254, 0.18)',
  keyword: '#a626a4',
  string: '#50a14f',
  number: '#986801',
  comment: '#a0a1a7',
  function: '#4078f2',
  variable: '#383a42',
  type: '#c18401',
  operator: '#0184bc',
  link: '#4078f2',
  heading: '#1f2328',
  invalid: '#e45649',
  inserted: '#50a14f',
  deleted: '#e45649',
}

const DARK = {
  dark: true,
  bg: '#0d1117',
  layer: '#161b22',
  border: '#30363d',
  text: '#e6edf3',
  muted: '#8b949e',
  brand: '#7c9cff',
  activeLine: 'rgba(124, 156, 255, 0.08)',
  activeLineGutter: 'rgba(124, 156, 255, 0.12)',
  selection: 'rgba(124, 156, 255, 0.26)',
  selectionMatch: 'rgba(124, 156, 255, 0.14)',
  searchMatch: 'rgba(255, 196, 0, 0.30)',
  searchMatchSelected: 'rgba(255, 140, 0, 0.42)',
  matchingBracket: 'rgba(124, 156, 255, 0.20)',
  keyword: '#c678dd',
  string: '#98c379',
  number: '#d19a66',
  comment: '#7f848e',
  function: '#61afef',
  variable: '#abb2bf',
  type: '#e5c07b',
  operator: '#56b6c2',
  link: '#61afef',
  heading: '#e06c75',
  invalid: '#e06c75',
  inserted: '#98c379',
  deleted: '#e06c75',
}

/* The UI chrome is driven by DSH CSS variables (so it follows the host theme
 * automatically); the palette fallbacks only matter when the chunk is rendered
 * outside DSH, e.g. in a bare test page. */
function cssVars(c) {
  return {
    bg: `var(--dsw-alias-bg-layer-1, ${c.bg})`,
    border: `var(--dsw-alias-border-l2, ${c.border})`,
    text: `var(--dsw-alias-label-primary, ${c.text})`,
    brand: `var(--dsw-alias-brand-primary, ${c.brand})`,
    mono: 'var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace)',
  }
}

function highlightStyle(c) {
  return HighlightStyle.define([
    { tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword], color: c.keyword },
    { tag: [tags.name, tags.deleted, tags.character, tags.propertyName, tags.macroName], color: c.variable },
    { tag: [tags.function(tags.variableName), tags.labelName], color: c.function },
    { tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)], color: c.number },
    { tag: [tags.definition(tags.name), tags.separator], color: c.variable },
    {
      tag: [
        tags.typeName,
        tags.className,
        tags.number,
        tags.changed,
        tags.annotation,
        tags.modifier,
        tags.self,
        tags.namespace,
      ],
      color: c.type,
    },
    {
      tag: [tags.operator, tags.operatorKeyword, tags.url, tags.escape, tags.regexp, tags.link, tags.special(tags.string)],
      color: c.operator,
    },
    { tag: [tags.meta, tags.comment], color: c.comment, fontStyle: 'italic' },
    { tag: tags.strong, fontWeight: 'bold' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.strikethrough, textDecoration: 'line-through' },
    { tag: tags.link, color: c.link, textDecoration: 'underline' },
    { tag: [tags.heading, tags.heading1, tags.heading2, tags.heading3], color: c.heading, fontWeight: 'bold' },
    { tag: [tags.atom, tags.bool, tags.special(tags.variableName)], color: c.number },
    { tag: [tags.processingInstruction, tags.string, tags.inserted], color: c.string },
    { tag: tags.invalid, color: c.invalid },
  ])
}

function themeSpec(c) {
  const v = cssVars(c)
  return {
    '&': {
      height: '100%',
      color: v.text,
      backgroundColor: v.bg,
      fontFamily: v.mono,
      fontSize: '13px',
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      fontFamily: 'inherit',
      lineHeight: '1.6',
      overflow: 'auto',
    },
    '.cm-content': { caretColor: v.brand, padding: '4px 0' },
    '.cm-line': { padding: '0 8px' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: v.brand, borderLeftWidth: '2px' },
    '&.cm-readonly .cm-cursor, &.cm-readonly .cm-dropCursor': { display: 'none' },
    '&.cm-readonly .cm-content': { caretColor: 'transparent' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: c.selection,
    },
    '.cm-selectionMatch': { backgroundColor: c.selectionMatch },
    '.cm-activeLine': { backgroundColor: c.activeLine },
    '.cm-gutters': {
      backgroundColor: v.bg,
      color: v.muted,
      borderRight: `1px solid ${v.border}`,
      fontFamily: 'inherit',
    },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 14px' },
    '.cm-activeLineGutter': {
      backgroundColor: c.activeLineGutter,
      color: v.text,
    },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
      backgroundColor: c.matchingBracket,
      outline: `1px solid ${v.brand}`,
      color: 'inherit',
    },
    '.cm-nonmatchingBracket': { color: c.invalid },
    '.cm-searchMatch': { backgroundColor: c.searchMatch, outline: `1px solid ${v.border}` },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: c.searchMatchSelected },
    '.cm-panels': {
      backgroundColor: v.bg,
      color: v.text,
      fontFamily: v.mono,
    },
    '.cm-panels.cm-panels-top': { borderBottom: `1px solid ${v.border}` },
    '.cm-panels.cm-panels-bottom': { borderTop: `1px solid ${v.border}` },
    '.cm-panel.cm-search': { padding: '6px 8px' },
    '.cm-panel.cm-search input, .cm-panel.cm-search select': {
      backgroundColor: c.layer,
      color: v.text,
      border: `1px solid ${v.border}`,
      borderRadius: '4px',
      padding: '2px 6px',
      fontFamily: 'inherit',
      fontSize: '12px',
    },
    '.cm-panel.cm-search button': {
      backgroundColor: c.layer,
      color: v.text,
      border: `1px solid ${v.border}`,
      borderRadius: '4px',
      padding: '2px 8px',
      fontFamily: 'inherit',
      fontSize: '12px',
      cursor: 'pointer',
    },
    '.cm-panel.cm-search label': { color: v.muted, fontSize: '12px' },
    '.cm-panel.cm-search [name=close]': { color: v.muted },
    '.cm-tooltip': {
      backgroundColor: v.bg,
      color: v.text,
      border: `1px solid ${v.border}`,
      fontFamily: v.mono,
    },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: c.layer,
      color: v.text,
    },
    '.cm-textfield': { backgroundColor: c.layer, color: v.text, border: `1px solid ${v.border}` },
    '.cm-button': {
      backgroundColor: c.layer,
      backgroundImage: 'none',
      color: v.text,
      border: `1px solid ${v.border}`,
    },
  }
}

/* Both variants are built once; only the detected one is used. */
const THEMES = { light: null, dark: null }

function themeFor(dark) {
  const key = dark ? 'dark' : 'light'
  if (!THEMES[key]) {
    const palette = dark ? DARK : LIGHT
    THEMES[key] = [EditorView.theme(themeSpec(palette), { dark }), syntaxHighlighting(highlightStyle(palette))]
  }
  return THEMES[key]
}

/** Best-effort light/dark detection from the host's rendered colors. */
function detectDarkMode(container) {
  try {
    const doc = container && container.ownerDocument
    const win = doc && doc.defaultView
    if (win && typeof win.getComputedStyle === 'function') {
      const style = win.getComputedStyle(container)
      const bg = parseCssColor(style.backgroundColor)
      if (bg && bg.a > 0.5) return luminance(bg) < 0.5
      const fg = parseCssColor(style.color)
      if (fg) return luminance(fg) > 0.5
    }
    if (win && typeof win.matchMedia === 'function') {
      return win.matchMedia('(prefers-color-scheme: dark)').matches
    }
  } catch {
    /* Rendering outside a browser (or a hostile container): stay light. */
  }
  return false
}

function parseCssColor(value) {
  if (typeof value !== 'string') return null
  const match = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i.exec(
    value.trim(),
  )
  if (!match) return null
  return {
    r: Number(match[1]) / 255,
    g: Number(match[2]) / 255,
    b: Number(match[3]) / 255,
    a: match[4] === undefined ? 1 : Number(match[4]),
  }
}

function luminance({ r, g, b }) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/* ------------------------------------------------------------------------- *
 * Editor lifecycle
 * ------------------------------------------------------------------------- */

function readOnlyExtensions(flag) {
  return flag
    ? [
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        /* Marks the wrapper so the theme can hide the caret while keeping
         * selection/copy behaviour. */
        EditorView.editorAttributes.of({ class: 'cm-readonly' }),
      ]
    : [EditorState.readOnly.of(false), EditorView.editable.of(true)]
}

function isElementLike(node) {
  return (
    !!node &&
    typeof node === 'object' &&
    typeof node.appendChild === 'function' &&
    typeof node.removeChild === 'function'
  )
}

function callSafely(fn, ...args) {
  if (typeof fn !== 'function') return
  try {
    fn(...args)
  } catch (error) {
    /* A host callback must never break the editor update cycle. */
    if (typeof console !== 'undefined' && console.error) console.error(error)
  }
}

/**
 * Mount a CodeMirror 6 editor into `container`.
 *
 * @param {HTMLElement} container
 * @param {{
 *   content?: string,
 *   language?: string,
 *   readOnly?: boolean,
 *   line?: number,
 *   onChange?: (text: string) => void,
 *   onSave?: () => void,
 *   onCursor?: (line: number, col: number) => void,
 * }} [options]
 * @returns {{
 *   destroy(): void,
 *   setContent(text: string): void,
 *   getContent(): string,
 *   focus(): void,
 *   setLanguage(lang: string): void,
 *   setReadOnly(flag: boolean): void,
 * }}
 */
export function createEditor(container, options) {
  if (!isElementLike(container)) {
    throw new TypeError('createEditor(container, options): container must be a DOM element')
  }
  const opts = options || {}
  const onChange = opts.onChange
  const onSave = opts.onSave
  const onCursor = opts.onCursor
  const initialLine = opts.line == null ? null : Number(opts.line)

  const languageConf = new Compartment()
  const readOnlyConf = new Compartment()
  const themeConf = new Compartment()

  let destroyed = false
  let applying = false
  let dark = detectDarkMode(container)

  const onSaveCommand = () => {
    callSafely(onSave)
    return true
  }

  const extensions = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    rectangularSelection(),
    crosshairCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    EditorState.tabSize.of(TAB_SIZE),
    indentUnit.of(' '.repeat(TAB_SIZE)),
    /* `Mod-s` = Cmd+S on macOS and Ctrl+S elsewhere. Returning true (and
     * `preventDefault: true`) stops the browser's save-page dialog. */
    Prec.high(
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: onSaveCommand,
        },
      ]),
    ),
    keymap.of([indentWithTab, ...defaultKeymap, ...searchKeymap, ...historyKeymap]),
    themeConf.of(themeFor(dark)),
    languageConf.of(languageFor(opts.language) || []),
    readOnlyConf.of(readOnlyExtensions(!!opts.readOnly)),
    EditorView.contentAttributes.of({
      spellcheck: 'false',
      autocapitalize: 'off',
      autocomplete: 'off',
      'data-gramm': 'false',
    }),
    EditorView.updateListener.of((update) => {
      if (applying || destroyed) return
      if (update.docChanged) {
        callSafely(onChange, update.state.doc.toString())
      }
      if (update.selectionSet || update.docChanged) {
        const head = update.state.selection.main.head
        const line = update.state.doc.lineAt(head)
        callSafely(onCursor, line.number, head - line.from + 1)
      }
    }),
  ]

  const view = new EditorView({
    state: EditorState.create({
      doc: typeof opts.content === 'string' ? opts.content : '',
      extensions,
    }),
    parent: container,
  })

  function currentCursor() {
    if (destroyed) return { line: 1, col: 1 }
    const head = view.state.selection.main.head
    const line = view.state.doc.lineAt(head)
    return { line: line.number, col: head - line.from + 1 }
  }

  /* Land on the requested line once the view is mounted (file open). */
  if (initialLine != null && Number.isFinite(initialLine)) {
    const doc = view.state.doc
    const lineNumber = Math.max(1, Math.min(doc.lines, Math.floor(initialLine)))
    const line = doc.line(lineNumber)
    applying = true
    try {
      view.dispatch({
        selection: { anchor: line.from },
        effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
      })
    } finally {
      applying = false
    }
  }

  const initialCursor = currentCursor()
  callSafely(onCursor, initialCursor.line, initialCursor.col)

  /* Follow the host theme when the OS scheme flips. The UI chrome is CSS-var
   * driven, so only the token palette fallbacks actually change here. */
  let mediaQuery = null
  const onSchemeChange = (event) => {
    if (destroyed || !event) return
    const next = !!event.matches
    if (next === dark) return
    dark = next
    view.dispatch({ effects: themeConf.reconfigure(themeFor(dark)) })
  }
  try {
    const win = container.ownerDocument && container.ownerDocument.defaultView
    if (win && typeof win.matchMedia === 'function') {
      mediaQuery = win.matchMedia('(prefers-color-scheme: dark)')
      if (mediaQuery && typeof mediaQuery.addEventListener === 'function') {
        mediaQuery.addEventListener('change', onSchemeChange)
      } else if (mediaQuery && typeof mediaQuery.addListener === 'function') {
        mediaQuery.addListener(onSchemeChange)
      }
    }
  } catch {
    mediaQuery = null
  }

  return {
    /** Replace the whole document without echoing an onChange event. */
    setContent(text) {
      if (destroyed) return
      const next = typeof text === 'string' ? text : String(text == null ? '' : text)
      applying = true
      try {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: next },
          selection: { anchor: 0 },
          effects: EditorView.scrollIntoView(0, { y: 'start' }),
          /* A programmatic document swap is not an edit the user can undo. */
          annotations: Transaction.addToHistory.of(false),
        })
      } finally {
        applying = false
      }
    },
    getContent() {
      return destroyed ? '' : view.state.doc.toString()
    },
    focus() {
      if (!destroyed) view.focus()
    },
    /** `lang` accepts a filename or a bare extension, like languageFor(). */
    setLanguage(lang) {
      if (destroyed) return
      view.dispatch({ effects: languageConf.reconfigure(languageFor(lang) || []) })
    },
    setReadOnly(flag) {
      if (destroyed) return
      view.dispatch({ effects: readOnlyConf.reconfigure(readOnlyExtensions(!!flag)) })
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      if (mediaQuery) {
        try {
          if (typeof mediaQuery.removeEventListener === 'function') {
            mediaQuery.removeEventListener('change', onSchemeChange)
          } else if (typeof mediaQuery.removeListener === 'function') {
            mediaQuery.removeListener(onSchemeChange)
          }
        } catch {
          /* ignore */
        }
      }
      try {
        view.destroy()
      } catch {
        /* Removing an already detached view is harmless. */
      }
    },
  }
}
