/**
 * Route health tracking and failure classification.
 *
 * Two jobs:
 *  1. Decide whether a failure means "this route is unavailable, switch to a
 *     fallback" (a 401/429/5xx, a DNS failure, a model that no longer exists)
 *     or "retry the same route" (a transient blip the built-in retry policy
 *     already handles). Getting this wrong is the difference between a smooth
 *     failover and either a wasted retry storm or a premature demotion.
 *  2. Remember which routes are unhealthy so a request that arrives while a
 *     route is still cooling down skips it entirely instead of failing first.
 */

/** Outcome recorded for one route. */
export const HEALTH = /** @type {const} */ ({
  HEALTHY: 'healthy',
  UNHEALTHY: 'unhealthy',
})

/**
 * HTTP statuses that mean the route itself cannot serve the request right now.
 * Everything else (400 bad request, 401/403 auth) is about the *request*, and
 * switching models would only swap one wrong answer for another.
 */
const UNAVAILABLE_STATUS = new Set([
  402, // payment required / quota exhausted
  404, // model or endpoint no longer exists on this provider
  408, // request timeout
  409, // conflict
  425, // too early
  429, // rate limited
  500, 501, 502, 503, 504, 507, 508, 529, // upstream / overload
])

/**
 * Transport-level failure codes that mean the provider is unreachable.
 */
const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
])

/**
 * DSH/LLM failure codes that mean the model itself is unusable, regardless of
 * the HTTP status that carried it.
 */
const MODEL_UNAVAILABLE_CODES = new Set([
  'model_not_found',
  'model_not_supported',
  'model_overloaded',
  'model_unavailable',
  'model_deprecated',
  'deprecated_model',
  'model_retired',
  'model_removed',
  'no_provider',
  'unknown_provider',
  'unknown_model',
  'provider_unavailable',
  'insufficient_quota',
])

/** Codes that are always the caller's fault: never fail over, just surface. */
const REQUEST_FAULT_CODES = new Set([
  'invalid_request',
  'invalid_request_error',
  'bad_request',
  'context_length_exceeded',
  'content_policy',
  'permission_denied',
  'authentication_error',
  'invalid_api_key',
  'unsupported',
])

/**
 * Message shapes that mean "this model is gone", for providers that say so in
 * prose rather than in the failure code.
 *
 * This is not belt-and-braces: it is the only signal for the case that actually
 * happens. `dsh-our-free-model` classifies the gateway's
 * `Model X has been deprecated. Use Y instead.` as a generic `CLIENT_ERROR` /
 * `SERVER` (its `ModelError` branch matches `model is unavailable` and
 * `not supported`, not `deprecated`), and `toFailure` whitelists only
 * message/code/status — the `unavailable: true` flag it sets never reaches the
 * router. So the message is all there is to go on, and without this the router
 * leaves a retired model in place and the turn fails.
 *
 * The patterns stay anchored to a model being retired rather than matching the
 * word anywhere: a 400 complaining about a `deprecated_field` is a request
 * fault, and must keep failing rather than trigger a failover. The gap allows a
 * period inside a word — `mimo-v2.5-free`, `gpt-4.1` — and stops only at a
 * sentence end (`. ` or a newline); excluding every period would stop at the
 * version number and never reach the keyword.
 */
const MODEL_RETIRED_PATTERNS = [
  /\bmodel\b(?:(?!\.\s|\n)[\s\S]){0,120}?\b(deprecated|retired|decommissioned|removed|sunset|no longer (?:available|supported|served))\b/i,
  /\b(deprecated|retired|decommissioned|sunset)\b(?:(?!\.\s|\n)[\s\S]){0,60}?\bmodel\b/i,
]

/**
 * Codes that name the *provider's* side of the wire rather than the request's.
 *
 * `dsh-our-free-model` splits its vocabulary in two and says so in its own
 * source: `CLIENT_ERROR` for a 4xx ("the request's own fault: replaying the
 * identical body reproduces the identical refusal") and `SERVER` for everything
 * else — explicitly described there as the retryable bucket, which is why
 * `SERVER` must not be the fallback for a 4xx. The rest of its `CODE` table is
 * listed here for the same reason; each names a failure of the service, not of
 * the request.
 *
 * Without these, a 503 the adapter labels `SERVER` and carries no `status` for
 * reads as *not* unavailable, and the router leaves the route in place — which
 * is exactly how a plainly overloaded upstream ends a turn. The same goes for
 * `TRANSPORT` (`upstream request failed: fetch failed`), which really is
 * observed on this host.
 */
