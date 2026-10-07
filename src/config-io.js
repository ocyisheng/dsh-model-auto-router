/**
 * Reading, validating and writing the router's JSON config file.
 *
 * The settings page is not a second source of truth: it edits this same file,
 * through the same normalization the router already runs. That is why everything
 * here is pure and takes its file access as an injected pair of callbacks —
 * there is no `node:fs` in this module, so it stays testable and the browser
 * harness can load it unchanged.
 *
 * The one rule everything else follows: **a key whose name starts with `$` is a
 * comment and survives a round trip.** `model-auto-router.config.json` documents
 * itself that way, and an editor that silently dropped those keys on the first
 * save would destroy the file's own documentation.
 */

/** Strategies the UI offers, mirroring `STRATEGIES` in pool.js. */
export const UI_STRATEGIES = /** @type {const} */ ([
  'primary-failover',
  'round-robin',
  'least-used',
  'random',
  'weighted-random',
])

/** The keys a config may carry; everything else is dropped on save. */
const TOP_LEVEL_KEYS = ['enabled', 'mainPool', 'subagentPool', 'fallbackPool', 'inheritMain', 'health', 'pools']

/** Field bounds, so a typo cannot wedge the router into an unusable state. */
export const LIMITS = {
  failureThreshold: { min: 1, max: 100 },
  cooldownMs: { min: 1000, max: 86_400_000 },
  weight: { min: 0.01, max: 1000 },
}

const DEFAULT_CONFIG = {
  enabled: true,
  mainPool: 'main',
  subagentPool: '',
  fallbackPool: 'backup',
  inheritMain: true,
  health: { failureThreshold: 2, cooldownMs: 60_000 },
  pools: {
    main: { provider: 'deepseek', strategy: 'primary-failover', candidates: [{ model: 'deepseek-chat' }] },
    subagent: { provider: 'deepseek', strategy: 'round-robin', candidates: [{ model: 'deepseek-chat' }] },
    backup: { strategy: 'primary-failover', candidates: [{ provider: 'deepseek', model: 'deepseek-chat' }] },
  },
}

/** @param {unknown} value */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Coerce a number field, reporting a rejection instead of silently clamping.
 *
 * Clamping is the wrong answer for a settings page: a user who typed `0` into
 * the cooldown box needs to be told, not to end up with the default.
 *
 * @param {unknown} raw
 * @param {{ min: number, max: number }} bounds
 * @param {string} field dotted path, for the message
 * @param {{ integer?: boolean }} [options] weights are fractional; counts are not
 * @returns {{ ok: true, value: number } | { ok: false, error: string }}
 */
function readNumber(raw, bounds, field, options = {}) {
  const value = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim())
  if (!Number.isFinite(value)) return { ok: false, error: `${field}: "${raw}" is not a number` }
  if (options.integer !== false && !Number.isInteger(value)) {
    return { ok: false, error: `${field}: ${value} must be a whole number` }
  }
  if (value < bounds.min || value > bounds.max) return { ok: false, error: `${field}: ${value} is outside ${bounds.min}–${bounds.max}` }
  return { ok: true, value }
}

/**
 * Validate one pool's candidates.
 *
 * Mirrors `normalizeCandidate`: a bare string is only legal when the pool
 * supplies a provider, because there is nothing else for it to fall back to.
 *
 * @param {unknown} raw
 * @param {string} poolName
 * @param {string} defaultProvider
 * @returns {{ ok: true, candidates: Array<Record<string, any>> } | { ok: false, error: string }}
 */
