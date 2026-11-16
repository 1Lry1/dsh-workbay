/**
 * @dsh-workbay/kit — client-side UI layer shared by every workbench bundle.
 *
 * DSH loads each plugin's browser half through
 * `window.__ModuleLoader__.load({ id, factory })` as ONE self-contained file, so
 * client code cannot `import` this package at runtime. This module is therefore
 * the single SOURCE of the shared layer: `scripts/build-chunks.mjs` inlines it
 * into each client bundle, the same way the CodeMirror chunks are built. That is
 * why nothing here imports anything — it must survive being pasted into five
 * bundles and running in a browser with no module loader around it.
 *
 * Four things live here:
 *
 *   1. width tiers (`t1..t4`) and the layout a tier implies;
 *   2. the `auto | single | split | tri` layout mode with its persistence;
 *   3. the recent-workspaces list (dedupe, pinning, cap);
 *   4. the `--wb-*` token sheet derived from the host's `--dsw-alias-*` tokens,
 *      plus the handful of DOM primitives every page was re-implementing.
 *
 * Everything except `createUi` is a pure function, which is what the tests pin
 * down: the tier boundaries and the recent-list rules are the two places where a
 * silent drift would be expensive to find later.
 */

/* ================================ tiers ================================ */

/** Ordered widest-last. `t1` is the narrowest dock (the panel clamps at 520). */
export const TIERS = ['t1', 't2', 't3', 't4']

/** Inclusive minimum width per tier, in CSS pixels of the PANEL (not the viewport). */
export const TIER_MIN_WIDTH = { t1: 0, t2: 680, t3: 980, t4: 1280 }

/** Human labels, used by the layout switch's tooltips. */
export const TIER_LABEL = {
  t1: '紧凑',
  t2: '标准',
  t3: '宽',
  t4: '超宽',
}

/**
 * Tier for a panel width.
 *
 * Uses the panel's own width, never `window.innerWidth`: the panel may be docked
 * at 620px inside a 1920px viewport, floated at 1100px, or scaled — so a media
 * query would answer a different question than the one being asked.
 */
export function tierFor(width) {
  const value = Number(width)
  if (Number.isFinite(value) === false || value <= 0) return 't1'
  if (value >= TIER_MIN_WIDTH.t4) return 't4'
  if (value >= TIER_MIN_WIDTH.t3) return 't3'
  if (value >= TIER_MIN_WIDTH.t2) return 't2'
  return 't1'
}

/* ================================ layout =============================== */

/** `auto` follows the tier; the other three pin a specific layout. */
export const LAYOUT_MODES = ['auto', 'single', 'split', 'tri']

/** What each mode renders. */
export const LAYOUT_KINDS = ['single', 'split', 'tri']

export const LAYOUT_STORAGE_KEY = 'dsh-workbay-dock.layout.v1'

/** Unknown / missing modes fall back to `auto`, never to a guess. */
export function normalizeLayoutMode(mode) {
  return LAYOUT_MODES.includes(mode) ? mode : 'auto'
}

/**
 * Resolve the layout to render.
 *
 * `auto` maps t1/t2 -> single, t3 -> split, t4 -> tri. A manual choice wins at
 * every tier: pinning `tri` at 520px is a legitimate (if cramped) request, and
 * silently overriding a user's choice is worse than honouring it.
 */
export function resolveLayout(tier, mode) {
  const chosen = normalizeLayoutMode(mode)
  if (chosen !== 'auto') return chosen
  const known = TIERS.includes(tier) ? tier : 't1'
  if (known === 't4') return 'tri'
  if (known === 't3') return 'split'
  return 'single'
}

/** Read a persisted mode. Storage is optional so tests can pass a stub. */
export function readLayoutMode(storage) {
  try {
    const raw = storage === undefined || storage === null ? null : storage.getItem(LAYOUT_STORAGE_KEY)
    return normalizeLayoutMode(raw === null ? undefined : raw)
  } catch {
    return 'auto'
  }
}

export function writeLayoutMode(storage, mode) {
  const value = normalizeLayoutMode(mode)
  try {
    if (storage !== undefined && storage !== null && typeof storage.setItem === 'function') {
      storage.setItem(LAYOUT_STORAGE_KEY, value)
    }
  } catch {
    /* a full quota must not break the panel */
  }
  return value
}

/* =========================== recent workspaces ========================= */

