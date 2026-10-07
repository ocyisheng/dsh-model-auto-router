/**
 * In-process self test for the router.
 *
 * The router is pure logic with no host dependencies, so it can be verified
 * against the exact files that ship — no build step and no separate runner.
 *
 * Enabled from the profile entry with `{ selfTest: true }`, or by setting
 * `DSH_MODEL_AUTO_ROUTER_SELFTEST=1`. Results are returned as data (and written to
 * `selfTestOut` by the host entry) so they can be inspected from anywhere.
 */

import { failoverChain, normalizePools, normalizeSinglePool, selectCandidate } from './pool.js'
import { RouteHealthTracker, classifyFailure, statusInMessage } from './health.js'
import { ModelAutoRouter } from './router.js'
import { supportedEfforts } from './effort.js'

/** @typedef {{ name: string, ok: boolean, error?: string }} TestResult */

const agent = (id, isSubagent = false) => ({ id, meta: isSubagent ? { origin: 'subagent' } : {} })

const fixture = (over = {}) => ({
  mainPool: 'work',
  pools: {
    work: { provider: 'deepseek', strategy: 'primary-failover', candidates: ['deepseek-chat', 'deepseek-reasoner'] },
    cheap: { provider: 'deepseek', strategy: 'round-robin', candidates: ['deepseek-reasoner'] },
  },
  ...over,
})

const makeRouter = (over) => {
  const router = new ModelAutoRouter({ log: () => {} })
  router.configure(fixture(over))
  return router
}

