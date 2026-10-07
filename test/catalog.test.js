/**
 * Tests for the provider/model inventory reader.
 *
 * Two failure modes matter more than the happy path here, because both are
 * silent: a third-party adapter that hangs must not hold the settings request
 * open, and a provider that fails must not erase the providers that answered.
 * The inventory is also advice rather than authority, so nothing it returns may
 * turn into a rejected config.
 *
 * Run: node --test test/catalog.test.js
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildCatalog, createCatalogReader, createRouteObserver, normalizeModels } from '../src/catalog.js'

/** A stub `llm` service with only the members the reader uses. */
function fakeLlm({ providers = [], configurable = [], models = {}, fail = {} } = {}) {
  const calls = []
  return {
    calls,
    listProviders: () => providers,
    listConfigurableProviders: () => configurable,
    listModels(provider) {
      calls.push(provider)
      if (fail[provider] === 'throw') return Promise.reject(new Error(`${provider} is down`))
      if (fail[provider] === 'hang') return new Promise(() => {})
      return Promise.resolve(models[provider] ?? [])
    },
  }
}

test('the catalog carries providers with their models', () => {
  const catalog = buildCatalog({
    providers: [{ id: 'our-free-model', name: 'Our Free Model' }, { id: 'deepseek', name: 'DeepSeek' }],
    models: { 'our-free-model': [{ id: 'space-bunny-free', name: 'Space Bunny' }], deepseek: [] },
    discoveredAt: 7,
  })
  assert.equal(catalog.discoveredAt, 7)
  assert.deepEqual(catalog.providers.map(p => p.id), ['our-free-model', 'deepseek'])
  assert.deepEqual(catalog.providers[0].models, [{ id: 'space-bunny-free', name: 'Space Bunny' }])
  assert.deepEqual(catalog.providers[1].models, [], 'a provider with no advertised models still appears')
})

test('a provider with no name falls back to its route id', () => {
  const catalog = buildCatalog({ providers: [{ id: 'bare' }] })
  assert.equal(catalog.providers[0].name, 'bare')
})

test('a declared-but-dormant route is offered separately from live providers', () => {
  const catalog = buildCatalog({
    providers: [{ id: 'deepseek', name: 'DeepSeek' }],
    configurable: [{ provider: 'pi-ai', displayName: 'pi-ai' }, { provider: 'deepseek', displayName: 'Duplicate' }],
  })
  assert.deepEqual(catalog.declared, [{ id: 'pi-ai', name: 'pi-ai' }], 'the live route is not repeated as dormant')
})

test('adapter output is coerced, not trusted', () => {
  // Adapters are third-party code: a malformed entry must not reach the page as
  // an undefined row it would then render as a blank suggestion.
  assert.deepEqual(normalizeModels([
    { id: 'a', name: 'A' },
    { id: 'a', name: 'duplicate' },
    { id: '  ' },
    { name: 'no id' },
    null,
    'string',
    { id: 'b' },
  ]), [{ id: 'a', name: 'A' }, { id: 'b', name: 'b' }])
  assert.deepEqual(normalizeModels('not an array'), [])
})

test('a gather reads providers and their models once', async () => {
  const llm = fakeLlm({
    providers: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    models: { a: [{ id: 'a-1' }], b: [{ id: 'b-1' }] },
  })
  const read = createCatalogReader({ resolveLlm: () => llm, now: () => 1000 })

  const catalog = await read()
  assert.deepEqual(catalog.providers.map(p => p.id), ['a', 'b'])
  assert.deepEqual(llm.calls.sort(), ['a', 'b'])
  assert.equal(catalog.discoveredAt, 1000)
})

test('a repeated read inside the TTL does not ask the adapters again', async () => {
  // The page polls its state every few seconds; re-interrogating every provider
  // on that cadence would turn a settings panel into steady outbound traffic.
  const llm = fakeLlm({ providers: [{ id: 'a', name: 'A' }], models: { a: [] } })
  let clock = 1000
  const read = createCatalogReader({ resolveLlm: () => llm, ttlMs: 60_000, now: () => clock })

  await read()
  clock = 30_000
  await read()
  assert.equal(llm.calls.length, 1, 'the second read was served from cache')

  clock = 61_001
  await read()
  assert.equal(llm.calls.length, 2, 'the read after the TTL re-interrogated')
})