function readCandidates(raw, poolName, defaultProvider) {
  if (!Array.isArray(raw)) return { ok: false, error: `pools.${poolName}.candidates must be an array` }
  if (raw.length === 0) return { ok: true, candidates: [] }

  const candidates = []
  for (const [index, entry] of raw.entries()) {
    const where = `pools.${poolName}.candidates[${index}]`
    if (typeof entry === 'string') {
      const model = entry.trim()
      if (model === '') return { ok: false, error: `${where}: the model name is empty` }
      if (!defaultProvider) return { ok: false, error: `${where}: "${model}" needs a provider — set one on the pool or on the model` }
      candidates.push({ provider: defaultProvider, model })
      continue
    }
    if (!isPlainObject(entry)) return { ok: false, error: `${where}: must be a model name or an object` }

    const model = typeof entry.model === 'string' ? entry.model.trim() : ''
    if (model === '') return { ok: false, error: `${where}: the model name is empty` }
    const provider = typeof entry.provider === 'string' && entry.provider.trim() !== '' ? entry.provider.trim() : defaultProvider
    if (!provider) return { ok: false, error: `${where}: "${model}" needs a provider — set one on the pool or on the model` }

    const candidate = { provider, model }
    if (entry.weight !== undefined) {
      // A weight is a ratio, not a count, so it is the one numeric field here
      // that legitimately carries a fraction.
      const weight = readNumber(entry.weight, LIMITS.weight, `${where}.weight`, { integer: false })
      if (!weight.ok) return weight
      // A weight of 1 is the default, and writing it out would make every row
      // look tuned when nothing was.
      if (weight.value !== 1) candidate.weight = weight.value
    }
    candidates.push(candidate)
  }
  return { ok: true, candidates }
}

/**
 * Validate a whole config draft.
 *
 * Returns every problem found rather than the first, because fixing a settings
 * page one error at a time is miserable.
 *
 * @param {unknown} raw the draft from the UI
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateConfig(raw) {
  /** @type {string[]} */
  const errors = []
  if (!isPlainObject(raw)) return { ok: false, errors: ['the config must be a JSON object'] }

  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    errors.push('enabled: must be true or false')
  }

  for (const key of ['mainPool', 'subagentPool', 'fallbackPool']) {
    const value = raw[key]
    if (value !== undefined && typeof value !== 'string') errors.push(`${key}: must be a pool name`)
  }
  if (raw.inheritMain !== undefined && typeof raw.inheritMain !== 'boolean') {
    errors.push('inheritMain: must be true or false')
  }

  if (raw.health !== undefined) {
    if (!isPlainObject(raw.health)) {
      errors.push('health: must be an object')
    } else {
      if (raw.health.failureThreshold !== undefined) {
        const result = readNumber(raw.health.failureThreshold, LIMITS.failureThreshold, 'health.failureThreshold')
        if (!result.ok) errors.push(result.error)
      }
      if (raw.health.cooldownMs !== undefined) {
        const result = readNumber(raw.health.cooldownMs, LIMITS.cooldownMs, 'health.cooldownMs')
        if (!result.ok) errors.push(result.error)
      }
    }
  }

  if (raw.pools !== undefined) {
    if (!isPlainObject(raw.pools)) {
      errors.push('pools: must be an object mapping a name to a pool')
    } else {
      for (const [name, pool] of Object.entries(raw.pools)) {
        if (name.trim() === '') { errors.push('pools: a pool name is empty'); continue }
        if (!isPlainObject(pool)) { errors.push(`pools.${name}: must be an object`); continue }
        const provider = typeof pool.provider === 'string' ? pool.provider.trim() : ''
        if (pool.strategy !== undefined && !UI_STRATEGIES.includes(/** @type {any} */ (pool.strategy))) {
          errors.push(`pools.${name}.strategy: "${pool.strategy}" is not one of ${UI_STRATEGIES.join(', ')}`)
        }
        const candidates = readCandidates(pool.candidates, name, provider)
        if (!candidates.ok) errors.push(candidates.error)
      }
    }
  }

  // Role pointers are only meaningful against pools that exist. This is a warning
  // in spirit, but it is the single most common misconfiguration — a pool
  // renamed while `mainPool` still points at the old name routes nothing — so
  // it is reported as an error and blocks the save.
  const names = isPlainObject(raw.pools) ? Object.keys(raw.pools) : []
  for (const key of ['mainPool', 'subagentPool', 'fallbackPool']) {
    const value = raw[key]
    if (typeof value !== 'string' || value === '') continue
    if (!names.includes(value)) errors.push(`${key}: there is no pool called "${value}"`)
  }

  return { ok: errors.length === 0, errors }
}

