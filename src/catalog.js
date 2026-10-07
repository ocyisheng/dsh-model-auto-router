/**
 * The live provider/model inventory, for the pool editor.
 *
 * A pool names concrete `provider`/`model` routes, and until now the page asked
 * the operator to type both from memory. That is how a pool ends up describing a
 * route that can never be dispatched: a typo, a provider that was never mounted,
 * or a model id the adapter spells differently.
 *
 * Three sources feed the page, in descending order of authority:
 *
 *  1. **Observed** — routes this plugin watched the host actually dispatch. Real
 *     by construction: a request went out on that exact pair. Recorded by the
 *     routing lane itself, so it works even for an adapter that advertises
 *     nothing.
 *  2. **The agent's default selection** — one route the host is configured to use.
 *  3. **The `llm` catalog** — every registered provider and the models its
 *     adapter advertises. The broadest list, and the only one that can show
 *     models this machine has not used yet.
 *
 * Two rules shape everything here:
 *
 *  1. **This is advice, never authority.** The `llm` catalog is explicitly
 *     advisory in DSH's own contract ("catalog membership does not constrain
 *     core routing"), and a provider can be legitimately absent — disabled,
 *     temporarily unmounted, or intended for a different composition. So the
 *     inventory feeds *suggestions*; it never rejects a value.
 *  2. **One bad adapter must not sink the page.** Interrogating a provider is
 *     third-party I/O. Each one is bounded, and a provider that fails or hangs
 *     contributes an error note rather than an empty answer or a stalled route.
 *
 * @module src/catalog.js
 */

/** How long a gathered inventory is reused before adapters are asked again. */
export const CATALOG_TTL_MS = 60_000

/** One adapter that never answers must not hold the request open. */
export const MODEL_DISCOVERY_TIMEOUT_MS = 5_000

/** How many distinct routes the runtime observer remembers. */
export const MAX_OBSERVED_ROUTES = 200

/**
 * Record the routes this host actually dispatches.
 *
 * The routing lane sees every model call, which makes it the one part of the
 * system that can answer "what works here" without trusting an adapter's
 * self-description — and without depending on a log format that may change.
 *
 * @param {{ max?: number }} [options]
 * @returns {{
 *   remember: (route: { provider?: unknown, model?: unknown }) => void,
 *   list: () => Array<{ provider: string, model: string, count: number }>,
 * }}
 */
export function createRouteObserver(options = {}) {
  const max = options.max ?? MAX_OBSERVED_ROUTES
  /** @type {Map<string, { provider: string, model: string, count: number }>} */
  const seen = new Map()

  return {
    remember(route) {
      const provider = typeof route?.provider === 'string' ? route.provider.trim() : ''
      const model = typeof route?.model === 'string' ? route.model.trim() : ''
      // A call config may carry neither — an adapter default, or a request that
      // never reached a provider. Nothing is learned from those.
      if (provider === '' || model === '') return

      const key = `${provider}/${model}`
      const previous = seen.get(key)
      seen.set(key, { provider, model, count: (previous?.count ?? 0) + 1 })

      // Bounded, dropping the least-used route first: a long-lived host must not
      // grow this without limit, and the routes worth keeping are the ones that
      // keep being used.
      if (seen.size > max) {
        let victim
        let fewest = Infinity
        for (const [candidate, entry] of seen) {
          if (entry.count < fewest) { fewest = entry.count; victim = candidate }
        }
        if (victim !== undefined) seen.delete(victim)
      }
    },
    list() {
      return [...seen.values()]
        .sort((a, b) => b.count - a.count || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model))
    },
  }
}

/**
 * Coerce an adapter-supplied list into plain `{ id, name }` records.
 *
 * The adapter contract says the result is detached metadata, but a plugin is
 * still third-party code: anything that is not a usable entry is dropped rather
 * than propagated into the page as `undefined` rows.
 *
 * @param {unknown} raw
 * @returns {Array<{ id: string, name: string }>}
 */
