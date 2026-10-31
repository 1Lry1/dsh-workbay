/**
 * dsh-workbay-terminal — lazy xterm.js chunk (built by scripts/build-chunks.mjs).
 *
 * This is the ONLY half of the terminal plugin that may import npm packages:
 * the page bundle is a plain ModuleLoader file. The build bundles this entry to
 * `lib/chunks/xterm.js` as
 *
 *   globalThis.__dshChunks__['dsh-workbay-terminal:xterm'] = (env) => module.exports
 *
 * `env.modules` is not needed here (xterm is bundled), but the page still passes
 * the platform React so every chunk follows the same protocol.
 *
 * The CSS import is turned into a string by the build (`loader: {'.css':'text'}`)
 * and exported as `css`, so the page can inject exactly one `<style>` tag.
 */
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import xtermCss from '@xterm/xterm/css/xterm.css'

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24
const MIN_COLS = 2
const MAX_COLS = 1000
const MIN_ROWS = 2
const MAX_ROWS = 500
const DEFAULT_SCROLLBACK = 5000

/** ITheme keys copied onto xterm's terminal options (unknown keys ignored). */
const THEME_KEYS = [
  'foreground', 'background', 'cursor', 'cursorAccent',
  'selectionBackground', 'selectionForeground', 'selectionInactiveBackground',
  'scrollbarSliderBackground', 'scrollbarSliderHoverBackground', 'scrollbarSliderActiveBackground',
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
]

function clampInteger(value, fallback, min, max) {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(max, Math.max(min, number))
}

function pickTheme(theme) {
  const source = theme !== null && typeof theme === 'object' ? theme : {}
  const picked = {}
  for (let index = 0; index < THEME_KEYS.length; index += 1) {
    const key = THEME_KEYS[index]
    if (typeof source[key] === 'string' && source[key] !== '') picked[key] = source[key]
  }
  return picked
}

/** Plain-text view of the scrollback, used by tests/e2e against the live page. */
function bufferTextOf(terminal) {
  try {
    const buffer = terminal.buffer.active
    if (buffer === null || buffer === undefined) return ''
    const lines = []
    for (let index = 0; index < buffer.length; index += 1) {
      const line = buffer.getLine(index)
      lines.push(line === null || line === undefined ? '' : line.translateToString(true))
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    return lines.join('\n')
  } catch (error) {
    void error
    return ''
  }
}

/**
 * Create one xterm instance inside `container`.
 *
 * The returned handle is deliberately small and DOM-agnostic where possible so
 * the page can treat it as a plain object (and Node tests can fake it):
 *   write, writeln, reset, dispose, focus, fit, cols, rows, bufferText
 * plus `getSelection` for the Ctrl+Shift+C copy shortcut.
 */
export function createTerminal(options) {
  const opts = options !== null && options !== undefined ? options : {}
  const container = opts.container
  if (container === null || container === undefined || typeof container.appendChild !== 'function') {
    throw new TypeError('createTerminal({ container }): container must be a DOM element')
  }
  const theme = opts.theme !== null && typeof opts.theme === 'object' ? opts.theme : {}

  const terminal = new Terminal({
    cols: clampInteger(opts.cols, DEFAULT_COLS, MIN_COLS, MAX_COLS),
    rows: clampInteger(opts.rows, DEFAULT_ROWS, MIN_ROWS, MAX_ROWS),
    theme: pickTheme(theme),
    fontFamily: typeof theme.fontFamily === 'string' && theme.fontFamily !== '' ? theme.fontFamily : undefined,
    fontSize: typeof theme.fontSize === 'number' && Number.isFinite(theme.fontSize) ? theme.fontSize : 12,
    cursorBlink: true,
    scrollback: DEFAULT_SCROLLBACK,
    allowProposedApi: false,
    convertEol: false,
  })

  const fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  terminal.open(container)
  try {
    fitAddon.fit()
  } catch (error) {
    void error
  }

  const subscriptions = []
  if (typeof opts.onData === 'function') {
    subscriptions.push(terminal.onData((data) => { opts.onData(data) }))
  }
  if (typeof opts.onResize === 'function') {
    subscriptions.push(terminal.onResize((size) => {
      if (size !== null && size !== undefined) opts.onResize(size.cols, size.rows)
    }))
  }
  if (typeof opts.onTitle === 'function' && typeof terminal.onTitleChange === 'function') {
    subscriptions.push(terminal.onTitleChange((title) => { opts.onTitle(title) }))
  }

  let disposed = false

  return {
    write(text) {
      if (disposed) return
      terminal.write(typeof text === 'string' ? text : String(text === undefined || text === null ? '' : text))
    },
    writeln(text) {
      if (disposed) return
      terminal.writeln(typeof text === 'string' ? text : String(text === undefined || text === null ? '' : text))
    },
    reset() {
      if (!disposed) terminal.reset()
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (let index = 0; index < subscriptions.length; index += 1) {
        try {
          const subscription = subscriptions[index]
          if (subscription !== null && subscription !== undefined && typeof subscription.dispose === 'function') {
            subscription.dispose()
          }
        } catch (error) { void error }
      }
      subscriptions.length = 0
      try { fitAddon.dispose() } catch (error) { void error }
      try { terminal.dispose() } catch (error) { void error }
    },
    focus() {
      if (disposed) return
      try { terminal.focus() } catch (error) { void error }
    },
    fit() {
      if (disposed) return { cols: terminal.cols, rows: terminal.rows }
      try { fitAddon.fit() } catch (error) { void error }
      return { cols: terminal.cols, rows: terminal.rows }
    },
    get cols() {
      return terminal.cols
    },
    get rows() {
      return terminal.rows
    },
    bufferText() {
      if (disposed) return ''
      return bufferTextOf(terminal)
    },
    getSelection() {
      if (disposed) return ''
      try {
        return terminal.getSelection()
      } catch (error) {
        void error
        return ''
      }
    },
  }
}

/** xterm.css as text, injected once by the page. */
export const css = xtermCss
