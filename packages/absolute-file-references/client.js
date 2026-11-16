/**
 * Make the DSH `@` file picker insert ABSOLUTE host paths.
 *
 * The built-in reference source (package `@deepseek-ai/dsh-client-ui-reference`)
 * formats its candidates as workspace-relative paths, so a pick inserts
 * `@app/projects/.../build.bat`. This bundle wraps that source's `onPick` and
 * converts the settled file/folder mention to an absolute path using the
 * session's cwd. The chip label stays the short file name, and the model
 * receives the absolute path through the source's own `serialize` codec (which
 * returns the ref verbatim).
 *
 * Two shape decisions matter for the suite:
 *
 *   1. NO plugin-level `inject`. dsh-workbay-suite unions the `inject` arrays of
 *      every vendored client half into its own row, and a row that injects
 *      `inputTriggers`/`sessions` stays PENDING until those services exist — the
 *      whole workbench (dock, files, terminal, ...) would wait on them. This
 *      bundle therefore declares an empty inject and waits for the two services
 *      itself through `ctx.inject`, so the suite activates immediately and the
 *      wrapping starts the moment the picker is available.
 *   2. FAIL SOFT. Every failure path warns and leaves the relative path in
 *      place; a decoration must never break the picker.
 *
 * Session references (`@` other conversations), skill references and drill
 * actions are untouched.
 *
 * Runtime switch (no restart): set `localStorage['dsh-workbay.absolute-refs.v1']`
 * to `0` to get the stock relative behaviour back, `1` (or remove the key) to
 * turn the absolute paths on. It is read per pick, so the toggle is immediate.
 */
