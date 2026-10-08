/**
 * The router: per-request model selection plus automatic failover.
 *
 * Two DSH waterfalls carry the whole feature, and they cover main agents and
 * subagents alike because both dispatch through the same agent loop:
 *
 *   `agent/request`       — replace the frozen LlmCallConfig for the coming
 *                           step. This is where a pool picks a route.
 *   `agent/request-error` — a request failed. Here we demote the route when the
 *                           failure means "unavailable" and ask the loop to
 *                           retry, which re-enters `agent/request`; the next
 *                           step therefore lands on a different candidate.
 *
 * Routing is per-(turn, step), not per-agent, so a failover takes effect on the
 * very next attempt rather than needing a new session.
 */

import {
  failoverChain,
  normalizePools,
  normalizeSinglePool,
  normalizeStrategy,
  selectCandidate,
  stableHash,
} from './pool.js'
import { HEALTH, RouteHealthTracker, classifyFailure } from './health.js'

/**
 * Split a `provider/model` route label back into its parts.
 * @param {string} label
 * @returns {[string, string]}
 */
function splitLabel(label) {
  const index = label.indexOf('/')
  return index < 0 ? [label, ''] : [label.slice(0, index), label.slice(index + 1)]
}

/** Reason codes surfaced in `/model-auto-router status`. */
export const REASON = /** @type {const} */ ({
  DISABLED: 'disabled',
  UNCONFIGURED: 'unconfigured',
  NO_HEALTHY_ROUTE: 'no-healthy-route',
  SELECTED: 'selected',
  KEPT_CURRENT: 'kept-current',
  FAILOVER: 'failover',
  RESTORED: 'restored-primary',
})

/**
 * Per-agent bookkeeping, keyed by session id.
 *
 * `route` is what this agent is currently pinned to. It is deliberately sticky:
 * without it, a round-robin pool would reshuffle the model on every step and
 * destroy prompt-cache locality, which usually costs more than it saves.
 */
class AgentState {
  /**
   * @param {boolean} isSubagent
   */
  constructor(isSubagent) {
    /** @type {string | undefined} */
    this.route = undefined
    /**
     * The route a failover just abandoned.
     *
     * `handleFailure` has to drop the pin so `select` recomputes, and that would
     * otherwise erase which route was left — so the switch log and the
     * `failover` reason would both read `(none) -> next`, which is exactly the
     * question a routing report exists to answer. Recorded here and consumed by
     * the next selection.
     *
     * @type {string | undefined}
     */
    this.previousRoute = undefined
    /**
     * The route a failover moved *away* from for this agent, while the route it
     * moved *to* (the fallback) is still the live pin.
     *
     * The anti-thrash hold lives here rather than in the global health tracker
     * on purpose: the hold is per-agent (each session's fallback must prove
     * itself before the primary is welcome back) and it must not prolong a
     * route's global cooldown. Once the fallback completes a successful call
     * (`recordSuccess` on the agent), this is cleared and the next selection may
     * return to the primary — so even without a provider retry-after, a
     * primary/fallback pair that both fail briefly settles on one of them
     * instead of seesawing every step.
     *
     * @type {string | undefined}
     */
    this.failedRoute = undefined
    /**
     * Whether the route we moved to after a failover (the fallback) has
     * completed at least one successful call. Set true by `select` once the
     * fallback is re-pinned on a callback; consumed by the anti-thrash hold so
     * the primary is reclaimed only after the fallback has proven itself — not
     * the instant the primary's cooldown expires.
     *
     * @type {boolean}
     */
    this.reclaimReady = false
    /** @type {string | undefined} */
    this.pool = undefined
    /** @type {string | undefined} */
    this.lastReason = undefined
    /** @type {number} */
    this.failoverCount = 0
    /** Captured at first selection so failure handling never re-derives it. */
    this.isSubagent = isSubagent
  }