test('one failing provider does not erase the others', async () => {
  const llm = fakeLlm({
    providers: [{ id: 'good', name: 'Good' }, { id: 'bad', name: 'Bad' }],
    models: { good: [{ id: 'g' }] },
    fail: { bad: 'throw' },
  })
  const logged = []
  const read = createCatalogReader({ resolveLlm: () => llm, log: message => logged.push(message) })

  const catalog = await read()
  assert.deepEqual(catalog.providers.map(p => p.id), ['good', 'bad'], 'the failing provider is still listed')
  assert.deepEqual(catalog.providers[0].models, [{ id: 'g', name: 'g' }], 'the healthy provider kept its models')
  assert.deepEqual(catalog.providers[1].models, [])
  assert.match(catalog.providers[1].error, /is down/, 'and it carries why')
  assert.equal(logged.length, 1, 'the failure is logged once')
})

test('a provider that never answers is abandoned, not awaited forever', async () => {
  const llm = fakeLlm({
    providers: [{ id: 'slow', name: 'Slow' }, { id: 'fast', name: 'Fast' }],
    models: { fast: [{ id: 'f' }] },
    fail: { slow: 'hang' },
  })
  const read = createCatalogReader({ resolveLlm: () => llm, timeoutMs: 30 })

  const catalog = await read()
  assert.deepEqual(catalog.providers.map(p => p.id), ['slow', 'fast'])
  assert.match(catalog.providers[0].error, /timed out/, 'the hang is reported as a timeout')
  assert.deepEqual(catalog.providers[1].models, [{ id: 'f', name: 'f' }], 'the other provider still answered')
})

test('a composition without an llm service offers an empty inventory', async () => {
  // Not an error: the page falls back to plain free-text fields, and every
  // route the operator types stays valid.
  const read = createCatalogReader({ resolveLlm: () => undefined, now: () => 5 })
  const catalog = await read()
  assert.deepEqual(catalog.providers, [])
  assert.deepEqual(catalog.declared, [])
})

test('a service missing listModels still reports its providers', async () => {
  const read = createCatalogReader({ resolveLlm: () => ({ listProviders: () => [{ id: 'a', name: 'A' }] }) })
  const catalog = await read()
  assert.deepEqual(catalog.providers, [{ id: 'a', name: 'A', models: [] }])
})

test('concurrent reads share one gather', async () => {
  const llm = fakeLlm({ providers: [{ id: 'a', name: 'A' }], models: { a: [] } })
  const read = createCatalogReader({ resolveLlm: () => llm })

  const [first, second] = await Promise.all([read(), read()])
  assert.deepEqual(first, second)
  assert.equal(llm.calls.length, 1, 'the second caller joined the in-flight gather')
})

test('a failed gather is not cached, so the next read retries it', async () => {
  let boom = true
  const llm = {
    listProviders: () => { if (boom) throw new Error('registry exploded'); return [{ id: 'a', name: 'A' }] },
    listConfigurableProviders: () => [],
  }
  const read = createCatalogReader({ resolveLlm: () => llm })

  await assert.rejects(() => read(), /registry exploded/)
  boom = false
  const catalog = await read()
  assert.deepEqual(catalog.providers.map(p => p.id), ['a'], 'the retry succeeded rather than replaying the failure')
})

// ── the runtime observer ─────────────────────────────────────────────────────

test('the observer counts the routes this host dispatches', () => {
  const observer = createRouteObserver()
  observer.remember({ provider: 'our-free-model', model: 'space-bunny-free' })
  observer.remember({ provider: 'our-free-model', model: 'space-bunny-free' })
  observer.remember({ provider: 'deepseek', model: 'deepseek-chat' })

  assert.deepEqual(observer.list(), [
    { provider: 'our-free-model', model: 'space-bunny-free', count: 2 },
    { provider: 'deepseek', model: 'deepseek-chat', count: 1 },
  ], 'most-used first, so the page offers the routes that matter')
})

test('the observer ignores a route it cannot learn anything from', () => {
  const observer = createRouteObserver()
  for (const route of [{}, { provider: 'a' }, { model: 'b' }, { provider: '', model: 'b' }, { provider: 'a', model: '  ' }, null, undefined]) {
    observer.remember(route)
  }
  assert.deepEqual(observer.list(), [], 'a call config with no real route teaches nothing')
})