const SERVICE_FAULT_CODES = new Set([
  // `dsh-our-free-model`'s own CODE table.
  'transport', // a failed fetch
  'rate_limit', // quota
  'timeout',
  'empty_response',
  'server',
  // Generic server-side naming.
  'server_error',
  'internal_server_error',
  'internal_error',
  'service_unavailable',
  'service_error',
  'upstream_error',
  'gateway_error',
  'provider_error',
])

/**
 * The HTTP status a failure is *about*, when it is quoted in the message rather
 * than carried in `status`.
 *
 * This is not a nicety. An in-stream error envelope is classified with
 * `classifyFailure(undefined, payload)` — there is no status to pass — and the
 * adapter's `toFailure` whitelists only message/code/status, so what reaches the
 * router is
 *
 *     { code: 'SERVER',
 *       message: 'Streaming response failed: [503] Upstream error from Nvidia: Service temporarily overloaded' }
 *
 * The status is nowhere but the text, and a classifier that only reads `status`
 * sees an unknown failure.
 */
const MESSAGE_STATUS_PATTERNS = [
  /\[(\d{3})\]/, // [503]
  /\bHTTP[/ ](\d{3})\b/i, // HTTP 503, HTTP/503
  /\bstatus(?:Code)?[ :]+(\d{3})\b/i, // status 503, statusCode: 503
]

/**
 * Wording that means "the service could not serve this right now", for a failure
 * that carries neither a usable code nor a quoted status.
 */
const TRANSIENT_PATTERNS = [
  /temporarily (?:overloaded|unavailable|unable)/i,
  /service (?:is )?(?:temporarily )?(?:unavailable|overloaded)/i,
  /\boverloaded\b/i,
  /try again later/i,
  /upstream (?:error|failure|timeout)/i,
]

/**
 * Read the first HTTP status quoted in a failure message.
 *
 * @param {string} message
 * @returns {number | undefined}
 */
export function statusInMessage(message) {
  if (typeof message !== 'string' || message === '') return undefined
  for (const pattern of MESSAGE_STATUS_PATTERNS) {
    const match = pattern.exec(message)
    if (match === null) continue
    const status = Number(match[1])
    if (Number.isInteger(status) && status >= 100 && status <= 599) return status
  }
  return undefined
}

/**
 * Does this status mean the route should be set aside for a while?
 *
 * One predicate for the structured `status` and the quoted one, so the two can
 * never disagree about what a 429 or a 503 means.
 *
 * @param {number} status
 * @returns {boolean}
 */
function statusIsUnavailable(status) {
  if (UNAVAILABLE_STATUS.has(status)) return true
  if (status === 401 || status === 403) return false
  return status >= 500
}

/**
 * Classify one `LlmFailure` for the router.
 *
 * @param {{ code?: string, status?: number, message?: string }} failure
 * @returns {{ unavailable: boolean, reason: string }}
 */
export function classifyFailure(failure) {
  if (!failure || typeof failure !== 'object') {
    return { unavailable: false, reason: 'unknown' }
  }

  // Codes arrive in both conventions — `ECONNRESET`, `model_overloaded`,
  // `ModelOverloaded` — so compare with a case-folded lookup key on both sides.
  const raw = typeof failure.code === 'string' ? failure.code.trim() : ''
  const code = raw.toLowerCase()
  const upper = raw.toUpperCase()
  const status = typeof failure.status === 'number' ? failure.status : undefined
  const message = typeof failure.message === 'string' ? failure.message : ''

  if (REQUEST_FAULT_CODES.has(code)) {
    return { unavailable: false, reason: `request-fault:${raw}` }
  }

  // A model the provider says it has retired is unavailable whatever code
  // carried the news — checked before the code lookups so a generic
  // `CLIENT_ERROR` cannot bury it.
  //
  // It is deliberately *not* treated as gone forever: "deprecated" is the
  // provider's word for its own catalogue, and the same route can be serving
  // again later (a staged rollout, a message that overstates the change, an
  // upstream rotation). Writing it off harder than any other failure would also
  // quietly overrule the operator's `failureThreshold`, which exists to be the
  // single answer to "how many failures before the router moves on".
  if (MODEL_RETIRED_PATTERNS.some(pattern => pattern.test(message))) {
    return { unavailable: true, reason: 'model-retired' }
  }

  // A status quoted in the message, for the failures that arrive without one.
  // Read before the code lookups so a generic `SERVER` can neither hide a 503
  // nor promote a quoted 400.
  const quoted = statusInMessage(message)
  if (quoted !== undefined) {
    return statusIsUnavailable(quoted)
      ? { unavailable: true, reason: `status-in-message:${quoted}` }
      : { unavailable: false, reason: `status-in-message:${quoted}` }
  }

  if (MODEL_UNAVAILABLE_CODES.has(code) || SERVICE_FAULT_CODES.has(code)) {
    return { unavailable: true, reason: `model:${raw}` }
  }

  // Transport codes are conventionally upper case.
  if (UNAVAILABLE_CODES.has(upper)) {
    return { unavailable: true, reason: `transport:${upper}` }
  }

  if (TRANSIENT_PATTERNS.some(pattern => pattern.test(message))) {
    return { unavailable: true, reason: 'transient' }
  }

  if (status !== undefined) {
    return statusIsUnavailable(status)
      ? { unavailable: true, reason: `status:${status}` }
      : { unavailable: false, reason: `status:${status}` }
  }

  return { unavailable: false, reason: code ? `code:${code}` : 'unknown' }
}