  /**
   * Note a successful call on this agent's route.
   *
   * A success means the route we are currently pinned to (after a failover,
   * that is the fallback) actually works for this agent. The anti-thrash hold
   * on the route we abandoned (`failedRoute`) is NOT released here — instead
   * `select` sets `reclaimReady` only once the fallback has been re-pinned on a
   * callback, and reclaims the primary only when `failedRoute` has also healed.
   * That ordering is what prevents immediate see-sawing back to a primary that
   * recovered in the same instant. Clearing the hold here (the old behaviour)
   * released it a step too early, so the hold never actually bit.
   */
  recordSuccess() {
    // No-op: the hold's release is sequenced in `select`, not here.
  }
}

/**
 * Owns pool state and both waterfall listeners.
 *
 * Kept free of host imports so it can be unit-tested against plain objects.
 */
export class ModelAutoRouter {
  /**
   * @param {{
   *   log?: (message: string) => void,
   *   onRouteChange?: (info: { agentId: string, from: string | undefined, to: string }) => void,
   * }} [io]
   */
  constructor(io = {}) {
    this._log = io.log ?? (() => {})
    this._onRouteChange = io.onRouteChange ?? (() => {})
    /** @type {Map<string, ReturnType<typeof normalizePools>>} */
    this._pools = new Map()
    /** @type {any} */
    this._mainPool = undefined
    this._mainPoolName = undefined
    /** @type {{ name?: string, pool: any } | undefined} */
    this._subagentPool = undefined
    /** @type {any} */
    this._fallbackPool = undefined
    /** @type {Map<string, string>} */
    this._routeOverrides = new Map()
    this._enabled = true
    /** Counts per-pool round-robin / least-used cursors. */
    this._usage = new Map()
    /** @type {{ failureThreshold?: number, cooldownMs?: number }} */
    this._healthOptions = {}
    this._health = new RouteHealthTracker(this._healthOptions)
    /** @type {Map<string, AgentState>} */
    this._agents = new Map()
    /** @type {Array<{ time: number, agentId: string, from: string | undefined, to: string, reason: string }>} */
    this._history = []
    this._maxHistory = 50
  }

  /**
   * Apply a raw configuration object. Throws on malformed pools so a typo
   * surfaces at load time instead of silently disabling routing.
   *
   * @param {Record<string, any>} config
   */
  configure(config) {
    const source = config ?? {}
    const io = { log: this._log }

    if (source.enabled !== undefined) this._enabled = source.enabled !== false

    this._pools = normalizePools(source.pools, io)

    const healthConfig = source.health
    // Health is rebuilt on every configure, not only when a `health` block is
    // present: a reconfiguration means the pools changed, so stale demotions
    // must not survive. Configured options are remembered so an omitted block
    // keeps the previous thresholds.
    if (healthConfig && typeof healthConfig === 'object') this._healthOptions = { ...this._healthOptions, ...healthConfig }
    this._health = new RouteHealthTracker(this._healthOptions)

    this._usage.clear()
    this._routeOverrides.clear()
    this._agents.clear()
    this._history.length = 0

    // Main agent: either a named pool or the shorthand `main` object.
    this._mainPoolName = typeof source.mainPool === 'string' ? source.mainPool : undefined
    this._mainPool = this._resolvePoolRef(source.mainPool, this._mainPoolName)

    // Subagents: a named pool, or the same `main` pool when `inheritMain` is on.
    const subagentRef = source.subagentPool
    if (typeof subagentRef === 'string') {
      this._subagentPool = { name: subagentRef, pool: this._pools.get(subagentRef) }
    } else if (subagentRef && typeof subagentRef === 'object') {
      const inline = normalizeSinglePool(subagentRef, io)
      this._subagentPool = inline ? { name: '_inline', pool: inline } : undefined
    } else if (source.inheritMain !== false && this._mainPool) {
      this._subagentPool = { name: this._mainPool.name, pool: this._mainPool }
    } else {
      this._subagentPool = undefined
    }

    this._fallbackPool = typeof source.fallbackPool === 'string'
      ? this._pools.get(source.fallbackPool)
      : normalizeSinglePool(source.fallbackPool, io)

    this._describeConfiguration()
  }