export const RECENT_STORAGE_KEY = 'dsh-workbay-dock.recent.v1'
export const RECENT_LIMIT = 8

/**
 * Canonical form used for DE-DUPLICATION only.
 *
 * Windows paths are case-insensitive and may arrive with mixed separators from
 * three different sources (file picker, git output, host workspace), so the
 * comparison key lowercases the drive letter and folds `\` into `/`. The list
 * still stores the ORIGINAL string: rewriting the user's path would be wrong.
 */
export function pathKey(value) {
  const raw = value === undefined || value === null ? '' : String(value).trim()
  if (raw === '') return ''
  let key = raw.replace(/\\/g, '/')
  while (key.length > 1 && key.endsWith('/')) key = key.slice(0, -1)
  /* Lowercase only the drive letter (`D:` / `d:`), not the whole path: two
     directories that differ by case are distinct on a case-sensitive share. */
  if (/^[a-zA-Z]:/.test(key)) key = key[0].toLowerCase() + key.slice(1)
  return key
}

/** Basename of a path, for the row title. Never returns an empty label. */
export function baseName(value) {
  const raw = value === undefined || value === null ? '' : String(value).trim()
  if (raw === '') return ''
  const parts = raw.replace(/\\/g, '/').split('/').filter((part) => part !== '')
  return parts.length === 0 ? raw : parts[parts.length - 1]
}

/** Normalize one entry; returns null when there is nothing usable. */
export function normalizeRecentEntry(entry) {
  if (entry === null || typeof entry !== 'object') return null
  const rawPath = typeof entry.path === 'string' ? entry.path.trim() : ''
  const key = pathKey(rawPath)
  if (key === '') return null
  const name = typeof entry.name === 'string' && entry.name !== '' ? entry.name : baseName(rawPath)
  const at = Number.isFinite(entry.at) ? entry.at : 0
  return { path: rawPath, name, pinned: entry.pinned === true, at }
}

/**
 * Push a workspace onto the recent list.
 *
 * Rules (all four are tested):
 *   - the same path (by `pathKey`) is moved to the front, never duplicated;
 *   - `pinned` entries sort before unpinned ones, each group by recency;
 *   - the list is capped at `limit`, and PINNED entries are never evicted —
 *     an unpinned tail is dropped instead;
 *   - the caller's array is not mutated.
 */
export function pushRecent(list, entry, options) {
  const limit = Number.isFinite(options === undefined ? NaN : options.limit) && options.limit > 0
    ? Math.floor(options.limit)
    : RECENT_LIMIT
  const next = normalizeRecentEntry(entry)
  if (next === null) return Array.isArray(list) ? [...list] : []
  const at = Number.isFinite(options === undefined ? NaN : options.at) ? options.at : Date.now()
  const withStamp = { ...next, at: at }
  const key = pathKey(withStamp.path)
  const rest = (Array.isArray(list) ? list : [])
    .map(normalizeRecentEntry)
    .filter((item) => item !== null && pathKey(item.path) !== key)
  const merged = [withStamp, ...rest]
  merged.sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
    return right.at - left.at
  })
  if (merged.length <= limit) return merged
  /* Keep every pinned entry, then fill the remaining slots from the recency
     order. Slicing blind would evict a pinned workspace the user asked to keep. */
  const pinned = merged.filter((item) => item.pinned)
  const restSlots = Math.max(0, limit - pinned.length)
  const unpinned = merged.filter((item) => item.pinned === false).slice(0, restSlots)
  const kept = new Set([...pinned, ...unpinned])
  return merged.filter((item) => kept.has(item))
}

/** Flip the pin flag of one workspace; unknown paths are a no-op. */
export function togglePinned(list, targetPath) {
  const key = pathKey(targetPath)
  if (key === '') return Array.isArray(list) ? [...list] : []
  return (Array.isArray(list) ? list : []).map((item) => {
    const entry = normalizeRecentEntry(item)
    if (entry === null || pathKey(entry.path) !== key) return item
    return { ...entry, pinned: entry.pinned !== true }
  })
}

export function readRecent(storage) {
  try {
    const raw = storage === undefined || storage === null ? null : storage.getItem(RECENT_STORAGE_KEY)
    if (raw === null) return []
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed) === false) return []
    const cleaned = parsed.map(normalizeRecentEntry).filter((item) => item !== null)
    cleaned.sort((left, right) => {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
      return right.at - left.at
    })
    return cleaned.slice(0, RECENT_LIMIT)
  } catch {
    return []
  }
}