/**
 * Coerce a config value to a positive integer, falling back when unusable.
 * @param {unknown} raw
 * @param {number} fallback
 * @returns {number}
 */
function positiveInt(raw, fallback) {
  const value = typeof raw === 'number' ? Math.trunc(raw) : Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * Track route health with a simple consecutive-failure threshold and cooldown.
 *
 * A route is demoted only after `failureThreshold` consecutive unavailable
 * failures so a single hiccup does not reshuffle everyone's model, and it
 * recovers automatically once `cooldownMs` has passed.
 */
export class RouteHealthTracker {
  /**
   * @param {{ failureThreshold?: number, cooldownMs?: number, successThreshold?: number }} [options]
   */
  constructor(options = {}) {
    this.failureThreshold = positiveInt(options.failureThreshold, 2)
    this.cooldownMs = positiveInt(options.cooldownMs, 60_000)
    this.successThreshold = positiveInt(options.successThreshold, 1)
    /** @type {Map<string, { failures: number, successes: number, until: number }>} */
    this._state = new Map()
  }

  /**
   * @param {string} key route label
   * @param {number} [now] epoch ms
   * @returns {boolean} true when the route should be skipped
   */
  isUnhealthy(key, now = Date.now()) {
    const state = this._state.get(key)
    if (!state) return false
    if (state.until > 0 && now >= state.until) {
      // Cooldown elapsed: give the route a clean slate again.
      this._state.set(key, { failures: 0, successes: 0, until: 0 })
      return false
    }
    return state.until > 0
  }

  /**
   * Record a successful call, clearing any accumulated failures.
   * @param {string} key
   */
  recordSuccess(key) {
    this._state.delete(key)
  }

  /**
   * Record one unavailable failure; demotes once the threshold is reached.
   *
   * The threshold is the operator's single lever for "how many failures before
   * the router moves on", and nothing here second-guesses it: no class of
   * failure is special-cased to skip it.
   *
   * @param {string} key
   * @param {number} [now]
   * @returns {boolean} true when this failure demoted the route
   */
  recordFailure(key, now = Date.now()) {
    const previous = this._state.get(key)
    const failures = (previous?.failures ?? 0) + 1
    if (failures < this.failureThreshold) {
      this._state.set(key, { failures, successes: 0, until: previous?.until ?? 0 })
      return false
    }
    this._state.set(key, { failures, successes: 0, until: now + this.cooldownMs })
    return true
  }

  /**
   * Snapshot for `/model-auto-router status`.
   *
   * Runs each route through `isUnhealthy` first so a route whose cooldown has
   * elapsed is reported as recovered instead of lingering with a stale timer.
   *
   * @param {number} [now]
   * @returns {Array<{ route: string, failures: number, coolingDown: boolean, cooldownRemainingMs: number }>}
   */
  snapshot(now = Date.now()) {
    const rows = []
    for (const key of this._state.keys()) {
      // Side effect on purpose: this settles an expired cooldown.
      const cooling = this.isUnhealthy(key, now)
      const state = this._state.get(key)
      if (!state || (!cooling && state.failures === 0)) continue
      rows.push({
        route: key,
        failures: state.failures,
        coolingDown: cooling,
        cooldownRemainingMs: cooling ? Math.max(0, state.until - now) : 0,
      })
    }
    return rows.sort((a, b) => b.cooldownRemainingMs - a.cooldownRemainingMs)
  }

  /** Forget every recorded route (used on config reload). */
  clear() {
    this._state.clear()
  }
}