export function normalizeModels(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const models = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const id = typeof (/** @type {any} */ (entry).id) === 'string' ? /** @type {any} */ (entry).id.trim() : ''
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    const name = typeof (/** @type {any} */ (entry).name) === 'string' && /** @type {any} */ (entry).name.trim() !== ''
      ? /** @type {any} */ (entry).name.trim()
      : id
    models.push({ id, name })
  }
  return models
}

/**
 * Assemble the page-facing inventory from already-gathered data.
 *
 * Pure, so the shape the page depends on is testable without a host.
 *
 * @param {{
 *   providers?: unknown,
 *   configurable?: unknown,
 *   models?: Record<string, unknown>,
 *   errors?: Record<string, string>,
 *   discoveredAt?: number,
 * }} input
 * @returns {{
 *   providers: Array<{ id: string, name: string, models: Array<{ id: string, name: string }>, error?: string }>,
 *   declared: Array<{ id: string, name: string }>,
 *   observed: Array<{ provider: string, model: string, count: number }>,
 *   defaults: { provider: string, model: string } | undefined,
 *   discoveredAt: number,
 * }}
 */
export function buildCatalog(input = {}) {
  const providers = []
  const seen = new Set()

  for (const entry of Array.isArray(input.providers) ? input.providers : []) {
    if (entry === null || typeof entry !== 'object') continue
    const id = typeof (/** @type {any} */ (entry).id) === 'string' ? /** @type {any} */ (entry).id.trim() : ''
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    const name = typeof (/** @type {any} */ (entry).name) === 'string' && /** @type {any} */ (entry).name.trim() !== ''
      ? /** @type {any} */ (entry).name.trim()
      : id
    /** @type {{ id: string, name: string, models: Array<{id:string,name:string}>, error?: string }} */
    const record = { id, name, models: normalizeModels(input.models?.[id]) }
    const error = input.errors?.[id]
    if (typeof error === 'string' && error !== '') record.error = error
    providers.push(record)
  }

  // Routes an adapter plugin owns but has not activated. Worth offering,
  // because naming one in a pool is exactly how it becomes usable — but they
  // are rendered apart from live providers, since they cannot dispatch yet.
  const declared = []
  const declaredSeen = new Set()
  for (const entry of Array.isArray(input.configurable) ? input.configurable : []) {
    if (entry === null || typeof entry !== 'object') continue
    const id = typeof (/** @type {any} */ (entry).provider) === 'string' ? /** @type {any} */ (entry).provider.trim() : ''
    if (id === '' || seen.has(id) || declaredSeen.has(id)) continue
    declaredSeen.add(id)
    const name = typeof (/** @type {any} */ (entry).displayName) === 'string' && /** @type {any} */ (entry).displayName.trim() !== ''
      ? /** @type {any} */ (entry).displayName.trim()
      : id
    declared.push({ id, name })
  }

  const observed = []
  const observedSeen = new Set()
  for (const route of Array.isArray(input.observed) ? input.observed : []) {
    const provider = typeof route?.provider === 'string' ? route.provider.trim() : ''
    const model = typeof route?.model === 'string' ? route.model.trim() : ''
    if (provider === '' || model === '') continue
    const key = `${provider}/${model}`
    if (observedSeen.has(key)) continue
    observedSeen.add(key)
    const count = Number(route?.count)
    observed.push({ provider, model, count: Number.isFinite(count) && count > 0 ? Math.trunc(count) : 1 })
  }

  return {
    providers,
    declared,
    observed,
    defaults: readSelection(input.defaults),
    // True when the `llm` registry itself could not be read, so the page can say
    // "these are the routes this machine has used" rather than implying the
    // shorter list is the whole inventory.
    catalogUnavailable: input.catalogUnavailable === true,
    discoveredAt: input.discoveredAt ?? 0,
  }
}

/**
 * Coerce the host's default model selection into one suggestion.
 * @param {unknown} raw
 * @returns {{ provider: string, model: string } | undefined}
 */