/**
 * Project a config file into the shape the settings page edits.
 *
 * Missing keys get their defaults, so a fresh install shows a working
 * configuration the user can save as-is.
 *
 * @param {Record<string, any>} [raw]
 * @returns {{
 *   config: Record<string, any>,
 *   unknownKeys: string[],
 *   existed: boolean,
 * }}
 */
export function toDraft(raw) {
  const source = isPlainObject(raw) ? raw : {}

  const pools = {}
  const declaredPools = isPlainObject(source.pools) ? source.pools : {}
  for (const [name, pool] of Object.entries(declaredPools)) {
    if (!isPlainObject(pool)) continue
    const poolProvider = typeof pool.provider === 'string' ? pool.provider.trim() : ''
    const candidates = Array.isArray(pool.candidates)
      ? pool.candidates
        .map(entry => {
          // A bare string inherits the pool's provider, so the editor shows it
          // as inheriting rather than as a value the user has to maintain.
          if (typeof entry === 'string') return { provider: '', model: entry.trim(), weight: 1 }
          if (!isPlainObject(entry)) return null
          const own = typeof entry.provider === 'string' ? entry.provider.trim() : ''
          return {
            // Restating the pool's own provider is the same route as inheriting
            // it. Collapsing the two here is what makes load → save → load a
            // fixed point: without it the first save rewrites `provider` away,
            // the next load shows something different, and the page reports
            // unsaved changes nobody made.
            provider: own === poolProvider ? '' : own,
            model: typeof entry.model === 'string' ? entry.model.trim() : '',
            weight: entry.weight === undefined ? 1 : Number(entry.weight),
          }
        })
        .filter(candidate => candidate && candidate.model !== '')
        .map(candidate => ({ ...candidate, weight: normalizeWeight(candidate.weight) }))
      : []
    pools[name] = {
      provider: poolProvider,
      strategy: UI_STRATEGIES.includes(/** @type {any} */ (pool.strategy)) ? pool.strategy : 'primary-failover',
      candidates,
    }
  }

  const health = isPlainObject(source.health) ? source.health : {}
  // The roster the page will actually show: what the file declares, or the
  // starter set when it declares nothing. Role defaults resolve against *this*,
  // not against the file's keys — resolving against an empty declaration would
  // leave a fresh install with every role unset.
  const finalPools = Object.keys(pools).length > 0 ? pools : structuredCopy(DEFAULT_CONFIG.pools)
  const poolNames = Object.keys(finalPools)

  // A role pointer is only defaulted to a pool that actually exists. Defaulting
  // `fallbackPool` to "backup" on a file whose only pool is "main" would make
  // the page load a config it then refuses to save — a validation error the
  // user never caused and cannot explain. An unset role stays unset, and the
  // page shows "(none)".
  const roleDefault = (raw, preferred) => {
    if (typeof raw === 'string') return raw
    return preferred !== undefined && poolNames.includes(preferred) ? preferred : ''
  }

  const config = {
    enabled: source.enabled !== false,
    mainPool: roleDefault(source.mainPool, DEFAULT_CONFIG.mainPool),
    subagentPool: roleDefault(source.subagentPool, undefined),
    fallbackPool: roleDefault(source.fallbackPool, DEFAULT_CONFIG.fallbackPool),
    inheritMain: source.inheritMain !== false,
    health: {
      failureThreshold: normalizeBound(health.failureThreshold, LIMITS.failureThreshold, 2),
      cooldownMs: normalizeBound(health.cooldownMs, LIMITS.cooldownMs, 60_000),
    },
    pools: finalPools,
  }

  const unknownKeys = Object.keys(source).filter(key => !key.startsWith('$') && !TOP_LEVEL_KEYS.includes(key))

  return { config, unknownKeys, existed: isPlainObject(raw) }
}