  /**
   * @param {unknown} ref
   * @param {string | undefined} name
   */
  _resolvePoolRef(ref, name) {
    if (name) {
      const pool = this._pools.get(name)
      if (!pool) {
        this._log(`model-auto-router: pool "${name}" is not defined; check pools in the config`)
      }
      return pool
    }
    if (ref && typeof ref === 'object') return normalizeSinglePool(ref, { log: this._log })
    return undefined
  }

  _describeConfiguration() {
    const describe = pool => pool
      ? `${pool.name} [${pool.strategy}] -> ${pool.candidates.map(c => c.label).join(', ')}`
      : 'none'

    this._log(`model-auto-router: main=${describe(this._mainPool)}`)
    this._log(`model-auto-router: subagent=${describe(this._subagentPool?.pool)}`)
    this._log(`model-auto-router: fallback=${describe(this._fallbackPool)}`)
    if (this._enabled === false) this._log('model-auto-router: disabled by config; DSH routing is untouched')
  }

  /**
   * Is this agent a subagent rather than a root session?
   *
   * `CreateAgentOptions.meta.origin === 'subagent'` is the host's own marker,
   * recorded at creation so we never guess from lineage.
   *
   * @param {{ meta?: { origin?: string } } | undefined} agent
   */
  _isSubagent(agent) {
    return agent?.meta?.origin === 'subagent'
  }