window.__ModuleLoader__.load({
  id: 'dsh-absolute-file-references',
  factory(require) {
    void require
    const TRIGGER = '@'
    const SOURCE = 'reference'
    const ENABLED_KEY = 'dsh-workbay.absolute-refs.v1'
    const NS = '[absolute-file-references]'

    /** Windows drive, UNC, or POSIX root. */
    function isAbsolutePath(value) {
      return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) || /^\//.test(value)
    }

    /** The runtime switch; anything but an explicit "off" value keeps it on. */
    function isEnabled() {
      try {
        const raw = window.localStorage.getItem(ENABLED_KEY)
        if (raw === null || raw === undefined) return true
        const value = String(raw).trim().toLowerCase()
        return value !== '0' && value !== 'off' && value !== 'false' && value !== 'no'
      } catch (error) {
        /* No storage (a test harness, a locked-down profile): stay on. */
        void error
        return true
      }
    }

    /**
     * @param {string} mention  `@rel`, `@"rel with space"`, or the open-quoted
     *                          `@"dir/` form a directory pick produces.
     * @param {string} cwd      the session working directory.
     * @returns {string} the absolute mention, or the input unchanged.
     */
    function toAbsoluteMention(mention, cwd) {
      if (typeof mention !== 'string' || mention.charAt(0) !== '@' || typeof cwd !== 'string' || cwd === '') {
        return mention
      }
      const quoted = mention.startsWith('@"')
      let body = quoted ? mention.slice(2) : mention.slice(1)
      let closed = false
      if (body.endsWith('"')) {
        closed = true
        body = body.slice(0, -1)
      }
      if (body === '' || isAbsolutePath(body)) return mention

      const trailingSlash = /[\\/]$/.test(body)
      const relative = body.replace(/[\\/]+$/, '')
      const base = cwd.replace(/[\\/]+$/, '')
      const absolute = base + '\\' + relative.replace(/\//g, '\\') + (trailingSlash ? '\\' : '')

      if (quoted) return '@"' + absolute + (closed ? '"' : '')
      if (/\s/.test(absolute)) return '@"' + absolute + '"'
      return '@' + absolute
    }

    /** Rewrite only a settled file/folder ReferenceInsert. */
    function rewriteOutcome(outcome, cwd) {
      if (outcome === undefined || outcome === null || outcome.insert === undefined || outcome.insert === null) {
        return outcome
      }
      const insert = outcome.insert
      if (insert.source !== SOURCE || insert.appearance === 'session') return outcome
      const next = toAbsoluteMention(insert.ref, cwd)
      if (next === insert.ref) return outcome
      return Object.assign({}, outcome, {
        insert: Object.assign({}, insert, { ref: next, clipboardText: next }),
      })
    }

    /**
     * Wrap the built-in `@` source in place. Wrapping is idempotent so a re-apply
     * (client HMR, or the suite mounting this half twice) never converts twice.
     */
    function wrapReferenceSource(source, cwdOf) {
      if (source === undefined || source === null) return false
      if (source.trigger !== TRIGGER || source.name !== SOURCE) return false
      if (typeof source.onPick !== 'function') return false
      if (source.__workbayAbsoluteRefs === true) return true
      const original = source.onPick
      try {
        source.onPick = function onPickWithAbsolutePaths(pick) {
          const outcome = original.call(this, pick)
          if (!isEnabled()) return outcome
          try {
            const sessionId = pick !== undefined && pick !== null && pick.session !== undefined ? pick.session.sessionId : undefined
            return rewriteOutcome(outcome, cwdOf(sessionId))
          } catch (error) {
            /* A pick must never fail because path decoration failed. */
            console.warn(NS + ' could not absolutize mention:', error)
            return outcome
          }
        }
        source.__workbayAbsoluteRefs = true
      } catch (error) {
        console.warn(NS + ' the @ source is not patchable:', error)
        return false
      }
      return true
    }

    /** Wire the wrapper onto the live service pair. */
    function mount(ctx, inputTriggers, sessions) {
      const cwdOf = (sessionId) => {
        try {
          const byId = sessions.list.getSnapshot().byId
          const summary = byId === undefined ? undefined : byId[sessionId]
          return summary !== undefined && summary !== null && typeof summary.cwd === 'string' ? summary.cwd : ''
        } catch (error) {
          void error
          return ''
        }
      }

      /* The service keeps its sources in a private `live` holder: there is no
         public enumeration API, but this is the same object the pipeline reads,
         so wrapping its entries is enough. */
      const sources = () => {
        const live = inputTriggers.live
        return live !== undefined && Array.isArray(live.sources) ? live.sources : null
      }
      const wrapAll = () => {
        const list = sources()
        if (list === null) return -1
        let wrapped = 0
        for (const source of list) {
          if (wrapReferenceSource(source, cwdOf)) wrapped += 1
        }
        return wrapped
      }

      if (wrapAll() === 0) {
        /* The picker had not registered its source yet; poll briefly. */
        let attempts = 0
        const timer = setInterval(() => {
          attempts += 1
          if (wrapAll() > 0 || attempts >= 40) clearInterval(timer)
        }, 250)
        ctx.effect(() => () => clearInterval(timer), 'absolute-file-references: wait for @ source')
      }

      /* Sources arriving after us (HMR, or another bundle) are wrapped at
         registration. registerSource is a plain instance method. */
      ctx.effect(() => {
        const original = inputTriggers.registerSource
        if (typeof original !== 'function') return () => {}
        try {
          inputTriggers.registerSource = function registerSource(source) {
            try { wrapReferenceSource(source, cwdOf) } catch (error) { void error }
            return original.call(this, source)
          }
        } catch (error) {
          console.warn(NS + ' could not wrap registerSource:', error)
          return () => {}
        }
        return () => {
          try { inputTriggers.registerSource = original } catch (error) { void error }
        }
      }, 'absolute-file-references: wrap late @ source')
    }

    return {
      /* Deliberately empty: see the file header. The suite unions this into its
         own row, and it must not hold the workbench back. */
      inject: [],
      name: 'dsh-absolute-file-references',
      apply(ctx) {
        if (typeof ctx.inject === 'function') {
          /* Deferred: cordis calls this once both services exist, and disposes
             the resulting effects with this plugin's fiber. */
          ctx.inject(['inputTriggers', 'sessions'], (serviceCtx) => {
            try {
              const inputTriggers = serviceCtx.get('inputTriggers')
              const sessions = serviceCtx.get('sessions')
              if (inputTriggers === undefined || inputTriggers === null) return
              if (sessions === undefined || sessions === null) return
              mount(serviceCtx, inputTriggers, sessions)
            } catch (error) {
              console.warn(NS + ' could not patch the @ picker:', error)
            }
          })
          return undefined
        }
        /* A context without inject() (an older shape, or a hand-built test
           harness): try the services directly, and do nothing if absent. */
        try {
          const inputTriggers = ctx.get('inputTriggers')
          const sessions = ctx.get('sessions')
          if (inputTriggers === undefined || inputTriggers === null) return undefined
          if (sessions === undefined || sessions === null) return undefined
          mount(ctx, inputTriggers, sessions)
        } catch (error) {
          console.warn(NS + ' could not patch the @ picker:', error)
        }
        return undefined
      },
      __test: { isAbsolutePath, isEnabled, toAbsoluteMention, rewriteOutcome, wrapReferenceSource, ENABLED_KEY },
    }
  },
})