/**
 * Turn a draft back into the exact object the file stores.
 *
 * Empty optional values are omitted rather than written as `""`, so a role the
 * user left unassigned disappears from the file instead of becoming a dangling
 * pointer the validator would then reject on the next load.
 *
 * @param {Record<string, any>} draft
 * @returns {Record<string, any>}
 */
export function fromDraft(draft) {
  const out = { enabled: draft.enabled !== false }

  for (const key of ['mainPool', 'subagentPool', 'fallbackPool']) {
    const value = typeof draft[key] === 'string' ? draft[key].trim() : ''
    if (value !== '') out[key] = value
  }
  if (draft.inheritMain === false) out.inheritMain = false

  out.health = {
    failureThreshold: numberOr(draft.health?.failureThreshold, 2),
    cooldownMs: numberOr(draft.health?.cooldownMs, 60_000),
  }

  out.pools = {}
  for (const [name, pool] of Object.entries(draft.pools ?? {})) {
    if (!isPlainObject(pool)) continue
    const key = String(name).trim()
    if (key === '') continue
    const provider = typeof pool.provider === 'string' ? pool.provider.trim() : ''
    const entry = {
      strategy: UI_STRATEGIES.includes(/** @type {any} */ (pool.strategy)) ? pool.strategy : 'primary-failover',
      candidates: [],
    }
    if (provider !== '') entry.provider = provider
    for (const candidate of Array.isArray(pool.candidates) ? pool.candidates : []) {
      // A bare model name is legal in the file, so it has to be legal in a
      // draft too. Skipping it would silently delete a route the caller did
      // send — a save that reports success while dropping a pool member.
      if (typeof candidate === 'string') {
        const model = candidate.trim()
        if (model !== '') entry.candidates.push({ model })
        continue
      }
      if (!isPlainObject(candidate)) continue
      const model = typeof candidate.model === 'string' ? candidate.model.trim() : ''
      if (model === '') continue
      const own = typeof candidate.provider === 'string' ? candidate.provider.trim() : ''
      const weight = normalizeWeight(candidate.weight)
      // Write the candidate's provider only when it differs from the pool's.
      // The shorthand `{ model }` is what the shipped sample uses, and printing
      // the pool provider on every row would turn a two-line pool into a wall of
      // repetition the user then has to keep in sync by hand.
      const row = { model }
      if (own !== '' && own !== provider) row.provider = own
      if (weight !== 1) row.weight = weight
      entry.candidates.push(row)
    }
    out.pools[key] = entry
  }

  return out
}

/**
 * Fold the previous file's comment keys back into a freshly built config.
 *
 * A `$`-prefixed key is documentation, and the shipped sample leans on it
 * heavily — at the top level, and nested inside `health` (`$comment_threshold`,
 * `$comment_cooldown`). A browser form has no idea those keys existed, so
 * without this the very first save from the settings page would delete the
 * file's own explanation of itself.
 *
 * The merge walks the two objects together and copies every `$` key from the
 * previous value ahead of the new one's own keys, so the ordering the sample
 * uses (documentation first, then the value it describes) is what comes back
 * out. Arrays are taken from the new value whole: a candidate list is a list of
 * routes, and a comment inside one would not survive being matched to a row the
 * user has since reordered anyway.
 *
 * Only `$` keys are carried over. A non-comment key this page does not manage is
 * *dropped*, deliberately: resurrecting one from the old file would make a value
 * the user just deleted in the page reappear on the next save. The top-level
 * ones are reported to the page so the loss is visible before it happens.
 *
 * @param {any} next
 * @param {any} previous
 * @returns {any}
 */