test('the observer stays bounded, dropping the least-used route', () => {
  // A long-lived host must not accumulate routes without limit, and the ones
  // worth keeping are the ones still being used.
  const observer = createRouteObserver({ max: 3 })
  for (const model of ['a', 'b', 'c']) observer.remember({ provider: 'p', model })
  observer.remember({ provider: 'p', model: 'a' })
  observer.remember({ provider: 'p', model: 'd' })

  const routes = observer.list().map(entry => entry.model).sort()
  assert.deepEqual(routes, ['a', 'c', 'd'], 'the least-used route was evicted')
  assert.equal(routes.length, 3)
})

// ── observed routes reach the page ───────────────────────────────────────────

test('observed routes and the default selection reach the catalog', async () => {
  // This is what keeps the page useful when an adapter declines to describe
  // itself: the routes are real because they were dispatched, not advertised.
  const observer = createRouteObserver()
  observer.remember({ provider: 'our-free-model', model: 'space-bunny-free' })
  observer.remember({ provider: 'our-free-model', model: 'space-bunny-free' })

  const llm = fakeLlm({ providers: [{ id: 'our-free-model', name: 'Our Free Model' }], models: { 'our-free-model': [] } })
  const read = createCatalogReader({
    resolveLlm: () => llm,
    observed: () => observer.list(),
    defaults: () => ({ provider: 'our-free-model-vision', model: 'space-bunny-free' }),
  })

  const catalog = await read()
  assert.deepEqual(catalog.observed, [{ provider: 'our-free-model', model: 'space-bunny-free', count: 2 }])
  assert.deepEqual(catalog.defaults, { provider: 'our-free-model-vision', model: 'space-bunny-free' })
  // The provider's own list stays empty — the observation is reported as what it
  // is, so the page can say where a suggestion came from.
  assert.deepEqual(catalog.providers[0].models, [])
})

test('a host with no llm registry still reports what it has used', async () => {
  const read = createCatalogReader({
    resolveLlm: () => undefined,
    observed: () => [{ provider: 'p', model: 'm', count: 1 }],
    defaults: () => ({ provider: 'q', model: 'n' }),
  })

  const catalog = await read()
  assert.equal(catalog.catalogUnavailable, true, 'the page is told the registry was unreadable')
  assert.deepEqual(catalog.observed, [{ provider: 'p', model: 'm', count: 1 }])
  assert.deepEqual(catalog.defaults, { provider: 'q', model: 'n' })
})

test('a malformed default selection is dropped rather than rendered', () => {
  assert.equal(buildCatalog({ defaults: { provider: 'a' } }).defaults, undefined)
  assert.equal(buildCatalog({ defaults: { model: 'b' } }).defaults, undefined)
  assert.equal(buildCatalog({ defaults: 'nonsense' }).defaults, undefined)
  assert.deepEqual(buildCatalog({ defaults: { provider: ' a ', model: ' b ' } }).defaults, { provider: 'a', model: 'b' })
})

test('a provider that only ever appeared as an observation still surfaces', () => {
  const catalog = buildCatalog({
    providers: [],
    observed: [{ provider: 'unlisted', model: 'm', count: 3 }],
  })
  assert.deepEqual(catalog.providers, [])
  assert.deepEqual(catalog.observed, [{ provider: 'unlisted', model: 'm', count: 3 }], 'the page can still offer it')
})

test('a source that throws does not take the catalog down', async () => {
  // `observed` and `defaults` read host services that may not be mounted; a
  // throw there must not cost the page the adapter inventory as well.
  const llm = fakeLlm({ providers: [{ id: 'a', name: 'A' }], models: { a: [{ id: 'a-1' }] } })
  const read = createCatalogReader({
    resolveLlm: () => llm,
    observed: () => { throw new Error('no routing lane') },
    defaults: () => { throw new Error('no default model service') },
  })

  const catalog = await read()
  assert.deepEqual(catalog.providers[0].models, [{ id: 'a-1', name: 'a-1' }])
  assert.deepEqual(catalog.observed, [])
  assert.equal(catalog.defaults, undefined)
})