  /**
   * Pick the route for one request.
   *
   * There is deliberately no `purpose` filter here. Compaction and session-title
   * calls stream straight through `ctx.llm` — the title plugin's own envelope
   * "deliberately lacks the agent loop's process-local request identity" — so
   * they never reach an `agent/request` listener at all. `purpose` is a property
   * of an llm call, not of this payload and not of `LlmCallConfig`, so a check
   * here could never fire: the exclusion is structural, not something this
   * method enforces.
   *
   * @param {{ agent: any }} payload
   * @returns {{ provider: string, model: string, reasoningEffort?: string } | undefined}
   */
  select(payload) {
    if (!this._enabled) return undefined

    const agent = payload?.agent
    const state = this._state(agent)

    const own = this._isSubagent(agent) ? this._subagentPool : undefined
    const primary = own?.pool ?? this._mainPool
    if (!primary) {
      state.lastReason = REASON.UNCONFIGURED
      return undefined
    }

    const override = this._routeOverrides.get(agent?.id ?? '_anonymous')
    if (override) {
      state.route = override
      state.pool = own?.name ?? primary.name
      state.lastReason = REASON.SELECTED
      this._usage.set(override, (this._usage.get(override) ?? 0) + 1)
      return this._asRoute(override, primary)
    }

    // Candidates of the agent's own pool that are still usable. Empty means the
    // pool is fully demoted, which is the only situation that reaches the
    // global fallback pool.
    const healthy = this._healthyCandidates(primary)

    // Anti-thrash hold. If a failover opened it, `state.failedRoute` is the route
    // we abandoned. While it is open we keep the agent on its current healthy
    // route and NOT hand it back to `failedRoute` — even if `failedRoute` has
    // thawed globally — until the route we moved TO has delivered a success (so a
    // primary that recovered instantly cannot see-saw with a fallback that has
    // not proven itself) AND `failedRoute` has also healed. This is what stops
    // two rate-limiting models from oscillating every step (mimo -> kimi ->
    // mimo -> kimi ...). The hold only blocks `failedRoute`, never any other
    // healthy candidate.
    if (state.failedRoute) {
      const failedHealthy = healthy.some(c => c.label === state.failedRoute)
      if (failedHealthy && state.reclaimReady) {
        // `failedRoute` has healed and the route we moved to has succeeded once:
        // reclaim the primary (its order in the pool), closing the hold.
        state.route = state.failedRoute
        state.failedRoute = undefined
        state.reclaimReady = false
        state.pool = own?.name ?? primary.name
        state.lastReason = REASON.RESTORED
        // NOTE: do NOT call `_health.recordSuccess` here — for a primary demoted
        // by a provider retry-after, that would clear the provider-mandated
        // cooldown and reintroduce the thrash we are trying to prevent. The
        // global cooldown runs its own course; this agent simply resumes using
        // the route once it is eligible again.
        this._usage.set(state.route, (this._usage.get(state.route) ?? 0) + 1)
        if (state.route === primary.candidates[0]?.label) {
          this._noteChange(agent?.id, undefined, state.route, REASON.RESTORED)
        }
        return this._asRoute(state.route, primary)
      }
      // Either the abandoned route is still cooling, or it healed but the route
      // we moved to has not yet proven itself: keep the healthy route we are on
      // (or the first other healthy one) and stay put.
      const keep = (state.route && healthy.some(c => c.label === state.route))
        ? state.route
        : healthy.find(c => c.label !== state.failedRoute)?.label
      if (keep) {
        const wasPinned = state.route === keep
        const previous = state.route ?? state.previousRoute
        state.previousRoute = undefined
        state.route = keep
        state.pool = own?.name ?? primary.name
        if (wasPinned) {
          // A continued pin means the previous call on `keep` completed
          // successfully, so the route we moved to has now proven itself: the
          // hold is ready to lift as soon as `failedRoute` also heals.
          state.lastReason = REASON.KEPT_CURRENT
          state.reclaimReady = true
        } else {
          // First time reaching the fallback through the hold: this *is* the
          // failover itself, so report it as such rather than a fresh pick.
          state.lastReason = REASON.FAILOVER
          if (previous !== keep) this._noteChange(agent?.id, previous, keep, REASON.FAILOVER)
        }
        this._usage.set(keep, (this._usage.get(keep) ?? 0) + 1)
        return this._asRoute(keep, primary)
      }
    }

    // A route already chosen for this agent stays pinned while it is healthy.
    // Stability matters: prompt caches are keyed by model, so reshuffling every
    // step would pay full input cost on every call. This is checked after
    // `healthy` so a fully demoted pool still falls through to the fallback.
    if (state.route && healthy.some(c => c.label === state.route)) {
      state.pool = own?.name ?? primary.name
      state.lastReason = REASON.KEPT_CURRENT
      // Being asked again means the previous call on this route completed, so
      // clear any sub-threshold failure streak it had accumulated.
      this._health.recordSuccess(state.route)
      this._usage.set(state.route, (this._usage.get(state.route) ?? 0) + 1)
      return this._asRoute(state.route, primary)
    }

    // Prefer the agent's own pool. If part of it is demoted, select from what
    // remains rather than reshuffling into a known-bad route.
    const candidate = healthy.length === 0
      ? undefined
      : selectCandidate({ strategy: primary.strategy, candidates: healthy }, { agentId: agent?.id, usage: this._usage })

    if (candidate) {
      // The pin was dropped by a failover, so the route being left comes from
      // the state that recorded it. Reading it here (and clearing it) keeps the
      // value from leaking into an unrelated later selection.
      const previous = state.route ?? state.previousRoute
      state.previousRoute = undefined
      state.route = candidate.label
      state.pool = own?.name ?? primary.name
      state.lastReason = previous && previous !== candidate.label ? REASON.FAILOVER : REASON.SELECTED
      this._usage.set(candidate.label, (this._usage.get(candidate.label) ?? 0) + 1)

      if (previous !== candidate.label) {
        this._noteChange(agent?.id, previous, candidate.label, state.lastReason)
      }

      return this._asRoute(candidate.label, primary)
    }

    // Own pool is fully demoted: take the first healthy spare from the global
    // fallback pool so the session keeps working.
    const fallback = this._fallbackPool
    const spare = fallback
      ? this._healthyCandidates(fallback).find(c => !healthy.some(h => h.label === c.label))
      : undefined

    if (fallback && spare) {
      const previous = state.route ?? state.previousRoute
      state.previousRoute = undefined
      state.route = spare.label
      state.pool = fallback.name
      state.lastReason = REASON.FAILOVER
      this._usage.set(spare.label, (this._usage.get(spare.label) ?? 0) + 1)
      if (previous !== spare.label) this._noteChange(agent?.id, previous, spare.label, REASON.FAILOVER)
      return this._asRoute(spare.label, fallback)
    }

    // Nothing healthy anywhere. Degrade to the original pool order rather than
    // returning undefined, which would hand DSH back its own default model.
    const lastResort = selectCandidate({ strategy: 'primary-failover', candidates: primary.candidates }, {})
    if (lastResort) {
      state.route = lastResort.label
      state.lastReason = REASON.NO_HEALTHY_ROUTE
      return this._asRoute(lastResort.label, primary)
    }

    state.lastReason = REASON.NO_HEALTHY_ROUTE
    return undefined
  }

