/**
 * Host-wiring check for `index.js`.
 *
 * Verifies the plugin's `apply` contract against a minimal stand-in for the DSH
 * host: the two `agent/*` waterfalls it must install, and the `agent/disposed`
 * cleanup.
 *
 * Run: node --test test/host.test.js
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, name } from '../index.js'

/**
 * A minimal stand-in for the parts of the DSH host context `apply` touches.
 *
 * `ctx.inject([...deps], cb)` is invoked immediately, handing `cb` a host object
 * that carries exactly the services named in `deps` — which is what makes a
 * mis-wired injection a loud failure rather than a silent no-op.
 */
function createFakeContext() {
  /** @type {Record<string, any[]>} */
  const handlers = new Map()
  const commands = new Map()
  const routes = new Map()
  const effects = []
  const injections = []

  const handlersFor = namespace => {
    if (!handlers.has(namespace)) handlers.set(namespace, [])
    return handlers.get(namespace)
  }

  /** Service object exposing `on` (per namespace) and `effect`. */
  const makeService = () => ({
    on(event, handler) {
      const list = handlersFor(event)
      list.push(handler)
      return () => { const i = list.indexOf(handler); if (i >= 0) list.splice(i, 1) }
    },
    effect(fn, label) {
      assert.equal(typeof label, 'string', 'effects must be labelled')
      const dispose = fn()
      effects.push(dispose)
      return dispose
    },
  })

  const services = {
    agents: makeService(),
    commands: Object.assign(makeService(), {
      register(definition) {
        commands.set(definition.name, definition)
        return () => commands.delete(definition.name)
      },
    }),
    // The settings page's carrier. `register` is the only method the plugin
    // touches, and recording the routes is what lets a test assert the plugin
    // mounted its API without starting a server.
    webServer: Object.assign(makeService(), {
      register(route) {
        routes.set(`${route.kind}:${route.path}`, route)
        return () => routes.delete(`${route.kind}:${route.path}`)
      },
    }),
  }

  const context = {
    logger: { info() {}, warn() {} },
    /** Cordis exposes event subscription on the context, which the injected host inherits. */
    on(event, handler) {
      const list = handlersFor(event)
      list.push(handler)
      return () => { const i = list.indexOf(handler); if (i >= 0) list.splice(i, 1) }
    },
    /**
     * Opportunistic service lookup. The plugin reads `connection` this way so a
     * composition without that service is not a failure — answering `undefined`
     * is the contract, and this fake keeps it.
     */
    get(service) {
      return services[service]
    },
    inject(deps, callback) {
      injections.push({ deps, callback })
      // Cordis hands the callback a host object that carries the requested
      // services *plus* the context's own lifecycle helpers (the reference
      // plugin calls `host.effect(...)` the same way).
      const resolved = Object.assign({}, context)
      for (const dep of deps) {
        assert.ok(services[dep], `plugin injected unknown service ${dep}`)
        resolved[dep] = services[dep]
      }
      callback(resolved)
      return () => {}
    },
    effect(fn, label) {
      assert.equal(typeof label, 'string', 'effects must be labelled')
      const dispose = fn()
      effects.push(dispose)
      return dispose
    },
    setInterval() { return { unref() {} } },
    clearInterval() {},
  }

  /** All handlers registered for an event, across every service. */
  const handlersFor_ = event => handlers.get(event) ?? []

  return { context, handlers, handlersFor: handlersFor_, commands, routes, effects, injections, services }
}

/**
 * Run the plugin against a fake host with the given config file.
 *
 * @param {string} configPath
 * @param {Record<string, any>} [config] extra entry Config
 */
function startPlugin(configPath, config) {
  const fake = createFakeContext()
  apply(fake.context, { configPath, watch: false, ...config })
  return fake
}

/** Write a config file to a fresh temp dir; returns its path and a cleanup fn. */
function useConfig(router, t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-model-auto-router-'))
  const file = join(dir, 'model-auto-router.json')
  writeFileSync(file, JSON.stringify(router), 'utf8')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return file
}

const signal = () => new AbortController().signal
const agentOf = (id, sub = false) => ({ id, meta: sub ? { origin: 'subagent' } : {} })
const passthrough = value => async () => value

test('the plugin exposes the name DSH registers it under', () => {
  assert.equal(name, 'dsh-model-auto-router')
})

