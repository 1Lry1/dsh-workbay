/**
 * dsh-workbay-source-control — host half.
 *
 * This page is a CLIENT page. Everything it shows comes from two routes that
 * already exist and that it does not own:
 *
 *   POST /dsh-workbay-files/api/tree       -> the directory listing
 *   POST /dsh-gitcraft/api/snapshot        -> branch + changed files
 *   POST /dsh-gitcraft/api/stage|unstage|commit|discard
 *
 * Owning no routes is deliberate. The alternative — re-implementing the file API
 * or the git RPC here — would duplicate the security fences (`resolveInside`, the
 * realpath containment check) and the per-repository write lock, and the first
 * bug in a duplicated fence is a sandbox escape. Reusing the two existing hosts
 * also means this page inherits their same-origin trust fence for free, because
 * they are mounted on the same web server.
 *
 * So what is this file for?
 *
 *   1. DSH loads a bundle through a Node entry; a client-only plugin still needs
 *      one that exports `apply`.
 *   2. It publishes a tiny diagnostic surface so that "the page is blank" has an
 *      answerable cause. The page depends on two OTHER plugins, and a missing one
 *      is by far the most likely install error — being able to ask the host which
 *      dependency is missing beats guessing from the browser console.
 */

import { mountJsonApi } from '@dsh-workbay/kit'

export const name = 'dsh-workbay-source-control'

/* Requiring `webServer` only. The page cannot function without the other two
   bundles, but requiring them HERE would make this bundle fail to mount — and
   then the page would never register, i.e. no tab and no explanation. Failing
   soft (a page that renders an actionable empty state) beats failing hard. */
export const inject = ['webServer']

const ROUTE_PREFIX = '/dsh-workbay-source-control/api'

/** The two plugins this page renders data from. */
const DEPENDENCIES = [
  { id: 'dsh-workbay-files', provides: 'file tree + editor pane', route: '/dsh-workbay-files/api' },
  { id: 'dsh-gitcraft', provides: 'git decorations + diff pane', route: '/dsh-gitcraft/api' },
]

/**
 * Ask the web server which dependency prefixes are actually registered.
 *
 * Reads the ROUTE TABLE rather than config: a profile can list a plugin that
 * failed to mount, and "installed" is not "mounted". A mounted JSON-RPC prefix
 * answers a bare GET with 400/405 (never 404), so a non-404 proves registration.
 *
 * Returns `null` when the server cannot be asked at all — reporting "unknown" is
 * better than inventing an answer.
 */
async function probeDependencies(ctx) {
  const server = ctx === null || ctx === undefined ? undefined : ctx.webServer
  if (server === undefined || server === null) return null
  /* `fetch` is the only portable way to hit our own routes from here; DSH's
     webServer exposes it on some builds and not others. */
  const localFetch = typeof server.fetch === 'function' ? server.fetch.bind(server) : null
  if (localFetch === null) return null
  const results = []
  for (const dep of DEPENDENCIES) {
    try {
      const res = await localFetch(dep.route, { method: 'GET' })
      const status = res !== null && res !== undefined && typeof res.status === 'number' ? res.status : 0
      results.push({ id: dep.id, provides: dep.provides, mounted: status !== 0 && status !== 404 })
    } catch (error) {
      void error
      results.push({ id: dep.id, provides: dep.provides, mounted: null })
    }
  }
  return results
}

export function apply(ctx) {
  const METHODS = {
    /**
     * Liveness + dependency report. This is the first thing to call when the
     * page renders but shows nothing.
     */
    async status() {
      const dependencies = await probeDependencies(ctx)
      const missing = dependencies === null
        ? []
        : dependencies.filter((dep) => dep.mounted === false).map((dep) => dep.id)
      return {
        service: name,
        dependencies,
        /* `null` means "could not determine" — say so instead of claiming ok. */
        allMounted: dependencies === null ? null : missing.length === 0,
        missing,
        hint: missing.length === 0
          ? 'All dependencies are mounted.'
          : 'Enable these in the same profile: ' + missing.join(', '),
      }
    },
  }
  mountJsonApi(ctx, { prefix: ROUTE_PREFIX, methods: METHODS, label: name })
}
