/**
 * Model pool configuration, normalization, and route selection.
 *
 * A "candidate" is one concrete provider/model route the router may choose.
 * A "pool" is a named group of candidates. Selection is per-request, driven by
 * the `agent/request` waterfall, so it applies identically to the main agent
 * and to every subagent (they differ only by which pool the config assigns).
 *
 * Everything here is pure and synchronous: no I/O, no clock, no host access.
 * That keeps the routing decision unit-testable and makes failover trivially
 * reproducible (see tests/ for the behavioural matrix).
 */

/** Selection strategies a pool may use. */
export const STRATEGIES = /** @type {const} */ ([
  'primary-failover',
  'round-robin',
  'least-used',
  'random',
  'weighted-random',
])

const DEFAULT_STRATEGY = 'primary-failover'

/**
 * Normalize one candidate declaration.
 *
 * Accepts both a full route (`{ provider, model }`) and the `{ model }` form
 * when the pool supplies a shared `provider` default, mirroring how the stock
 * default-model config reads.
 *
 * @param {unknown} raw
 * @param {string} scope human-readable context for error messages
 * @param {string} [defaultProvider]
 * @returns {{ provider: string, model: string, weight: number, label: string } | undefined}
 */
export function normalizeCandidate(raw, scope, defaultProvider) {
  if (raw == null) return undefined

  if (typeof raw === 'string') {
    const model = raw.trim()
    if (!model) return undefined
    if (!defaultProvider) {
      throw new TypeError(`${scope}: candidate "${model}" needs a provider (string candidates require a pool-level provider)`)
    }
    return { provider: defaultProvider, model, weight: 1, label: `${defaultProvider}/${model}` }
  }

  if (typeof raw !== 'object') {
    throw new TypeError(`${scope}: candidate must be a string or an object, received ${typeof raw}`)
  }

  const record = /** @type {Record<string, unknown>} */ (raw)
  const model = typeof record.model === 'string' ? record.model.trim() : ''
  const provider = typeof record.provider === 'string'
    ? record.provider.trim()
    : (defaultProvider ?? '')

  if (!model) return undefined
  if (!provider) {
    throw new TypeError(`${scope}: candidate "${model}" is missing a provider`)
  }

  const weight = normalizeWeight(record.weight)
  return { provider, model, weight, label: record.label ? String(record.label) : `${provider}/${model}` }
}

/**
 * Clamp a declared weight to a usable positive number.
 * @param {unknown} raw
 * @returns {number}
 */
function normalizeWeight(raw) {
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(value) || value <= 0) return 1
  return value
}

/**
 * Expand the configured pool model into a normalized runtime shape.
 *
 * @param {unknown} raw the `pools` map from config
 * @param {{ log?: (message: string) => void }} [io]
 */
export function normalizePools(raw, io = {}) {
  /** @type {Map<string, { name: string, strategy: string, candidates: Array<{provider:string,model:string,weight:number,label:string}> }>} */
  const pools = new Map()

  if (raw == null) return pools
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('pools must be an object mapping pool names to pool definitions')
  }

  for (const [name, value] of Object.entries(raw)) {
    const scope = `pools.${name}`
    if (value == null) continue
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError(`${scope}: pool definition must be an object`)
    }

    const def = /** @type {Record<string, unknown>} */ (value)
    const defaultProvider = typeof def.provider === 'string' ? def.provider.trim() : undefined
    const strategy = normalizeStrategy(def.strategy)
    const declared = Array.isArray(def.candidates) ? def.candidates : []
    const source = declared.length > 0 ? declared : (Array.isArray(def.models) ? def.models : [])

    const candidates = []
    const seen = new Set()
    for (const entry of source) {
      const candidate = normalizeCandidate(entry, scope, defaultProvider)
      if (!candidate) continue
      const key = `${candidate.provider}/${candidate.model}`
      if (seen.has(key)) {
        io.log?.(`${scope}: duplicate candidate ${key} ignored`)
        continue
      }
      seen.add(key)
      candidates.push(candidate)
    }

    if (candidates.length === 0) continue
    pools.set(name, { name, strategy, candidates })
  }

  return pools
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeStrategy(raw) {
  const value = typeof raw === 'string' ? raw.trim() : ''
  return STRATEGIES.includes(/** @type {any} */ (value)) ? value : DEFAULT_STRATEGY
}

/**
 * Coerce a single-role config into the canonical pool shape.
 *
 * Accepts the shorthand `"model"`, the route object `{ provider, model }`, the
 * pool-like `{ provider, candidates: [...] }` (whose `strategy` is honoured), and
 * a plain array of either candidate form.
 *
 * @param {unknown} raw
 * @param {{ log?: (message: string) => void }} [io]
 */
