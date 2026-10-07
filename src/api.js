/**
 * The settings page's HTTP surface.
 *
 * Three routes, and deliberately no more:
 *
 *   GET  /state    the router's live state plus the config as an editable draft
 *   GET  /catalog  the provider/model routes this host can actually dispatch
 *   PUT  /config   validate a draft, write the file, and hot-reload the pools
 *   GET  /report   the same text `/model-auto-router status` prints, for copy-paste
 *
 * The page edits the config *file*, never the router's internals: a save goes
 * through `writeConfig`, the file watcher notices, and the pools reload on the
 * same path a hand edit takes. That is what keeps the file and the live router
 * from drifting apart, and it is why a save is a plain file write rather than a
 * mutation API on the router.
 *
 * `/catalog` is separate from `/state` on purpose. State is polled every few
 * seconds; interrogating every adapter is not something to do on a timer, so the
 * inventory is a route the page asks for on its own schedule and the host caches.
 *
 * Written against plain `req`/`res` objects so the whole surface is testable
 * without an HTTP server.
 */

import { commentKeysOf, readConfig, toDraft, validateConfig, writeConfig } from './config-io.js'
import { rejectionFor } from './trust.js'

/** The path this module is mounted at; the handler strips it itself. */
export const API_PREFIX = '/api/model-auto-router'

/** The most a settings draft may weigh. Pools are small; this is generous. */
const MAX_BODY_BYTES = 256 * 1024

/**
 * Build the route handler.
 *
 * @param {{
 *   router: any,
 *   configPath: string,
 *   io: { read: (path: string) => string | undefined, exists: (path: string) => boolean, write: (path: string, text: string) => void },
 *   catalog: () => Promise<{ providers: Array<any>, declared: Array<any>, discoveredAt: number }>,
 *   log?: (message: string) => void,
 *   warn?: (message: string) => void,
 *   connection?: { admit?: (req: any) => any },
 *   version?: string,
 * }} deps
 */
export function createApiRoutes(deps) {
  const { router, configPath, io, log, warn, connection } = deps

  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const routePath = url.pathname.slice(API_PREFIX.length).replace(/\/+$/, '') || '/'
    const method = String(req.method ?? 'GET').toUpperCase()

    const send = (status, payload) => {
      const body = JSON.stringify(payload)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      })
      res.end(body)
    }

    const rejection = rejectionFor(req, connection)
    if (rejection !== undefined) {
      return send(rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
    }

    try {
      if (method === 'GET' && routePath === '/state') return send(200, buildState(deps))

      if (method === 'GET' && routePath === '/report') {
        return send(200, { text: router.report() })
      }

      if (method === 'GET' && routePath === '/catalog') {
        // Advice, not authority: a gather that throws answers an empty
        // inventory rather than failing the page, because free-text routes stay
        // valid with or without suggestions.
        try {
          return send(200, await deps.catalog())
        } catch (error) {
          warn?.(`model-auto-router: could not read the model catalog: ${error instanceof Error ? error.message : String(error)}`)
          return send(200, { providers: [], declared: [], discoveredAt: 0 })
        }
      }

      if ((method === 'PUT' || method === 'POST') && routePath === '/config') {
        const draft = await readJson(req)
        if (!isPlainObject(draft)) return send(400, { error: 'the request body must be a config object' })

        // The file as it stands is the only source of the `$comment` keys, so it
        // is read here and handed to the writer for retention. Comments live
        // only in the file; a browser form has no idea they existed, and
        // dropping them would delete the file's own documentation.
        const current = readConfig(io, configPath)
        const previous = current.ok ? current.config : undefined

        const result = writeConfig(io, configPath, draft, previous)
        if (!result.ok) return send(400, { errors: result.errors })

        // The watcher reloads within its poll interval, but the page should not
        // have to wait for it to show the pools it just saved — so the pools are
        // reloaded here and the response carries the state the router is in
        // *now*. A bad pool definition is caught by the router's own configure
        // and logged, exactly as it is for a hand-edited file.
        const applied = applyConfig(router, result.config, warn)
        log?.(`model-auto-router: config saved by the settings page (${configPath})`)
        return send(200, { ok: true, state: buildState({ ...deps, router: applied }) })
      }

      return send(404, { error: `no route ${method} ${routePath}` })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // A malformed body is the caller's bug and must read as 400/413, not as a
      // plugin failure — the page distinguishes the two when it decides whether
      // to say "fix this field" or "the backend is broken".
      const status = typeof (/** @type {any} */ (error)?.status) === 'number' ? /** @type {any} */ (error).status : 500
      if (status >= 500) warn?.(`model-auto-router: settings API error: ${message}`)
      return send(status, { error: message })
    }
  }
}

/**
 * Assemble everything the page renders in one round trip.
 *
 * A save response reuses this rather than a narrower shape, so the page has
 * exactly one code path for "here is the current truth" — a partial response
 * after a save is how a page ends up rendering the config it sent rather than
 * the config the router accepted.
 */
function buildState(deps) {
  const { router, configPath, io, version } = deps
  const file = readConfig(io, configPath)
  const draft = toDraft(file.ok ? file.config : undefined)

  return {
    version: version ?? '',
    configPath,
    fileExists: file.existed,
    fileError: file.ok ? '' : (file.error ?? ''),
    config: draft.config,
    // Named for the page's "these are kept on save" note. Only the names are
    // sent: the values are documentation for a human reading the file, and the
    // page has nothing to render them into.
    commentKeys: commentKeysOf(file.ok ? file.config : undefined),
    unknownKeys: draft.unknownKeys,
    runtime: router.snapshot(),
    // The file on disk and the router in memory can disagree for up to one
    // poll interval, and after a hand edit that gap is worth naming.
    validation: validateConfig(draft.config),
  }
}

/**
 * Push a validated config into the router, degrading to disabled rather than
 * throwing, so a bad save never leaves the host routing with half a config.
 */
function applyConfig(router, config, warn) {
  try {
    router.configure(config)
    return router
  } catch (error) {
    warn?.(`model-auto-router: saved config is invalid, routing disabled: ${error instanceof Error ? error.message : String(error)}`)
    router.configure({ enabled: false })
    return router
  }
}

/** @param {unknown} value */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Read a JSON body, bounded.
 *
 * A body that was sent but is not JSON is a client bug, not an empty request:
 * answering `{}` would turn a broken save into a silent 200 that wipes the
 * config to defaults.
 */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw badRequest(413, 'request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch (error) {
    throw badRequest(400, `invalid JSON body: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** @param {number} status @param {string} message */
function badRequest(status, message) {
  const error = new Error(message)
  // @ts-expect-error — a status carrier on an Error is the smallest way to get
  // the right code out of the catch above without a custom error class.
  error.status = status
  return error
}