  /**
   * Split a route label back into the `{ provider, model }` the call config
   * needs, taking overrides from the pool entry when declared.
   *
   * @param {string} label
   * @param {any} pool
   */
  _asRoute(label, pool) {
    const entry = pool.candidates.find(c => c.label === label)
    const [provider, model] = splitLabel(label)
    return { provider: entry?.provider ?? provider, model: entry?.model ?? model }
  }

  /**
   * Candidates of a pool that are not currently cooling down.
   *
   * May legitimately return an empty list when every route is demoted; callers
   * treat that as "try the fallback pool", not as "no model".
   *
   * @param {any} pool
   */
  _healthyCandidates(pool) {
    return pool.candidates.filter(c => !this._health.isUnhealthy(c.label))
  }

  /**
   * @param {any} agent
   * @returns {AgentState & { routeOverrideKey?: string }}
   */
  _state(agent) {
    const id = agent?.id ?? '_anonymous'
    let state = this._agents.get(id)
    if (!state) {
      state = new AgentState(this._isSubagent(agent))
      this._agents.set(id, state)
    }
    return state
  }

  /**
   * Handle a failed model request.
   *
   * Returns `{ kind: 'retry' }` only when we own recovery, i.e. the route is
   * unusable and a healthy alternative exists. Returning `undefined` lets the
   * built-in retry policy and the loop handle it as usual.
   *
   * @param {{ agent: any, provider: string, failure: any }} payload
   * @returns {{ kind: 'retry' } | undefined}
   */
  handleFailure(payload) {
    if (!this._enabled) return undefined

    const agent = payload?.agent
    const state = this._state(agent)
    const route = state.route
    const classification = classifyFailure(payload?.failure)

    if (!classification.unavailable) {
      return undefined
    }

    let demoted = false
    if (route) {
      // Honour a provider retry-after (e.g. a 429 that says "come back in N ms"):
      // the cooldown becomes N, not the fixed `cooldownMs`, so the route stays
      // demoted for the whole window instead of thawing and re-failing.
      demoted = this._health.recordFailure(route, undefined, { retryAfterMs: classification.retryAfterMs })
      if (demoted) {
        this._log(`model-auto-router: route ${route} demoted (${classification.reason})`)
      }
    }

    // Only claim the retry when we can actually offer somewhere else to go;
    // otherwise let the loop surface the original error to the user.
    if (!this._hasAlternative(state, route)) {
      return undefined
    }

    // Below the threshold the route is still healthy, so `select` will land back
    // on it: this is a retry, not a switch, and the log should not claim
    // otherwise. The retry is still claimed because re-entering `agent/request`
    // is what lets `select` reconsider at all.
    this._log(demoted
      ? `model-auto-router: ${agent?.id ?? 'agent'} failing over from ${route ?? payload?.provider} (${classification.reason})`
      : `model-auto-router: ${agent?.id ?? 'agent'} retrying ${route ?? payload?.provider} (${classification.reason})`)
    state.failoverCount++
    // Drop the pin so `select` recomputes against the now-unhealthy route — but
    // record what is being left first, so the switch is reported with its real
    // origin instead of as a selection out of nowhere. `failedRoute` is what the
    // anti-thrash hold (in `select`) keys off: only a *demotion* opens it, so a
    // sub-threshold failure (still healthy) is just a retry and leaves the hold
    // untouched. While open, the abandoned route stays off-limits for this agent
    // until the route we moved to succeeds once and the primary has also healed.
    state.previousRoute = route
    if (demoted) state.failedRoute = route
    state.route = undefined
    return { kind: 'retry' }
  }

