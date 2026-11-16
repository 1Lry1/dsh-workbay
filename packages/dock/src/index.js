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
import os from 'node:os'
import { createCpuReader, createGpuReader, sampleLoad } from './load.js'

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

/**
 * The load-meter readers live at MODULE scope, not inside `apply`.
 *
 * The CPU reader and the GPU reader are both stateful (baseline ticks, cached
 * GPU row), and that state has to survive across requests. Building them inside
 * `apply` would reset the baseline every time the profile is recomposed, so the
 * first reading after every restart would be `null`.
 *
 * They are also created once so the process runs at most one `nvidia-smi` at a
 * time: the reader's own busy gate is per-instance.
 */
const readCpu = createCpuReader({ nowMs: Date.now, readCpus: () => os.cpus() })
const readGpu = createGpuReader({ nowMs: Date.now })
const readMem = () => ({ total: os.totalmem(), free: os.freemem() })
const loadOnce = () => sampleLoad({ nowMs: Date.now, cpu: readCpu, readMem, gpu: readGpu })

const METHODS = {
  async ping() {
    return { ok: true, service: 'dsh-workbay-dock', pages: pageList().length }
  },
  async registry() {
    return { pages: pageList() }
  },
  /**
   * One CPU / GPU / MEM sample for the titlebar meter.
   *
   * Called only while the workbench panel is open AND its window is focused, so
   * there is no host-side timer anywhere: a closed workbench spawns nothing.
   * `cpu` is null on the first call (no baseline yet) and after a gap longer
   * than `BASELINE_TTL_MS`; the client retries once on null.
   */
  async load() {
    return loadOnce()
  },
}

export function apply(ctx) {
  /**
   * Restart the workbench without restarting DSH:
   *  - ask DSH's HMR service to recompose the profile, which reloads changed
   *    workbench bundles (host halves included) while the DSH process/session
   *    stays alive;
   *  - the client waits briefly, then reloads the page to pick up the new
   *    browser bundle.
   *
   * The reconcile is scheduled AFTER this response: it may replace the very
   * plugin serving this route, so it must not run while the response is still
   * being written. If HMR is not available the client must fall back to a full
   * DSH restart; returning a clear code keeps that decision in the UI.
   */
  const methods = {
    ...METHODS,
    async restart() {
      const hmr = typeof ctx.get === 'function' ? ctx.get('hmr') : undefined
      if (!hmr || typeof hmr.runExclusive !== 'function' || typeof hmr.reconcileProfile !== 'function') {
        return { ok: false, code: 'no-hmr', message: 'HMR is not available; a full DSH restart is required' }
      }
      const timer = setTimeout(() => {
        Promise.resolve()
          .then(() => hmr.runExclusive(() => hmr.reconcileProfile()))
          .then((result) => {
            if (result && result.restartReason) {
              try { ctx.logger?.warn?.('dsh-workbay-dock: restart needs DSH restart: ' + result.restartReason) } catch (error) { void error }
            }
          })
          .catch((error) => {
            try { ctx.logger?.error?.('dsh-workbay-dock: workbench restart failed: ' + String(error && error.message ? error.message : error)) } catch (err) { void err }
          })
      }, 300)
      if (typeof timer.unref === 'function') timer.unref()
      return { ok: true, scheduled: true }
    },
  }
  mountJsonApi(ctx, { prefix: ROUTE_PREFIX, methods, label: 'dsh-workbay-dock' })
  /* The page roster grows from other plugins' host halves; expose it as a
     service so a page plugin can announce itself without the browser. */
  if (typeof ctx.provide === 'function') {
    ctx.provide('workbenchDock', {
      registerPage,
      pages: pageList,
    })
  }
}