export function writeRecent(storage, list) {
  const value = (Array.isArray(list) ? list : []).map(normalizeRecentEntry).filter((item) => item !== null)
  try {
    if (storage !== undefined && storage !== null && typeof storage.setItem === 'function') {
      storage.setItem(RECENT_STORAGE_KEY, JSON.stringify(value))
    }
  } catch {
    /* quota / private mode must not break the panel */
  }
  return value
}

/* ================================ tokens =============================== */

/**
 * `--wb-*` derived from the host's `--dsw-alias-*` so every page reads one set of
 * names. Values are `var(--dsw-alias-x, fallback)` — the fallbacks are the ones
 * the panels already carried, so a host that omits a token still looks right.
 */
export const TOKENS = {
  '--wb-bg-base': 'var(--dsw-alias-bg-base, #14161a)',
  '--wb-bg-1': 'var(--dsw-alias-bg-layer-1, #1b1e24)',
  '--wb-bg-2': 'var(--dsw-alias-bg-layer-2, #22262c)',
  '--wb-line-1': 'var(--dsw-alias-border-l1, rgba(255,255,255,.08))',
  '--wb-line-2': 'var(--dsw-alias-border-l2, rgba(255,255,255,.14))',
  '--wb-text': 'var(--dsw-alias-label-primary, #e6e6e6)',
  '--wb-text-2': 'var(--dsw-alias-label-secondary, #b6bac1)',
  '--wb-text-3': 'var(--dsw-alias-label-tertiary, #8a8f98)',
  '--wb-brand': 'var(--dsw-alias-brand-primary, #4d6bfe)',
  '--wb-ok': 'var(--dsw-alias-state-success-primary, #3fb950)',
  '--wb-warn': 'var(--dsw-alias-state-warn-primary, #e2a03f)',
  '--wb-err': 'var(--dsw-alias-state-error-primary, #ff6b6b)',
}

/** `:root{--wb-…}` for injection into the panel's <style>. */
export function tokensCss(selector) {
  const scope = typeof selector === 'string' && selector !== '' ? selector : ':root'
  const body = Object.entries(TOKENS).map(([name, value]) => `${name}:${value}`).join(';')
  return `${scope}{${body}}`
}

/* ============================== primitives ============================= */

/**
 * Build the shared DOM primitives against an injected `h` (React.createElement in
 * the browser). Injected rather than imported so this file stays dependency-free
 * and the tests can pass a recorder.
 *
 *   const ui = createUi(E)
 *   ui.button({ variant: 'primary', onClick }, '提交')
 */
export function createUi(h) {
  if (typeof h !== 'function') throw new Error('createUi needs a createElement function')

  const cx = (...parts) => parts.filter((part) => typeof part === 'string' && part !== '').join(' ')

  function button(props, ...children) {
    const source = props === undefined || props === null ? {} : props
    const variant = source.variant === undefined ? 'default' : source.variant
    return h('button', {
      type: 'button',
      className: cx('wb-btn', variant === 'default' ? '' : 'is-' + variant, source.className),
      title: source.title,
      disabled: source.disabled === true,
      onClick: source.onClick,
    }, ...children)
  }

  function iconButton(props, glyph) {
    const source = props === undefined || props === null ? {} : props
    return h('button', {
      type: 'button',
      className: cx('wb-iconBtn', source.active === true ? 'is-active' : '', source.danger === true ? 'is-danger' : '', source.className),
      title: source.title,
      'aria-label': source.title,
      disabled: source.disabled === true,
      onClick: source.onClick,
    }, glyph)
  }

  function chip(props, ...children) {
    const source = props === undefined || props === null ? {} : props
    return h('span', { className: cx('wb-chip', source.kind === undefined ? '' : 'is-' + source.kind, source.className), title: source.title }, ...children)
  }

  function segmented(props, items) {
    const source = props === undefined || props === null ? {} : props
    const list = Array.isArray(items) ? items : []
    return h('div', { className: cx('wb-seg', source.className) }, ...list.map((item) => h('button', {
      key: item.id,
      type: 'button',
      className: cx('wb-segBtn', item.id === source.value ? 'is-on' : ''),
      'aria-pressed': item.id === source.value,
      onClick: source.onChange === undefined ? undefined : () => source.onChange(item.id),
    }, item.label)))
  }

  return { cx, button, iconButton, chip, segmented }
}
