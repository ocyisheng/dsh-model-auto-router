/**
 * dsh-model-auto-router — autonomous model pool routing with automatic failover.
 *
 * Host entry. Two responsibilities:
 *
 *  1. Install the `agent/request` and `agent/request-error` waterfalls that
 *     choose a route per request and switch away from an unavailable one.
 *  2. Load configuration from an external JSON file so pools can be edited
 *     without touching the profile patch, with hot reload on change.
 *
 * The config may also be supplied inline through the entry's own Config
 * (see `mergeInlineConfig`); the file wins on conflict.
 */

import { readFileSync, statSync, existsSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { ModelAutoRouter } from './src/router.js'
import { runSelfTest } from './src/selftest.js'
import { API_PREFIX, createApiRoutes } from './src/api.js'
import { createCatalogReader, createRouteObserver } from './src/catalog.js'
import { createEffortReconciler } from './src/effort.js'

export const name = 'dsh-model-auto-router'

/**
 * Inline Config for the profile entry (all fields optional):
 *
 *   configPath  absolute path to a JSON config file.
 *               Defaults to ~/.dsh/model-auto-router.json
 *   watch       watch that file and reload pools on change. Default true.
 *   router      inline config merged underneath the file's contents.
 *   enabled     set false to leave DSH's own model selection untouched.
 *   ui          mount the settings page. Default true where a web server
 *               exists; set false to run headless with routing only.
 *   selfTest    run the behavioural suite in-process at boot.
 *   selfTestOut write the self test report to this path.
 *
 * @typedef {{
 *   configPath?: string,
 *   watch?: boolean,
 *   router?: Record<string, unknown>,
 *   enabled?: boolean,
 *   ui?: boolean,
 *   selfTest?: boolean,
 *   selfTestOut?: string,
 * }} Config
 */

// Bump to force HMR reload of this module.
export const build = '1.1.0'

const DEFAULT_CONFIG_PATH = join(homedir(), '.dsh', 'model-auto-router.json')

/**
 * The subset of the host context this plugin touches.
 *
 * Declared structurally so the plugin loads in any DSH composition and stays
 * unit-testable without the real services.
 *
 * @typedef {object} HostContext
 * @property {{ get(id: string): unknown } | undefined} [agents]
 * @property {(services: string[], callback: (host: any) => void) => void} inject
 * @property {(callback: () => void, label?: string) => void} effect
 * @property {(event: string, listener: (...args: any[]) => unknown) => () => void} on
 * @property {Record<string, ((message: string) => void) | undefined> | undefined} [logger]
 */

/**
 * Read the JSON config file, tolerating a missing one.
 *
 * A malformed file must not take the host down: we log once and keep routing
 * inactive, so a typo degrades to "DSH behaves normally" rather than a boot
 * failure.
 *
 * @param {string} path
 * @param {(message: string) => void} log
 * @returns {Record<string, any>}
 */
function readConfigFile(path, log) {
  if (!existsSync(path)) {
    log(`model-auto-router: no config at ${path}; routing inactive (DSH model selection untouched)`)
    return {}
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      log(`model-auto-router: ${path} must contain a JSON object; ignoring it`)
      return {}
    }
    return parsed
  } catch (error) {
    log(`model-auto-router: failed to parse ${path}: ${describeError(error)}`)
    return {}
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Cheap change detector: size + mtime, without reading file contents.
 *
 * @param {string} path
 * @returns {string}
 */
function fileStamp(path) {
  try {
    const stat = statSync(path)
    return `${stat.size}:${stat.mtimeMs}`
  } catch {
    return 'missing'
  }
}

/**
 * Entry point invoked by the Cordis loader.
 *
 * @param {any} ctx cordis host context
 * @param {Config} [config]
 */
export function apply(ctx, config = {}) {
  const log = message => (ctx.logger?.info ? ctx.logger.info(message) : console.log(message))
  const warn = message => (ctx.logger?.warn ? ctx.logger.warn(message) : console.warn(message))

  const router = new ModelAutoRouter({ log: message => warn(message) })

  // Opt-in self test: run the behavioural suite in-process and write the
  // outcome to `selfTestOut`, so a headless install can be verified without a
  // test runner on PATH.
  if (config.selfTest || process.env.DSH_MODEL_AUTO_ROUTER_SELFTEST === '1') {
    const summary = runSelfTest()
    log(`model-auto-router: self test ${summary.passed}/${summary.total} passed`)
    for (const result of summary.results) {
      if (!result.ok) warn(`model-auto-router: self test FAILED — ${result.name}: ${result.error}`)
    }
    if (config.selfTestOut) {
      try {
        writeFileSync(config.selfTestOut, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
        log(`model-auto-router: self test report written to ${config.selfTestOut}`)
      } catch (error) {
        warn(`model-auto-router: could not write self test report: ${describeError(error)}`)
      }
    }
  }

  const configPath = config.configPath ?? DEFAULT_CONFIG_PATH
  const watch = config.watch !== false

  const loadInto = () => {
    const merged = { ...(config.router ?? {}), ...readConfigFile(configPath, log) }
    if (config.enabled !== undefined && merged.enabled === undefined) merged.enabled = config.enabled
    try {
      router.configure(merged)
    } catch (error) {
      // Never let a bad pool definition abort the boot; the host keeps running.
      warn(`model-auto-router: invalid configuration, routing disabled: ${describeError(error)}`)
      router.configure({ enabled: false })
    }
  }

  // Records the `provider/model` pairs this host actually dispatches. The
  // settings page offers them as model choices, which is what makes the page
  // useful on a machine whose adapters decline to describe themselves — the
  // routing lane sees every call, so it knows what works without asking.
  const observedRoutes = createRouteObserver()

  // The router changes which model a request uses, but `reasoningEffort` was
  // resolved for DSH's own model — and DSH rejects an unsupported pair with
  // `UNSUPPORTED_REASONING_EFFORT` before dispatching. This keeps the effort
  // when the chosen model accepts it and drops it otherwise, so a failover can
  // never die on the way out.
  const reconcileEffort = createEffortReconciler({
    resolveLlm: () => ctx.get('llm'),
    log: warn,
  })

  loadInto()

  // Wire the routing waterfalls. `agents` is injected so the plugin also loads
  // in a headless composition that has no commands surface.
  ctx.inject(['agents'], host => {
    host.effect(() => {
      // `agent/request`: replace the frozen config for the coming step.
      const offRequest = host.on('agent/request', async (payload, next) => {
        const current = await next()
        try {
          const route = router.select(payload)
          // Record the route that is actually about to be used: the plugin's
          // choice when it made one, DSH's own otherwise. Both are real.
          observedRoutes.remember(route ?? current)
          if (!route) return current
          const next = { ...current, provider: route.provider, model: route.model }
          // The effort belongs to the model being used, and the model just
          // changed. Removing the key (rather than setting it to undefined) is
          // what lets DSH apply the chosen model's own default.
          const effort = await reconcileEffort(route, current)
          if (effort === undefined) delete next.reasoningEffort
          else next.reasoningEffort = effort
          return next
        } catch (error) {
          warn(`model-auto-router: selection failed, keeping DSH default: ${describeError(error)}`)
          return current
        }
      })

      // `agent/request-error`: demote an unavailable route and ask for a retry,
      // which re-enters `agent/request` and lands on the next candidate.
      const offError = host.on('agent/request-error', async (payload, next) => {
        let decision
        try {
          decision = router.handleFailure(payload)
        } catch {
          decision = undefined
        }
        // Returning `{ kind: 'retry' }` without calling next() means we own
        // recovery; anything else is delegated to the built-in retry policy.
        return decision ? decision : next()
      })

      // Release per-session state when a session goes away.
      const offDisposed = host.on('agent/disposed', payload => {
        router.forget(payload?.agent?.id)
      })

      return () => {
        offRequest()
        offError()
        offDisposed()
      }
    }, 'model-auto-router: routing')
  })

  // The settings page. It lives in its own fiber so a composition with no web
  // server — a headless install, a test composition — simply never mounts the
  // routes, and one with a web server gets them without the routing lane above
  // being able to fail on an unrelated concern.
  if (config.ui !== false) {
    ctx.inject(['webServer'], host => {
      // The inventory is read through the host's own `llm` registry, resolved
      // per call: a composition may publish that service after this plugin
      // loads, and a pool naming a provider that is not mounted yet is a
      // legitimate state, not a failure.
      const catalog = createCatalogReader({
        resolveLlm: () => (typeof ctx.get === 'function' ? ctx.get('llm') : undefined),
        observed: () => observedRoutes.list(),
        // The one route the host is configured to use, available before any
        // request has been made — so the page has at least one real suggestion
        // the very first time it is opened.
        defaults: () => {
          const selection = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : undefined
          return typeof selection?.currentSelection === 'function' ? selection.currentSelection() : undefined
        },
        log,
      })

      const api = createApiRoutes({
        router,
        configPath,
        version: build,
        catalog,
        io: {
          read: path => (existsSync(path) ? readFileSync(path, 'utf8') : undefined),
          exists: existsSync,
          // Written to a sibling and renamed into place. The config watcher is
          // polling this same path on a timer, so a plain in-place write can be
          // observed half-finished — and the watcher would then log a parse
          // error for a file that was never actually broken. A rename is atomic
          // on every platform this ships to, so the watcher only ever sees a
          // complete document.
          write: (path, text) => {
            const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`)
            try {
              writeFileSync(temporary, text, 'utf8')
              renameSync(temporary, path)
            } catch (error) {
              // Never leave the scratch file behind for the next run to find.
              try { rmSync(temporary, { force: true }) } catch { /* best effort */ }
              throw error
            }
          },
        },
        log,
        warn,
        // Resolved per request, not once here: the browser half publishes the
        // connection service after plugins load, so reading it at apply time
        // would freeze in "absent" and leave every settings request on the
        // structural fence for the life of the process.
        connection: {
          get admit() {
            const current = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
            return current === undefined ? undefined : req => current.admit(req)
          },
        },
      })
      host.effect(
        () => host.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: api }),
        'model-auto-router: settings API',
      )
      log(`model-auto-router: settings API mounted at ${API_PREFIX}`)
    })
  }

  // Hot reload. DSH's hmr service already reloads this module when its own
  // files change; for the plain JSON config we poll the file stamp so pool
  // edits take effect without restarting the host.
  if (watch) {
    let stamp = fileStamp(configPath)
    ctx.effect(() => {
      const timer = setInterval(() => {
        const current = fileStamp(configPath)
        if (current === stamp) return
        stamp = current
        log(`model-auto-router: ${configPath} changed, reloading pools`)
        loadInto()
      }, 5000)
      // Never hold the process open for a config watcher.
      timer.unref?.()
      return () => clearInterval(timer)
    }, 'model-auto-router: config watcher')
  }

  // The Cordis context is a sealed proxy, so the router cannot be attached to
  // it as a property. Export it through a module-level accessor instead, which
  // diagnostics and integration tests read via `activeRouter()`.
  setActiveRouter(router)
}

/** @type {ModelAutoRouter | undefined} */
let activeRouterInstance

/**
 * The router installed by the most recent `apply`, if the plugin is loaded.
 * @returns {ModelAutoRouter | undefined}
 */
export function activeRouter() {
  return activeRouterInstance
}

/**
 * @param {ModelAutoRouter | undefined} router
 */
function setActiveRouter(router) {
  activeRouterInstance = router
}