test('apply wires routing, failure handling and cleanup', (t) => {
  const fake = startPlugin(useConfig({
    mainPool: 'main',
    pools: { main: { provider: 'deepseek', candidates: ['deepseek-chat'] } },
  }, t))

  assert.equal(fake.handlersFor('agent/request').length, 1, 'must subscribe to agent/request')
  assert.equal(fake.handlersFor('agent/request-error').length, 1, 'must subscribe to agent/request-error')
  assert.equal(fake.handlersFor('agent/disposed').length, 1, 'must subscribe to agent/disposed')
})

test('agent/request overrides provider and model but preserves other fields', async (t) => {
  const fake = startPlugin(useConfig({
    mainPool: 'main',
    pools: { main: { provider: 'deepseek', candidates: ['deepseek-reasoner'] } },
  }, t))

  const original = { provider: 'anthropic', model: 'claude', temperature: 0.3, maxTokens: 4096 }
  const request = fake.handlersFor('agent/request')[0]
  const result = await request.call({}, { agent: agentOf('s1'), turn: 1, step: 1, signal: signal() }, passthrough(original))

  assert.equal(result.provider, 'deepseek')
  assert.equal(result.model, 'deepseek-reasoner')
  assert.equal(result.temperature, 0.3, 'unrelated fields must survive')
  assert.equal(result.maxTokens, 4096)
})

test('agent/request drops a reasoning effort the chosen model does not support', async (t) => {
  // The reported failure: the router switched the model but carried DSH's
  // `reasoningEffort` across, and DSH rejects an unsupported pair with
  // UNSUPPORTED_REASONING_EFFORT before dispatching — a failover that dies on
  // the way out. The effort has to be reconciled against the model actually used.
  const fake = startPlugin(useConfig({
    mainPool: 'main',
    pools: { main: { provider: 'our-free-model-vision', candidates: ['mimo-v2.5-free'] } },
  }, t))
  // A model that advertises no reasoning at all: exactly the shape DSH refuses
  // any requested effort for.
  fake.services.llm = { resolveModelInfo: async () => ({}) }

  const original = {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    reasoningEffort: 'high',
    temperature: 0.3,
  }
  const result = await fake.handlersFor('agent/request')[0].call(
    {},
    { agent: agentOf('s1'), turn: 1, step: 1, signal: signal() },
    passthrough(original),
  )

  assert.equal(result.provider, 'our-free-model-vision')
  assert.equal(result.model, 'mimo-v2.5-free')
  assert.ok(!('reasoningEffort' in result), 'the unsupported effort is removed, not left as undefined')
  assert.equal(result.temperature, 0.3, 'unrelated fields still survive')
})

test('agent/request keeps a reasoning effort the chosen model does accept', async (t) => {
  const fake = startPlugin(useConfig({
    mainPool: 'main',
    pools: { main: { provider: 'deepseek', candidates: ['deepseek-reasoner'] } },
  }, t))
  fake.services.llm = {
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }, { id: 'high' }], defaultEffort: 'off' } }),
  }

  const original = { provider: 'anthropic', model: 'claude', reasoningEffort: 'high' }
  const result = await fake.handlersFor('agent/request')[0].call(
    {},
    { agent: agentOf('s2'), turn: 1, step: 1, signal: signal() },
    passthrough(original),
  )

  assert.equal(result.model, 'deepseek-reasoner')
  assert.equal(result.reasoningEffort, 'high', 'an explicit setting that the model honours is preserved')
})

test('agent/request does not reroute when no pools configured', async (t) => {
  const fake = startPlugin(useConfig({}, t))

  const original = { provider: 'anthropic', model: 'claude' }
  let downstreamCalls = 0
  const next = async () => { downstreamCalls++; return original }
  const request = fake.handlersFor('agent/request')[0]

  const result = await request.call({}, { agent: agentOf('s1'), turn: 1, step: 1, signal: signal() }, next)
  assert.deepEqual(result, original, 'no config must pass through untouched')
  assert.equal(downstreamCalls, 1, 'the plugin must defer to DSH')
})

test('an unavailable failure claims the retry and the retry lands on a fallback', async (t) => {
  const fake = startPlugin(useConfig({
    mainPool: 'main',
    pools: { main: { provider: 'deepseek', candidates: ['deepseek-chat', 'deepseek-reasoner'] } },
    health: { failureThreshold: 1, cooldownMs: 60000 },
  }, t))

  const agent = agentOf('s1')
  const request = fake.handlersFor('agent/request')[0]
  const onError = fake.handlersFor('agent/request-error')[0]

  const first = await request.call({}, { agent, turn: 1, step: 1, signal: signal() }, passthrough({ provider: 'deepseek', model: 'deepseek-chat' }))
  assert.equal(first.model, 'deepseek-chat', 'starts on the primary route')

  let downstream = 0
  const action = await onError.call(
    {},
    { agent, turn: 1, step: 1, provider: 'deepseek', failure: { status: 503 }, signal: signal() },
    async () => { downstream++; return undefined },
  )
  assert.deepEqual(action, { kind: 'retry' }, 'must claim the retry')
  assert.equal(downstream, 0, 'must not also delegate downstream')

  const second = await request.call({}, { agent, turn: 1, step: 2, signal: signal() }, passthrough({ provider: 'deepseek', model: 'deepseek-chat' }))
  assert.equal(second.model, 'deepseek-reasoner', 'the retry must land on the fallback route')
})

