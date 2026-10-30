/**
 * dsh-workbay-dock — host half.
 *
 * A deliberately thin host: the workbench's PAGES live in their own plugins, so
 * this half owns only what a host must own —
 *
 *   POST /dsh-workbay-dock/api/registry   -> the registered page ids + titles
 *   POST /dsh-workbay-dock/api/ping       -> liveness probe for tests
 *
 * The page registry itself is a CLIENT concern (pages are React components), so
 * this half exists mainly to give the bundle a Node entry that DSH can load and
 * that integration tests can hit. Nothing here talks to git or the filesystem.
 *
 * Route plumbing (trust fence, bounded body, envelope) comes from
 * @dsh-workbay/kit — see packages/kit/README.md.
 */

import { badRequest, mountJsonApi } from '@dsh-workbay/kit'

export const name = 'dsh-workbay-dock'
export const inject = ['webServer']

const ROUTE_PREFIX = '/dsh-workbay-dock/api'

/**
 * The page catalogue the client renders as tabs. Pages are declared here rather
 * than discovered from the browser: the browser half cannot enumerate other
 * plugins' React components, so each page plugin announces itself to the dock
 * through `ctx.workbenchDock.registerPage`, and the dock keeps the roster.
 */
const pages = new Map()

function registerPage(id, meta) {
  if (typeof id !== 'string' || id === '') throw badRequest('page id is required')
  pages.set(id, {
    id,
    title: typeof meta?.title === 'string' ? meta.title : id,
    order: Number.isFinite(meta?.order) ? meta.order : 100,
  })
  return () => { pages.delete(id) }
}

function pageList() {
  return [...pages.values()].sort((a, b) => a.order - b.order)
}

const METHODS = {
  async ping() {
    return { ok: true, service: 'dsh-workbay-dock', pages: pageList().length }
  },
  async registry() {
    return { pages: pageList() }
  },
}

export function apply(ctx) {
  mountJsonApi(ctx, { prefix: ROUTE_PREFIX, methods: METHODS, label: 'dsh-workbay-dock' })
  /* The page roster grows from other plugins' host halves; expose it as a
     service so a page plugin can announce itself without the browser. */
  if (typeof ctx.provide === 'function') {
    ctx.provide('workbenchDock', {
      registerPage,
      pages: pageList,
    })
  }
}