  /**
   * Is there a usable alternative in this agent's own pool, or the global
   * fallback pool?
   *
   * @param {AgentState} state
   * @param {string | undefined} currentRoute
   */
  _hasAlternative(state, currentRoute) {
    const primary = state.isSubagent ? this._subagentPool?.pool : this._mainPool

    for (const pool of [primary, this._fallbackPool]) {
      if (!pool) continue
      const chain = failoverChain(pool.candidates, currentRoute)
      if (chain.some(c => c.label !== currentRoute && !this._health.isUnhealthy(c.label))) {
        return true
      }
    }
    return false
  }

  /**
   * Note a route change and, when configured, persist it as the agent's new pin.
   * @param {string | undefined} agentId
   * @param {string | undefined} from
   * @param {string} to
   * @param {string} reason
   */
  _noteChange(agentId, from, to, reason) {
    this._history.push({ time: Date.now(), agentId: agentId ?? '_anonymous', from, to, reason })
    if (this._history.length > this._maxHistory) this._history.shift()
    this._onRouteChange({ agentId: agentId ?? '_anonymous', from, to })
  }

  /**
   * Force one agent onto a specific route until it calls `/model-auto-router auto`.
   * A bare model name resolves against the pool so the user need not type the
   * provider prefix.
   *
   * @param {string | undefined} agentId
   * @param {string | undefined} route
   * @returns {string | undefined} the resolved label, or undefined if unknown
   */
  pin(agentId, route) {
    const id = agentId ?? '_anonymous'
    if (!route) {
      const state = this._state({ id })
      state.route = undefined
      // A released pin is not a failover origin; leaving it set would attribute
      // the next selection to a route this session deliberately left.
      state.previousRoute = undefined
      this._routeOverrides.delete(id)
      return undefined
    }

    const resolved = this._resolveRouteLabel(route)
    if (!resolved) return undefined

    const state = this._state({ id })
    state.route = resolved
    this._routeOverrides.set(id, resolved)
    return resolved
  }

  /**
   * Match a typed route against the configured pools, by exact label first and
   * then by model id alone.
   *
   * @param {string} route
   * @returns {string | undefined}
   */
  _resolveRouteLabel(route) {
    const pools = [this._mainPool, this._subagentPool?.pool, this._fallbackPool].filter(Boolean)
    for (const pool of pools) {
      const exact = pool.candidates.find(c => c.label === route)
      if (exact) return exact.label
    }
    for (const pool of pools) {
      const byModel = pool.candidates.find(c => c.model === route)
      if (byModel) return byModel.label
    }
    return undefined
  }

  /**
   * Forget an agent's routing state when its session goes away.
   * @param {string} agentId
   */
  forget(agentId) {
    this._agents.delete(agentId)
    this._routeOverrides.delete(agentId)
  }