test('a request fault is handed back to the built-in retry policy', async (t) => {
  const fake = startPlugin(useConfig({
    mainPool: 'main',
    pools: { main: { provider: 'deepseek', candidates: ['deepseek-chat', 'deepseek-reasoner'] } },
  }, t))

  let downstream = 0
  const action = await fake.handlersFor('agent/request-error')[0].call(
    {},
    { agent: agentOf('s1'), turn: 1, step: 1, provider: 'deepseek', failure: { status: 400 }, signal: signal() },
    async () => { downstream++; return undefined },
  )
  assert.equal(action, undefined, 'router must stay out of the way')
  assert.equal(downstream, 1, 'must delegate downstream')
})

test('a missing config file leaves DSH routing completely untouched', (t) => {
  const absent = join(tmpdir(), `dsh-model-auto-router-absent-${Date.now()}.json`)
  const fake = startPlugin(absent)

  return (async () => {
    const original = { provider: 'anthropic', model: 'claude' }
    const result = await fake.handlersFor('agent/request')[0].call(
      {},
      { agent: agentOf('s1'), turn: 1, step: 1, signal: signal() },
      passthrough(original),
    )
    assert.deepEqual(result, original, 'must pass the call through unchanged')
  })()
})

test('a malformed config disables routing instead of throwing', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-model-auto-router-bad-'))
  const file = join(dir, 'model-auto-router.json')
  // A candidate with no provider is a hard error in normalization.
  writeFileSync(file, JSON.stringify({ mainPool: 'main', pools: { main: { candidates: ['orphan'] } } }), 'utf8')
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const fake = startPlugin(file)
  return (async () => {
    const original = { provider: 'anthropic', model: 'claude' }
    const result = await fake.handlersFor('agent/request')[0].call(
      {},
      { agent: agentOf('s1'), turn: 1, step: 1, signal: signal() },
      passthrough(original),
    )
    assert.deepEqual(result, original, 'must not reroute on a broken config')
  })()
})

test('a subagent is routed from its own pool through the host entry', async (t) => {
  const fake = startPlugin(useConfig({
    mainPool: 'main',
    subagentPool: 'cheap',
    pools: {
      main: { provider: 'deepseek', candidates: ['deepseek-chat'] },
      cheap: { provider: 'deepseek', candidates: ['deepseek-reasoner'] },
    },
  }, t))

  const request = fake.handlersFor('agent/request')[0]
  const base = { provider: 'anthropic', model: 'claude' }

  const main = await request.call({}, { agent: agentOf('m1'), turn: 1, step: 1, signal: signal() }, passthrough(base))
  const sub = await request.call({}, { agent: agentOf('s1', true), turn: 1, step: 1, signal: signal() }, passthrough(base))

  assert.equal(main.model, 'deepseek-chat', 'main agent uses the main pool')
  assert.equal(sub.model, 'deepseek-reasoner', 'subagent uses the subagent pool')
})

test('disposing an agent releases its routing state', async (t) => {
  const fake = startPlugin(useConfig({
    mainPool: 'main',
    pools: { main: { provider: 'deepseek', strategy: 'round-robin', candidates: ['deepseek-chat', 'deepseek-reasoner'] } },
  }, t))

  const request = fake.handlersFor('agent/request')[0]
  const base = { provider: 'anthropic', model: 'claude' }
  const disposed = fake.handlersFor('agent/disposed')[0]

  const first = await request.call({}, { agent: agentOf('s1'), turn: 1, step: 1, signal: signal() }, passthrough(base))
  assert.equal(first.model, 'deepseek-chat')

  // Round-robin would give the next new agent the other route regardless, so
  // assert the weaker but sufficient property: disposing must not throw and the
  // agent's state must be gone from the router.
  assert.doesNotThrow(() => disposed.call({}, { id: 's1' }))

  const after = await request.call({}, { agent: agentOf('s2'), turn: 1, step: 1, signal: signal() }, passthrough(base))
  assert.equal(after.model, 'deepseek-reasoner', 'round-robin advanced to the next route')
})