export function preserveComments(next, previous) {
  if (!isPlainObject(next) || !isPlainObject(previous)) return next

  const out = {}
  for (const [key, value] of Object.entries(previous)) {
    if (key.startsWith('$')) out[key] = value
  }
  for (const [key, value] of Object.entries(next)) {
    out[key] = isPlainObject(value) ? preserveComments(value, previous[key]) : value
  }
  return out
}

/**
 * List the comment keys a file carries, for the page's "these are kept" note.
 *
 * @param {Record<string, any>} [raw]
 * @returns {string[]}
 */
export function commentKeysOf(raw) {
  if (!isPlainObject(raw)) return []
  return Object.keys(raw).filter(key => key.startsWith('$'))
}

/**
 * Serialize a config for the file.
 *
 * @param {Record<string, any>} config
 * @returns {string}
 */
export function serializeConfig(config) {
  return `${JSON.stringify(config, null, 2)}\n`
}

/**
 * Read the config file through injected file access.
 *
 * Mirrors the host entry's tolerance: a missing or malformed file is reported,
 * never thrown, because a typo in a settings file must degrade to "DSH behaves
 * normally" rather than taking the page down.
 *
 * @param {{
 *   read: (path: string) => string | undefined,
 *   exists?: (path: string) => boolean,
 * }} io
 * @param {string} path
 * @returns {{ ok: boolean, config: Record<string, any>, error?: string, existed: boolean }}
 */
export function readConfig(io, path) {
  let text
  try {
    if (io.exists && !io.exists(path)) return { ok: true, config: {}, existed: false }
    text = io.read(path)
  } catch (error) {
    return { ok: false, config: {}, existed: true, error: `could not read ${path}: ${message(error)}` }
  }
  if (text === undefined) return { ok: true, config: {}, existed: false }

  const trimmed = String(text).trim()
  // A file that exists but is empty is a fresh install, not a parse error.
  if (trimmed === '') return { ok: true, config: {}, existed: true }

  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    return { ok: false, config: {}, existed: true, error: `${path} is not valid JSON: ${message(error)}` }
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, config: {}, existed: true, error: `${path} must contain a JSON object` }
  }
  return { ok: true, config: parsed, existed: true }
}

/**
 * Write the config file through injected file access, refusing malformed drafts.
 *
 * Validation happens here rather than in the route so that no caller — the
 * settings page, a test, or a future CLI — can reach the disk with a config the
 * router would reject on its next load.
 *
 * @param {{ write: (path: string, text: string) => void }} io
 * @param {string} path
 * @param {Record<string, any>} draft
 * @param {Record<string, any>} [previous] the file as it is now, for comment retention
 * @returns {{ ok: true, config: Record<string, any> } | { ok: false, errors: string[] }}
 */
export function writeConfig(io, path, draft, previous) {
  const validation = validateConfig(draft)
  if (!validation.ok) return { ok: false, errors: validation.errors }

  const config = preserveComments(fromDraft(draft), previous)
  try {
    io.write(path, serializeConfig(config))
  } catch (error) {
    return { ok: false, errors: [`could not write ${path}: ${message(error)}`] }
  }
  return { ok: true, config }
}

/** @param {unknown} error */
function message(error) {
  return error instanceof Error ? error.message : String(error)
}

/** @param {unknown} value */
function structuredCopy(value) {
  return JSON.parse(JSON.stringify(value))
}

/** @param {unknown} value */
function numberOr(value, fallback) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
}

/** @param {unknown} value */
function normalizeWeight(value) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return 1
  return Math.round(parsed * 100) / 100
}

/**
 * @param {unknown} value
 * @param {{ min: number, max: number }} bounds
 * @param {number} fallback
 */
function normalizeBound(value, bounds, fallback) {
  const result = readNumber(value, bounds, 'value')
  return result.ok ? result.value : fallback
}
