/**
 * Reasoning-effort reconciliation for pool-routed requests.
 *
 * `reasoningEffort` is a property of the *model*, and the router's whole job is
 * to change which model a request uses. So the effort that DSH resolved for its
 * own model cannot simply be carried across: DSH validates the pair before it
 * dispatches, and an unsupported combination is thrown away as
 * `UNSUPPORTED_REASONING_EFFORT` — `provider "X" model "Y" does not support
 * reasoning effort "Z"`. A failover that dies on the way out is worse than no
 * failover at all.
 *
 * The rule is therefore: **keep the operator's effort when the chosen model
 * accepts it, and otherwise drop it** so DSH falls back to that model's own
 * default (`requested ?? reasoning.defaultEffort`). Dropping is the safe
 * direction — an absent effort is always valid — while keeping it is what
 * preserves an explicit setting where it can be honoured.
 *
 * Capabilities come from `llm.resolveModelInfo`, which is the same call DSH
 * itself makes, and are cached per route: a capability does not change between
 * two requests a second apart, and this runs in the request path.
 *
 * @module src/effort
 */

/** How long a resolved capability set is trusted. */
export const EFFORT_CACHE_TTL_MS = 5 * 60_000

/** Bound on remembered routes, so a long-lived host cannot grow this. */
export const EFFORT_CACHE_MAX = 200

/** How long one capability lookup may take before it is abandoned. */
export const EFFORT_LOOKUP_TIMEOUT_MS = 5_000

/**
 * Read the effort ids a resolved model accepts.
 *
 * @param {unknown} info an `LlmResolvedModelInfo`
 * @returns {Set<string> | undefined} `undefined` when the model advertises no
 *   reasoning at all — which is the case DSH rejects any requested effort for.
 */
export function supportedEfforts(info) {
  const efforts = info?.reasoning?.efforts
  if (!Array.isArray(efforts)) return undefined
  const ids = new Set()
  for (const effort of efforts) {
    const id = typeof effort?.id === 'string' ? effort.id.trim() : ''
    if (id !== '') ids.add(id)
  }
  return ids
}

/**
 * Build the reconciler.
 *
 * @param {{
 *   resolveLlm?: () => any,
 *   log?: (message: string) => void,
 *   ttlMs?: number,
 *   max?: number,
 *   timeoutMs?: number,
 *   now?: () => number,
 * }} [deps]
 * @returns {(route: { provider: string, model: string }, current: { provider?: string, model?: string, reasoningEffort?: unknown }) => Promise<string | undefined>}
 */
export function createEffortReconciler(deps = {}) {
  const resolveLlm = deps.resolveLlm ?? (() => undefined)
  const log = deps.log ?? (() => {})
  const ttlMs = deps.ttlMs ?? EFFORT_CACHE_TTL_MS
  const max = deps.max ?? EFFORT_CACHE_MAX
  const timeoutMs = deps.timeoutMs ?? EFFORT_LOOKUP_TIMEOUT_MS
  const now = deps.now ?? (() => Date.now())

  /**
   * `undefined` here means "we could not learn", which is different from "the
   * model accepts nothing": both drop the effort, so they share a slot.
   *
   * @type {Map<string, { at: number, efforts: Set<string> | undefined }>}
   */
  const cache = new Map()

  /** @param {string} key */
  async function lookup(key, provider, model) {
    const cached = cache.get(key)
    if (cached !== undefined && now() - cached.at < ttlMs) return cached.efforts

    const llm = resolveLlm()
    if (llm === undefined || typeof llm.resolveModelInfo !== 'function') {
      // The service is absent or too old to expose this. Trust it for the TTL:
      // asking again on every request would cost more than the answer is worth.
      cache.set(key, { at: now(), efforts: undefined })
      return undefined
    }

    let timer
    try {
      const info = await Promise.race([
        llm.resolveModelInfo(provider, model),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
          timer.unref?.()
        }),
      ])
      const efforts = supportedEfforts(info)
      cache.set(key, { at: now(), efforts })
      return efforts
    } catch (error) {
      // An unresolvable model is not this module's problem to report: DSH will
      // say so itself, and dropping the effort keeps the request valid meanwhile.
      log(`model-auto-router: could not read reasoning support for ${provider}/${model}: ${error instanceof Error ? error.message : String(error)}`)
      cache.set(key, { at: now(), efforts: undefined })
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }

  /** @param {string} key */
  function evict(key) {
    if (cache.size > max) cache.delete(key)
  }

  return async function reconcile(route, current) {
    const requested = typeof current?.reasoningEffort === 'string' ? current.reasoningEffort.trim() : ''
    // Nothing was asked for, so there is no combination to make valid.
    if (requested === '') return undefined

    // The router did not move the request: DSH resolved this exact pair itself,
    // so the effort it holds is already known-good and needs no second opinion.
    if (route.provider === current?.provider && route.model === current?.model) return requested

    const key = `${route.provider}/${route.model}`
    const efforts = await lookup(key, route.provider, route.model)
    evict(key)
    if (efforts === undefined) return undefined
    return efforts.has(requested) ? requested : undefined
  }
}