  /**
   * A compact, human-readable report for `/model-auto-router status`.
   * @returns {string}
   */
  report() {
    const lines = []
    lines.push(this._enabled ? 'dsh-model-auto-router: enabled' : 'dsh-model-auto-router: disabled')

    const poolLine = (title, pool) => {
      if (!pool) return lines.push(`  ${title}: (not configured)`)
      lines.push(`  ${title}: ${pool.name} [${pool.strategy}]`)
      for (const candidate of pool.candidates) {
        const unhealthy = this._health.isUnhealthy(candidate.label)
        lines.push(`    - ${candidate.label}${unhealthy ? '  (cooling down)' : ''}`)
      }
    }

    poolLine('main pool', this._mainPool)
    poolLine('subagent pool', this._subagentPool?.pool)
    poolLine('fallback pool', this._fallbackPool)

    const assignments = [...this._agents.entries()]
      .filter(([, state]) => state.route)
      .map(([id, state]) => `${id.slice(0, 8)}: ${state.route} (${state.lastReason}, ${state.failoverCount} failover(s))`)
    lines.push(assignments.length > 0 ? `  active assignments:\n    ${assignments.join('\n    ')}` : '  active assignments: none')

    const cooling = this._health.snapshot().filter(row => row.cooldownRemainingMs > 0)
    lines.push(cooling.length > 0
      ? `  cooling down: ${cooling.map(r => `${r.route} ${Math.ceil(r.cooldownRemainingMs / 1000)}s`).join(', ')}`
      : '  cooling down: none')

    const recent = this._history.slice(-5)
    if (recent.length > 0) {
      lines.push('  recent switches:')
      for (const entry of recent) {
        lines.push(`    ${entry.from ?? '(none)'} -> ${entry.to} [${entry.reason}]`)
      }
    }

    return lines.join('\n')
  }

  /**
   * Just the configured pools, for `/model-auto-router pools`.
   * @returns {string}
   */
  reportPools() {
    const lines = ['dsh-model-auto-router pools:']
    const poolLine = (title, pool) => {
      if (!pool) return lines.push(`  ${title}: (not configured)`)
      lines.push(`  ${title}: ${pool.name} [${pool.strategy}]`)
      for (const candidate of pool.candidates) {
        lines.push(`    - ${candidate.label}${candidate.weight !== 1 ? ` (weight ${candidate.weight})` : ''}`)
      }
    }
    poolLine('main pool', this._mainPool)
    poolLine('subagent pool', this._subagentPool?.pool)
    poolLine('fallback pool', this._fallbackPool)
    if (this._pools.size === 0) lines.push('  (no pools configured)')
    return lines.join('\n')
  }

  /** Current health rows, for tests and diagnostics. */
  healthSnapshot() {
    return this._health.snapshot()
  }

  /**
   * The router's live state as plain data, for the settings page.
   *
   * `report()` answers the same question for a person reading a chat line; this
   * answers it for a renderer, so every field the UI draws is a value it can
   * branch on rather than a substring it has to parse back out of prose.
   *
   * Read-only: the page observes routing through this, and steers it only
   * through the command, so there is exactly one writer for pool state.
   *
   * @returns {{
   *   enabled: boolean,
   *   main: object | undefined,
   *   subagent: object | undefined,
   *   fallback: object | undefined,
   *   assignments: Array<{ agentId: string, route: string, pool: string, reason: string, failovers: number }>,
   *   health: Array<{ route: string, failures: number, coolingDown: boolean, cooldownRemainingMs: number }>,
   *   recentSwitches: Array<{ time: number, agentId: string, from: string | undefined, to: string, reason: string }>,
   *   options: { failureThreshold: number, cooldownMs: number },
   * }}
   */
  snapshot() {
    const describe = pool => (pool
      ? {
          name: pool.name,
          strategy: pool.strategy,
          candidates: pool.candidates.map(candidate => ({
            label: candidate.label,
            provider: candidate.provider,
            model: candidate.model,
            weight: candidate.weight,
            coolingDown: this._health.isUnhealthy(candidate.label),
          })),
        }
      : undefined)

    return {
      enabled: this._enabled,
      main: describe(this._mainPool),
      subagent: describe(this._subagentPool?.pool),
      fallback: describe(this._fallbackPool),
      // The page shows a short id, but the full one is what makes a row
      // actionable, so it is carried rather than truncated.
      assignments: [...this._agents.entries()]
        .filter(([, state]) => state.route)
        .map(([agentId, state]) => ({
          agentId,
          route: /** @type {string} */ (state.route),
          pool: state.pool ?? '',
          reason: state.lastReason ?? '',
          failovers: state.failoverCount,
        })),
      health: this._health.snapshot(),
      recentSwitches: this._history.slice(-10),
      options: { ...this._healthOptions },
    }
  }
}

export { HEALTH, normalizeStrategy, stableHash }