export function normalizeSinglePool(raw, io = {}) {
  if (raw == null) return undefined

  // A pool-like object: `{ provider?, strategy?, candidates }`.
  if (typeof raw === 'object' && !Array.isArray(raw) && !('model' in raw)) {
    const def = /** @type {Record<string, unknown>} */ (raw)
    const provider = typeof def.provider === 'string' ? def.provider.trim() : undefined
    const strategy = normalizeStrategy(def.strategy)
    const declared = Array.isArray(def.candidates) ? def.candidates : Array.isArray(def.models) ? def.models : []
    const candidates = []
    const seen = new Set()
    for (const entry of declared) {
      const candidate = normalizeCandidate(entry, 'pool', provider)
      if (!candidate || seen.has(candidate.label)) continue
      seen.add(candidate.label)
      candidates.push(candidate)
    }
    return candidates.length === 0 ? undefined : { name: '_inline', strategy, candidates }
  }

  const provider = typeof raw === 'object' && !Array.isArray(raw)
    ? String(/** @type {Record<string, unknown>} */ (raw).provider ?? '')
    : ''
  // `normalizePools` only accepts an array, so wrap the single-route forms.
  const candidates = Array.isArray(raw) ? raw : [raw]
  const providerPool = normalizePools({ _default: { provider: provider || undefined, candidates } }, io)
  const pool = providerPool.get('_default')
  if (!pool) return undefined
  return { name: '_default', strategy: DEFAULT_STRATEGY, candidates: pool.candidates }
}

/**
 * Deterministic hash used by the "stable" strategies so one agent keeps one
 * route for its lifetime without storing per-agent state.
 *
 * FNV-1a over the agent id and pool name.
 *
 * @param {string} input
 * @returns {number} unsigned 32-bit
 */
export function stableHash(input) {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * Apply one pool's strategy to pick a candidate from the ordered, already
 * health-filtered list.
 *
 * @param {{ strategy: string, candidates: Array<any> }} pool
 * @param {{
 *   agentId?: string,
 *   preferred?: string,
 *   usage?: Map<string, number>,
 *   random?: () => number,
 * }} context
 * @returns {any | undefined}
 */
export function selectCandidate(pool, context = {}) {
  const { candidates } = pool
  if (candidates.length === 0) return undefined
  if (candidates.length === 1) return candidates[0]

  const preferred = context.preferred
  if (preferred) {
    const match = candidates.find(c => c.label === preferred)
    if (match) return match
  }

  switch (pool.strategy) {
    case 'round-robin': {
      // `usage` doubles as the per-pool cursor; both sides are plugin-private.
      const cursor = context.usage?.get(`rr:${pool.name}`) ?? 0
      context.usage?.set(`rr:${pool.name}`, cursor + 1)
      return candidates[cursor % candidates.length]
    }

    case 'least-used': {
      let best = candidates[0]
      let bestCount = context.usage?.get(best.label) ?? 0
      for (const candidate of candidates) {
        const count = context.usage?.get(candidate.label) ?? 0
        if (count < bestCount) {
          best = candidate
          bestCount = count
        }
      }
      return best
    }

    case 'random': {
      const random = context.random ?? Math.random
      return candidates[Math.floor(random() * candidates.length) % candidates.length]
    }

    case 'weighted-random': {
      const random = context.random ?? Math.random
      const total = candidates.reduce((sum, c) => sum + c.weight, 0)
      let threshold = random() * total
      for (const candidate of candidates) {
        threshold -= candidate.weight
        if (threshold < 0) return candidate
      }
      return candidates[candidates.length - 1]
    }

    case 'primary-failover':
    default: {
      // Pure priority order: the first candidate declared in the config is the
      // primary, and failover is what moves traffic down the list. Health
      // filtering upstream is what makes the next candidate reachable, so this
      // deliberately does not spread load — that is what `round-robin` and
      // `least-used` are for.
      return candidates[0]
    }
  }
}

/**
 * Order the candidates of one pool for failover: the route already in use
 * first, then the remaining pool order.
 *
 * @param {Array<{ label: string }>} candidates
 * @param {string | undefined} currentLabel
 * @returns {Array<any>}
 */
export function failoverChain(candidates, currentLabel) {
  if (!currentLabel) return [...candidates]
  const index = candidates.findIndex(c => c.label === currentLabel)
  if (index <= 0) return [...candidates]
  return [candidates[index], ...candidates.slice(0, index), ...candidates.slice(index + 1)]
}