function readSelection(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const provider = typeof (/** @type {any} */ (raw).provider) === 'string' ? /** @type {any} */ (raw).provider.trim() : ''
  const model = typeof (/** @type {any} */ (raw).model) === 'string' ? /** @type {any} */ (raw).model.trim() : ''
  return provider === '' || model === '' ? undefined : { provider, model }
}

/**
 * Build a cached reader over the `llm` service.
 *
 * Caching matters: the page polls its state every few seconds, and re-asking
 * every adapter each time would turn a settings panel into a source of steady
 * outbound traffic. A rejected gather is not cached, so a transient failure is
 * retried on the next ask rather than frozen in for a minute.
 *
 * @param {{
 *   resolveLlm?: () => any,
 *   log?: (message: string) => void,
 *   observed?: () => Array<{ provider: string, model: string, count: number }>,
 *   defaults?: () => unknown,
 *   ttlMs?: number,
 *   timeoutMs?: number,
 *   now?: () => number,
 * }} [deps]
 * @returns {() => Promise<ReturnType<typeof buildCatalog>>}
 */
export function createCatalogReader(deps = {}) {
  const resolveLlm = deps.resolveLlm ?? (() => undefined)
  const log = deps.log ?? (() => {})
  const observed = deps.observed ?? (() => [])
  const defaults = deps.defaults ?? (() => undefined)
  const ttlMs = deps.ttlMs ?? CATALOG_TTL_MS
  const timeoutMs = deps.timeoutMs ?? MODEL_DISCOVERY_TIMEOUT_MS
  const now = deps.now ?? (() => Date.now())

  /** @type {{ at: number, value: ReturnType<typeof buildCatalog> } | undefined} */
  let cached
  /** @type {Promise<ReturnType<typeof buildCatalog>> | undefined} */
  let pending

  const gather = async () => {
    // Read both host-side sources before the adapter round trips: these are what
    // keep the page useful when every adapter declines to describe itself, which
    // is exactly when an operator is most stuck.
    let selection
    try {
      selection = defaults()
    } catch (error) {
      log(`model-auto-router: could not read the default model selection: ${error instanceof Error ? error.message : String(error)}`)
    }
    const observedRoutes = (() => {
      try {
        return observed()
      } catch {
        return []
      }
    })()

    const llm = resolveLlm()
    // A composition with no `llm` service mounted is not an error: the observed
    // routes and the default selection still reach the page.
    if (llm === undefined || typeof llm.listProviders !== 'function') {
      return buildCatalog({ observed: observedRoutes, defaults: selection, catalogUnavailable: true, discoveredAt: now() })
    }

    const providers = llm.listProviders()
    const configurable = typeof llm.listConfigurableProviders === 'function'
      ? llm.listConfigurableProviders()
      : []

    /** @type {Record<string, any>} */
    const models = {}
    /** @type {Record<string, string>} */
    const errors = {}

    await Promise.all((Array.isArray(providers) ? providers : []).map(async entry => {
      const id = entry?.id
      if (typeof id !== 'string' || id === '') return
      if (typeof llm.listModels !== 'function') return
      let timer
      try {
        const discovered = await Promise.race([
          llm.listModels(id),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
            // Never hold the host open for a discovery that nothing awaits.
            timer.unref?.()
          }),
        ])
        models[id] = discovered
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        errors[id] = message
        log(`model-auto-router: could not list models for provider "${id}": ${message}`)
      } finally {
        clearTimeout(timer)
      }
    }))

    return buildCatalog({ providers, configurable, models, errors, observed: observedRoutes, defaults: selection, discoveredAt: now() })
  }

  return async function read() {
    const at = now()
    if (cached !== undefined && at - cached.at < ttlMs) return cached.value
    if (pending !== undefined) return pending

    pending = gather().then(
      value => {
        cached = { at: now(), value }
        pending = undefined
        return value
      },
      error => {
        // Deliberately not cached: one bad gather must not pin an empty
        // inventory for the whole TTL.
        pending = undefined
        throw error
      },
    )
    return pending
  }
}