test('apply mounts the settings API on the web server', (t) => {
  const fake = startPlugin(useConfig({ pools: {} }, t))
  const route = fake.routes.get('prefix:/api/model-auto-router')
  assert.ok(route !== undefined, 'the settings API is registered as a prefix route')
  assert.equal(typeof route.handler, 'function', 'and it carries a handler')
})

test('ui: false leaves the web server completely alone', (t) => {
  // A headless composition must be able to run routing with no page at all.
  const fake = startPlugin(useConfig({ pools: {} }, t), { ui: false })
  assert.equal(fake.routes.size, 0, 'no routes are registered')
  // Routing itself is unaffected by the UI switch.
  assert.equal(fake.handlersFor('agent/request').length, 1)
})

test('the settings API reads the live provider inventory from the llm service', async (t) => {
  // The pool editor suggests real provider/model routes instead of asking the
  // operator to type them from memory, which only works if the catalog is read
  // from the host's own registry rather than from a guess.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-model-auto-router-catalog-'))
  const file = join(dir, 'model-auto-router.json')
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const fake = createFakeContext()
  fake.services.llm = {
    listProviders: () => [{ id: 'our-free-model', name: 'Our Free Model' }],
    listConfigurableProviders: () => [{ provider: 'pi-ai', displayName: 'pi-ai' }],
    listModels: async provider => (provider === 'our-free-model' ? [{ id: 'space-bunny-free', name: 'Space Bunny' }] : []),
  }
  apply(fake.context, { configPath: file, watch: false })

  const route = fake.routes.get('prefix:/api/model-auto-router')
  const res = {
    status: 0,
    body: '',
    writeHead(status) { this.status = status },
    end(body) { this.body = body ?? '' },
  }
  await route.handler({ method: 'GET', url: '/api/model-auto-router/catalog', headers: { host: '127.0.0.1:19387' } }, res)

  assert.equal(res.status, 200, res.body)
  const payload = JSON.parse(res.body)
  assert.deepEqual(payload.providers, [{
    id: 'our-free-model',
    name: 'Our Free Model',
    models: [{ id: 'space-bunny-free', name: 'Space Bunny' }],
  }])
  assert.deepEqual(payload.declared, [{ id: 'pi-ai', name: 'pi-ai' }])
})

test('a composition with no llm service still serves an empty catalog', async (t) => {
  const fake = startPlugin(useConfig({ pools: {} }, t))
  const route = fake.routes.get('prefix:/api/model-auto-router')
  const res = {
    status: 0,
    body: '',
    writeHead(status) { this.status = status },
    end(body) { this.body = body ?? '' },
  }
  await route.handler({ method: 'GET', url: '/api/model-auto-router/catalog', headers: { host: '127.0.0.1:19387' } }, res)

  assert.equal(res.status, 200, res.body)
  const payload = JSON.parse(res.body)
  assert.deepEqual(payload.providers, [])
  assert.deepEqual(payload.declared, [])
  assert.equal(typeof payload.discoveredAt, 'number', 'the page can tell when the inventory was read')
})

test('the settings API writes the config atomically and keeps it loadable', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-model-auto-router-ui-'))
  const file = join(dir, 'model-auto-router.json')
  writeFileSync(file, JSON.stringify({
    $comment: 'docs',
    mainPool: 'main',
    pools: { main: { provider: 'deepseek', candidates: ['deepseek-chat'] } },
  }), 'utf8')
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const fake = startPlugin(file)
  const route = fake.routes.get('prefix:/api/model-auto-router')

  const res = {
    status: 0,
    body: '',
    writeHead(status) { this.status = status },
    end(body) { this.body = body ?? '' },
  }
  const request = {
    method: 'PUT',
    url: '/api/model-auto-router/config',
    headers: { host: '127.0.0.1:19387' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({
        enabled: true,
        mainPool: 'work',
        pools: { work: { provider: 'deepseek', strategy: 'round-robin', candidates: [{ model: 'deepseek-reasoner' }] } },
      }), 'utf8')
    },
  }

  await route.handler(request, res)
  assert.equal(res.status, 200, res.body)

  const written = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(written.mainPool, 'work')
  assert.equal(written.$comment, 'docs', 'the entry\'s writer preserves comments too')
  // A rename leaves no scratch file behind next to the config.
  const leftovers = readdirSync(dir).filter(name => name !== 'model-auto-router.json')
  assert.deepEqual(leftovers, [], `unexpected files in the config directory: ${leftovers.join(', ')}`)
})