const eq = (actual, expected, what) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`)
}

const ok = (value, what) => {
  if (!value) throw new Error(`${what}: expected truthy, got ${JSON.stringify(value)}`)
}

/** @type {Array<{ name: string, fn: () => void }>} */
const CASES = [
  ['shorthand string candidates take the pool provider', () => {
    const pools = normalizePools({ work: { provider: 'deepseek', candidates: ['chat'] } })
    eq(pools.get('work').candidates[0], { provider: 'deepseek', model: 'chat', weight: 1, label: 'deepseek/chat' }, 'candidate')
  }],
  ['per-candidate provider overrides the pool provider', () => {
    const pools = normalizePools({ mixed: { candidates: [{ provider: 'openai', model: 'gpt-5' }, { provider: 'deepseek', model: 'chat' }] } })
    eq(pools.get('mixed').candidates.map(c => c.label), ['openai/gpt-5', 'deepseek/chat'], 'labels')
  }],
  ['duplicate routes are dropped', () => {
    const pools = normalizePools({ dup: { provider: 'p', candidates: ['m', 'm', { provider: 'p', model: 'm' }] } })
    eq(pools.get('dup').candidates.length, 1, 'count')
  }],
  ['a candidate with no resolvable provider is rejected', () => {
    let threw = false
    try { normalizePools({ bad: { candidates: ['orphan'] } }) } catch { threw = true }
    ok(threw, 'throws')
  }],
  ['an unknown strategy falls back to primary-failover', () => {
    const pools = normalizePools({ s: { provider: 'p', strategy: 'chaos', candidates: ['a'] } })
    eq(pools.get('s').strategy, 'primary-failover', 'strategy')
  }],
  ['normalizeSinglePool accepts a bare route object', () => {
    eq(normalizeSinglePool({ provider: 'deepseek', model: 'chat' }).candidates.map(c => c.label), ['deepseek/chat'], 'labels')
  }],

  ['round-robin advances the cursor', () => {
    const pool = normalizePools({ rr: { provider: 'p', strategy: 'round-robin', candidates: ['a', 'b'] } }).get('rr')
    const usage = new Map()
    eq(['a', 'b', 'a'].map(() => selectCandidate(pool, { usage }).label), ['p/a', 'p/b', 'p/a'], 'picks')
  }],
  ['least-used prefers the least used candidate', () => {
    const pool = normalizePools({ lu: { provider: 'p', strategy: 'least-used', candidates: ['a', 'b'] } }).get('lu')
    eq(selectCandidate(pool, { usage: new Map([['p/a', 5], ['p/b', 1]]) }).label, 'p/b', 'pick')
  }],
  ['weighted-random respects weights at the extremes', () => {
    const pool = normalizePools({
      wr: { provider: 'p', strategy: 'weighted-random', candidates: [{ model: 'a', weight: 100 }, { model: 'b', weight: 1 }] },
    }).get('wr')
    eq(selectCandidate(pool, { random: () => 0 }).label, 'p/a', 'zero')
    eq(selectCandidate(pool, { random: () => 0.999 }).label, 'p/b', 'near one')
  }],
  ['primary-failover always prefers the first declared candidate', () => {
    const pool = normalizePools({ pf: { provider: 'p', candidates: ['a', 'b', 'c'] } }).get('pf')
    // Different agents must all get the primary: this strategy is about declared
    // priority, not load spreading.
    for (const agentId of ['s1', 's2', 's3']) eq(selectCandidate(pool, { agentId }).label, 'p/a', agentId)
    for (let i = 0; i < 20; i++) eq(selectCandidate(pool, { agentId: 's1' }).label, 'p/a', 'stable')
  }],
  ['a preferred route wins over the strategy', () => {
    const pool = normalizePools({ pf: { provider: 'p', candidates: ['a', 'b'] } }).get('pf')
    eq(selectCandidate(pool, { agentId: 's1', preferred: 'p/b' }).label, 'p/b', 'preferred')
  }],
  ['failoverChain keeps the current route first', () => {
    const candidates = [{ label: 'a' }, { label: 'b' }, { label: 'c' }]
    eq(failoverChain(candidates, 'b').map(c => c.label), ['b', 'a', 'c'], 'chain')
    eq(failoverChain(candidates, 'a').map(c => c.label), ['a', 'b', 'c'], 'head')
  }],

  ['unavailable failures are classified as such', () => {
    for (const failure of [{ status: 429 }, { status: 503 }, { status: 529 }, { code: 'model_overloaded' }, { code: 'ECONNREFUSED' }, { code: 'ENOTFOUND' }]) {
      ok(classifyFailure(failure).unavailable, JSON.stringify(failure))
    }
  }],
  ['request faults are not treated as unavailable', () => {
    for (const failure of [{ status: 400 }, { status: 401 }, { code: 'context_length_exceeded' }, { code: 'invalid_request' }]) {
      ok(!classifyFailure(failure).unavailable, JSON.stringify(failure))
    }
  }],
  ['a retired model is unavailable even under a generic code', () => {
    // The exact shape `dsh-our-free-model` produces for a deprecated model: its
    // `ModelError` branch does not match "has been deprecated", so the news
    // arrives as a generic client error and the message is the only signal.
    const real = {
      code: 'CLIENT_ERROR',
      status: 400,
      message: 'Model mimo-v2.5-free has been deprecated. Use mimo-v2.6-flash-free instead.',
    }
    const classified = classifyFailure(real)
    ok(classified.unavailable, 'classified as unavailable')
    eq(classified.reason, 'model-retired', 'reason')

    // Other phrasings and the code-only route to the same conclusion.
    for (const failure of [
      { code: 'SERVER', message: 'model x has been retired' },
      { message: 'This model was decommissioned on 2026-01-01' },
      { message: 'the model is no longer available' },
      { code: 'model_deprecated' },
      { code: 'model_retired' },
    ]) {
      ok(classifyFailure(failure).unavailable, JSON.stringify(failure))
    }
  }],
  ['a request fault that merely mentions deprecation still fails', () => {
    // The retired-model patterns are anchored to a model being retired, so a
    // malformed request that happens to use the word must not trigger a
    // failover — switching models would only swap one wrong answer for another.
    for (const failure of [
      { code: 'invalid_request', status: 400, message: 'unknown parameter deprecated_field' },
      { status: 400, message: 'the deprecated_field parameter is not accepted' },
    ]) {
      ok(!classifyFailure(failure).unavailable, JSON.stringify(failure))
    }
  }],
  ['a retired model is no more urgent than any other unavailable route', () => {
    // "Deprecated" is the provider's word for its own catalogue, and the route
    // can be serving again later — so the retirement signal decides only
    // *whether* to fail over, never how many failures it takes. The operator's
    // `failureThreshold` stays the single answer to that, and it is not
    // special-cased away.
    const tracker = new RouteHealthTracker({ failureThreshold: 2, cooldownMs: 1000 })
    eq(tracker.recordFailure('p/retired', 10_000), false, 'a first failure is tolerated')
    eq(tracker.isUnhealthy('p/retired', 10_000), false, 'so the route is still tried')
    eq(tracker.recordFailure('p/retired', 10_000), true, 'the threshold demotes it as usual')
  }],

  ['reasoning support is read from the model, never assumed', () => {
    // The router changes which model a request uses, so the `reasoningEffort`
    // DSH resolved for its own model cannot be carried across blindly: DSH
    // rejects an unsupported pair with UNSUPPORTED_REASONING_EFFORT before it
    // dispatches. This is the read that decides whether the effort survives.
    eq(
      [...supportedEfforts({ reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } })].join(','),
      'off,high',
      'the advertised ids',
    )
    // No reasoning advertised at all is exactly the shape DSH refuses any
    // requested effort for, so it must not read as "supports everything".
    eq(supportedEfforts({}), undefined, 'a model with no reasoning block')
    eq(supportedEfforts({ reasoning: {} }), undefined, 'a reasoning block with no efforts')
    eq(supportedEfforts(undefined), undefined, 'an absent model')
  }],

  ['a status quoted in the message is read, not ignored', () => {
    // The reported failure. An in-stream error envelope is classified with no
    // status to pass, so the 503 survives only inside the text — and a
    // classifier that reads `status` alone sees an unknown failure and leaves a
    // plainly overloaded upstream in place.
    const real = {
      code: 'SERVER',
      message: 'Streaming response failed: [503] Upstream error from Nvidia: Service temporarily overloaded',
    }
    eq(classifyFailure(real).unavailable, true, 'the quoted 503 fails the route over')
    eq(statusInMessage(real.message), 503, 'and the status is read out of the text')

    for (const failure of [
      { code: 'SERVER', message: 'HTTP 502 bad gateway' },
      { code: 'SERVER', message: 'statusCode: 529 overloaded' },
      { code: 'SERVER', message: '[429] slow down' },
    ]) {
      eq(classifyFailure(failure).unavailable, true, failure.message)
    }

    // A quoted 4xx is the request's own fault, and must not be promoted just
    // because the adapter labelled the envelope `SERVER`.
    eq(classifyFailure({ code: 'SERVER', message: '[400] bad request body' }).unavailable, false, 'quoted 400')
    eq(classifyFailure({ code: 'SERVER', message: '[403] forbidden' }).unavailable, false, 'quoted 403')
  }],
  ['a server-side code is unavailable even with no detail at all', () => {
    // `dsh-our-free-model` splits its vocabulary in two: CLIENT_ERROR for a 4xx
    // and SERVER for the retryable bucket. A bare SERVER is an availability
    // signal, and a failure that says nothing else still has to move the router.
    eq(classifyFailure({ code: 'SERVER' }).unavailable, true, 'a bare SERVER')
    eq(classifyFailure({ code: 'SERVER', message: 'the service is temporarily unavailable' }).unavailable, true, 'transient wording')
    eq(classifyFailure({ code: 'SERVER', message: '[400] bad request' }).unavailable, false, 'but a quoted 4xx still wins')
    eq(classifyFailure({ code: 'invalid_request', message: '[500] x' }).unavailable, false, 'and a named request fault beats a quoted 5xx')
  }],

  ['every failure this host has actually recorded is recognised', () => {
    // Copied verbatim from the `turn/end` reasons in this machine's session
    // logs. Between them they cover the whole reported history, and every one of
    // them is a provider-side failure the router should have moved off — three
    // of them once did not, because the meaning was in a field (or a message)
    // the classifier was not reading.
    const recorded = [
      // The 503 that ended a turn with the plugin apparently idle. No `status`
      // at all: the 503 exists only inside the text.
      {
        label: 'SERVER with the status quoted in the message',
        failure: { message: 'Streaming response failed: [503] Upstream error from Nvidia: Service temporarily overloaded', code: 'SERVER' },
      },
      // The retirement, which carries a 410 — a status that is *not* in the
      // unavailable set on its own, so only the wording catches it.
      {
        label: 'CLIENT_ERROR 410 for a retired model',
        failure: { message: 'Error from provider (Console): Model mimo-v2.5-free has been deprecated. Use mimo-v2.6-flash-free instead.', code: 'CLIENT_ERROR', status: 410 },
      },
      // A failed fetch, carried as the adapter's own transport code.
      {
        label: 'TRANSPORT',
        failure: { message: 'our-free-model: upstream request failed: fetch failed', code: 'TRANSPORT' },
      },
      {
        label: 'RATE_LIMIT with a status',
        failure: { message: 'Rate limit exceeded. Please try again later.', code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 29659000 },
      },
      {
        label: 'RATE_LIMIT without one',
        failure: { message: 'Rate limit exceeded. Please try again later.', code: 'RATE_LIMIT' },
      },
      { label: 'a bare SERVER', failure: { code: 'SERVER' } },
    ]
    for (const { label, failure } of recorded) {
      eq(classifyFailure(failure).unavailable, true, label)
    }

    // The one recorded failure that must *not* move the router: an effort the
    // chosen model does not accept is a request-shape problem, and the fix is to
    // reconcile the effort (see `src/effort.js`), not to switch models.
    eq(
      classifyFailure({
        message: 'provider "our-free-model-vision" model "mimo-v2.5-free" does not support reasoning effort "high"',
        code: 'UNSUPPORTED_REASONING_EFFORT',
      }).unavailable,
      false,
      'an unsupported reasoning effort is not an unavailable route',
    )
  }],

  ['a route demotes only at the configured threshold', () => {
    const tracker = new RouteHealthTracker({ failureThreshold: 2, cooldownMs: 1000 })
    eq(tracker.recordFailure('p/m', 10_000), false, 'first failure')
    eq(tracker.isUnhealthy('p/m', 10_000), false, 'not demoted yet')
    eq(tracker.recordFailure('p/m', 10_000), true, 'threshold reached')
    eq(tracker.isUnhealthy('p/m', 10_000), true, 'demoted')
  }],
  ['a route recovers once the cooldown elapses', () => {
    const tracker = new RouteHealthTracker({ failureThreshold: 1, cooldownMs: 1000 })
    tracker.recordFailure('p/m', 10_000)
    eq(tracker.isUnhealthy('p/m', 10_500), true, 'still cooling')
    eq(tracker.isUnhealthy('p/m', 11_000), false, 'recovered')
  }],
  ['a success clears accumulated health', () => {
    const tracker = new RouteHealthTracker({ failureThreshold: 1, cooldownMs: 10_000 })
    tracker.recordFailure('p/m', 0)
    tracker.recordSuccess('p/m')
    eq(tracker.isUnhealthy('p/m', 1), false, 'cleared')
  }],
  ['a recovered route is not reported as cooling down', () => {
    const tracker = new RouteHealthTracker({ failureThreshold: 1, cooldownMs: 1000 })
    tracker.recordFailure('p/m', 10_000)
    eq(tracker.snapshot(10_500)[0]?.coolingDown, true, 'still cooling')
    const settled = tracker.snapshot(11_000)
    ok(!settled.some(row => row.coolingDown), 'no stale cooldown row')
  }],
  ['a sub-threshold failure is visible in the snapshot but not cooling', () => {
    const tracker = new RouteHealthTracker({ failureThreshold: 3, cooldownMs: 10_000 })
    tracker.recordFailure('p/m', 0)
    tracker.recordFailure('p/m', 0)
    const rows = tracker.snapshot(100)
    eq(rows.length, 1, 'one row')
    eq(rows[0].coolingDown, false, 'not demoted yet')
  }],

  ['a main agent stays pinned to one route across steps', () => {
    const router = makeRouter()
    const main = agent('main')
    const first = router.select({ agent: main })
    for (let i = 0; i < 5; i++) eq(router.select({ agent: main }), first, 'stable')
  }],
  ['subagents draw from the subagent pool, not the main pool', () => {
    const router = makeRouter({ subagentPool: 'cheap' })
    eq(router.select({ agent: agent('s1') }).model, 'deepseek-chat', 'main agent')
    eq(router.select({ agent: agent('s2', true) }).model, 'deepseek-reasoner', 'subagent')
  }],
  ['subagents inherit the main pool by default', () => {
    eq(makeRouter().select({ agent: agent('s2', true) }).model, 'deepseek-chat', 'inherited')
  }],
  ['a disabled router makes no routing decision at all', () => {
    eq(makeRouter({ enabled: false }).select({ agent: agent('s1') }), undefined, 'disabled')
  }],

  ['an unavailable route fails over to the next candidate on retry', () => {
    const router = makeRouter({ health: { failureThreshold: 1, cooldownMs: 60_000 } })
    const main = agent('s1')
    const first = router.select({ agent: main })
    eq(first.model, 'deepseek-chat', 'initial route')
    eq(router.handleFailure({ agent: main, provider: first.provider, failure: { status: 503 } }), { kind: 'retry' }, 'retry claimed')
    eq(router.select({ agent: main }).model, 'deepseek-reasoner', 'switched')
  }],
  ['a request fault does not trigger a failover', () => {
    const router = makeRouter()
    const main = agent('s1')
    const first = router.select({ agent: main })
    eq(router.handleFailure({ agent: main, provider: first.provider, failure: { status: 400 } }), undefined, 'no retry')
    eq(router.select({ agent: main }), first, 'unchanged')
  }],
  ['a deprecated model fails over, on the operator\'s threshold', () => {
    // The reported failure, end to end: the pool's first candidate has been
    // retired by the provider, which names its own replacement as the next
    // candidate. The deprecation is now recognised as unavailable — without
    // that, no failover happened at all — and the threshold decides when.
    const pool = {
      strategy: 'primary-failover',
      candidates: [
        { provider: 'our-free-model-vision', model: 'mimo-v2.5-free' },
        { provider: 'our-free-model', model: 'mimo-v2.6-flash-free' },
        { provider: 'our-free-model', model: 'nemotron-3-ultra-free' },
      ],
    }
    const deprecated = {
      provider: 'our-free-model-vision',
      failure: {
        code: 'CLIENT_ERROR',
        status: 400,
        message: 'Model mimo-v2.5-free has been deprecated. Use mimo-v2.6-flash-free instead.',
      },
    }
    const build = failureThreshold => makeRouter({
      mainPool: 'main',
      health: { failureThreshold, cooldownMs: 60_000 },
      pools: { main: pool },
    })

    // The default threshold tolerates one failure, so the first retry lands back
    // on the same route — deliberately, because a "deprecated" notice can be
    // transient and the operator asked for one free retry.
    const tolerant = build(2)
    const slow = agent('s1')
    eq(tolerant.select({ agent: slow }).model, 'mimo-v2.5-free', 'the retired model is picked first')
    eq(tolerant.handleFailure({ agent: slow, ...deprecated }), { kind: 'retry' }, 'the retry is claimed')
    eq(tolerant.select({ agent: slow }).model, 'mimo-v2.5-free', 'but the tolerated failure keeps the same route')
    eq(tolerant.handleFailure({ agent: slow, ...deprecated }), { kind: 'retry' }, 'the second failure demotes it')
    eq(tolerant.select({ agent: slow }).model, 'mimo-v2.6-flash-free', 'and it moves to the provider\'s own replacement')

    // `failureThreshold: 1` — the documented setting for "switch on the first
    // error" — is the way to make a retirement move immediately.
    const eager = build(1)
    const quick = agent('s1')
    eq(eager.select({ agent: quick }).model, 'mimo-v2.5-free', 'the retired model is picked first')
    eq(eager.handleFailure({ agent: quick, ...deprecated }), { kind: 'retry' }, 'the first failure is enough')
    eq(eager.select({ agent: quick }).model, 'mimo-v2.6-flash-free', 'and the very next attempt is elsewhere')
  }],
  ['an overloaded upstream wrapped as SERVER still fails over', () => {
    // The reported failure end to end: the main pool's last candidate is the one
    // in use, the upstream gateway answers 503 inside the stream, and the
    // adapter hands the router `{ code: 'SERVER', message: '... [503] ...' }`
    // with no status field. Every candidate in the main pool is treated as
    // unavailable, so the retry has to reach the fallback pool.
    const router = makeRouter({
      mainPool: 'main',
      fallbackPool: 'backup',
      health: { failureThreshold: 1, cooldownMs: 60_000 },
      pools: {
        main: {
          strategy: 'primary-failover',
          candidates: [{ provider: 'our-free-model', model: 'nemotron-3-ultra-free' }],
        },
        backup: {
          strategy: 'primary-failover',
          candidates: [{ provider: 'deepseek-official', model: 'deepseek-flash' }],
        },
      },
    })
    const main = agent('s1')
    eq(router.select({ agent: main }).model, 'nemotron-3-ultra-free', 'the pool route is picked')

    const retry = router.handleFailure({
      agent: main,
      provider: 'our-free-model',
      failure: {
        code: 'SERVER',
        message: 'Streaming response failed: [503] Upstream error from Nvidia: Service temporarily overloaded',
      },
    })
    eq(retry, { kind: 'retry' }, 'the retry is claimed')
    eq(router.select({ agent: main }).model, 'deepseek-flash', 'and the fallback pool takes over')
  }],
  ['a single-route pool surfaces the real error instead of masking it', () => {
    const router = makeRouter({ mainPool: 'solo', pools: { solo: { provider: 'deepseek', candidates: ['deepseek-chat'] } } })
    const main = agent('s1')
    router.select({ agent: main })
    eq(router.handleFailure({ agent: main, provider: 'deepseek', failure: { status: 503 } }), undefined, 'no retry')
  }],
  ['a demoted route is skipped for newly created sessions', () => {
    const router = new ModelAutoRouter({ log: () => {} })
    router.configure({
      mainPool: 'work',
      pools: { work: { provider: 'deepseek', strategy: 'round-robin', candidates: ['a', 'b'] } },
      health: { failureThreshold: 1, cooldownMs: 60_000 },
    })
    const first = agent('s1')
    router.select({ agent: first })
    router.handleFailure({ agent: first, provider: 'deepseek', failure: { status: 500 } })
    for (let i = 0; i < 10; i++) eq(router.select({ agent: agent(`fresh-${i}`) }).model, 'b', 'skips demoted route')
  }],
  ['a transient failure below the threshold keeps the route pinned', () => {
    const router = makeRouter({ health: { failureThreshold: 3, cooldownMs: 60_000 } })
    const main = agent('s1')
    const first = router.select({ agent: main })
    router.handleFailure({ agent: main, provider: 'deepseek', failure: { status: 503 } })
    eq(router.select({ agent: main }), first, 'kept')
  }],
  ['an exhausted pool falls through to the fallback pool', () => {
    const router = new ModelAutoRouter({ log: () => {} })
    router.configure({
      mainPool: 'work',
      fallbackPool: { provider: 'openai', candidates: ['gpt-5'] },
      pools: { work: { provider: 'deepseek', candidates: ['deepseek-chat'] } },
      health: { failureThreshold: 1, cooldownMs: 60_000 },
    })
    const main = agent('s1')
    eq(router.select({ agent: main }).model, 'deepseek-chat', 'starts on the main pool')
    eq(router.handleFailure({ agent: main, provider: 'deepseek', failure: { status: 503 } }), { kind: 'retry' }, 'retry offered')
    eq(router.select({ agent: main }).model, 'gpt-5', 'fell through to fallback')
  }],
  ['a pinned route still yields to the fallback pool once fully demoted', () => {
    // Regression: the "keep my current route" shortcut used to run before the
    // health check, so an exhausted pool never reached the fallback.
    const router = new ModelAutoRouter({ log: () => {} })
    router.configure({
      mainPool: 'work',
      fallbackPool: { provider: 'openai', candidates: ['gpt-5'] },
      pools: { work: { provider: 'deepseek', candidates: ['deepseek-chat', 'deepseek-reasoner'] } },
      health: { failureThreshold: 1, cooldownMs: 60_000 },
    })
    const main = agent('s1')
    eq(router.select({ agent: main }).model, 'deepseek-chat', 'initial')

    // Demote every route of the main pool, one failure at a time.
    router.handleFailure({ agent: main, provider: 'deepseek', failure: { status: 503 } })
    router.select({ agent: main })
    router.handleFailure({ agent: main, provider: 'deepseek', failure: { status: 503 } })

    eq(router.select({ agent: main }).model, 'gpt-5', 'must reach the fallback pool')
  }],
  ['the fallback pool is ignored while the own pool is still healthy', () => {
    const router = new ModelAutoRouter({ log: () => {} })
    router.configure({
      mainPool: 'work',
      fallbackPool: { provider: 'openai', candidates: ['gpt-5'] },
      pools: { work: { provider: 'deepseek', candidates: ['deepseek-chat'] } },
      health: { failureThreshold: 1, cooldownMs: 60_000 },
    })
    const main = agent('s1')
    eq(router.select({ agent: main }).model, 'deepseek-chat', 'stays on its own pool')
    eq(router.select({ agent: main }).model, 'deepseek-chat', 'still its own pool')
  }],
  ['repeated failures stop claiming retries so the error surfaces', () => {
    const router = makeRouter({ health: { failureThreshold: 1, cooldownMs: 60_000 } })
    const main = agent('s1')
    router.select({ agent: main })
    router.handleFailure({ agent: main, provider: 'deepseek', failure: { status: 500 } })
    router.select({ agent: main })
    router.handleFailure({ agent: main, provider: 'deepseek', failure: { status: 500 } })
    eq(router.handleFailure({ agent: main, provider: 'deepseek', failure: { status: 500 } }), undefined, 'surfaces error')
  }],
  ['forgetting an agent drops its routing state', () => {
    const router = makeRouter()
    router.select({ agent: agent('s1') })
    router.forget('s1')
    router.select({ agent: agent('s1') })
    ok(true, 'survives')
  }],

  ['pin forces a route and auto releases it', () => {
    const router = makeRouter()
    eq(router.pin('s1', 'deepseek-reasoner'), 'deepseek/deepseek-reasoner', 'resolved label')
    eq(router.select({ agent: agent('s1') }).model, 'deepseek-reasoner', 'pinned')
    router.pin('s1', undefined)
    eq(router.select({ agent: agent('s1') }).model, 'deepseek-chat', 'released')
  }],
  ['pin resolves a bare model name against the pool', () => {
    eq(makeRouter().pin('s1', 'deepseek-reasoner'), 'deepseek/deepseek-reasoner', 'resolved')
  }],
  ['pin rejects a route that is not configured', () => {
    eq(makeRouter().pin('s1', 'nope/nope'), undefined, 'rejected')
  }],

  ['report covers pools, assignments and cooling routes', () => {
    const router = makeRouter({ health: { failureThreshold: 1, cooldownMs: 60_000 } })
    const main = agent('s1')
    router.select({ agent: main })
    router.handleFailure({ agent: main, provider: 'deepseek', failure: { status: 503 } })
    router.select({ agent: main })
    const report = router.report()
    ok(report.includes('enabled'), 'enabled')
    ok(report.includes('main pool'), 'main pool')
    ok(report.includes('cooling down'), 'cooling')
  }],
  ['reconfiguring resets health and assignments', () => {
    const router = makeRouter({ health: { failureThreshold: 1, cooldownMs: 60_000 } })
    const main = agent('s1')
    router.select({ agent: main })
    router.handleFailure({ agent: main, provider: 'deepseek', failure: { status: 503 } })
    ok(router.healthSnapshot().length > 0, 'health recorded')
    router.configure(fixture())
    eq(router.healthSnapshot().length, 0, 'health cleared')
  }],

  ['snapshot reports the pools a settings page draws', () => {
    const router = makeRouter({ subagentPool: 'cheap' })
    const snapshot = router.snapshot()
    eq(snapshot.enabled, true, 'enabled')
    eq(snapshot.main.name, 'work', 'main pool name')
    eq(snapshot.main.strategy, 'primary-failover', 'main strategy')
    eq(snapshot.main.candidates.map(c => c.label), ['deepseek/deepseek-chat', 'deepseek/deepseek-reasoner'], 'main candidates')
    eq(snapshot.subagent.name, 'cheap', 'subagent pool name')
    eq(snapshot.fallback, undefined, 'no fallback configured')
  }],
  ['snapshot marks a demoted candidate as cooling down', () => {
    const router = makeRouter({ health: { failureThreshold: 1, cooldownMs: 60_000 } })
    const main = agent('s1')
    router.select({ agent: main })
    router.handleFailure({ agent: main, provider: 'deepseek', failure: { status: 503 } })
    const snapshot = router.snapshot()
    const cooling = snapshot.main.candidates.filter(c => c.coolingDown).map(c => c.label)
    eq(cooling, ['deepseek/deepseek-chat'], 'the failed route is the cooling one')
    eq(snapshot.health.filter(row => row.coolingDown).length, 1, 'one cooling row')
  }],
  ['snapshot lists live assignments and the switches behind them', () => {
    const router = makeRouter({ health: { failureThreshold: 1, cooldownMs: 60_000 } })
    const main = agent('s1')
    router.select({ agent: main })
    router.handleFailure({ agent: main, provider: 'deepseek', failure: { status: 503 } })
    router.select({ agent: main })

    const snapshot = router.snapshot()
    eq(snapshot.assignments.length, 1, 'one assigned agent')
    eq(snapshot.assignments[0].agentId, 's1', 'agent id')
    eq(snapshot.assignments[0].route, 'deepseek/deepseek-reasoner', 'landed on the fallback')
    eq(snapshot.assignments[0].reason, 'failover', 'the move reads as a failover, not a fresh pick')
    eq(snapshot.assignments[0].failovers, 1, 'one failover counted')
    // The log is every route change, and the first assignment is one of them —
    // that is deliberate, because "which route did this session start on" is
    // exactly the question a routing page exists to answer. The last entry is
    // the failover this case is really about.
    eq(snapshot.recentSwitches.length, 2, 'initial assignment plus the failover')
    eq(snapshot.recentSwitches[0].from, undefined, 'the first entry is the initial assignment')
    eq(snapshot.recentSwitches[1].from, 'deepseek/deepseek-chat', 'the failover left the primary')
    eq(snapshot.recentSwitches[1].to, 'deepseek/deepseek-reasoner', 'switch destination')
  }],
  ['snapshot reports a disabled router without inventing pools', () => {
    const router = new ModelAutoRouter({ log: () => {} })
    router.configure({ enabled: false })
    const snapshot = router.snapshot()
    eq(snapshot.enabled, false, 'disabled')
    eq(snapshot.main, undefined, 'no main pool')
    eq(snapshot.assignments, [], 'no assignments')
  }],
]

/**
 * Run every case against the live router implementation.
 *
 * @returns {{ total: number, passed: number, failed: number, results: TestResult[] }}
 */
export function runSelfTest() {
  /** @type {TestResult[]} */
  const results = []
  for (const [name, fn] of CASES) {
    try {
      fn()
      results.push({ name, ok: true })
    } catch (error) {
      results.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  const failed = results.filter(r => !r.ok).length
  return { total: results.length, passed: results.length - failed, failed, results }
}
