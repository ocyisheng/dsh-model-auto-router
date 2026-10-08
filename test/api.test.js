/**
 * Tests for the settings page's HTTP surface.
 *
 * The properties worth pinning here are the ones a settings API gets wrong
 * quietly: a save that reports success while the running router still uses the
 * old pools, a rejected draft that reaches the disk anyway, and — because this
 * prefix outranks the kernel's own `/api` check — a route that answers a caller
 * the app itself would refuse.
 *
 * Run: node --test test/api.test.js
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { API_PREFIX, createApiRoutes } from '../src/api.js'
import { ModelAutoRouter } from '../src/router.js'

/** A fresh temp config path, cleaned up with the test. */
function useTempConfig(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-model-auto-router-api-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'model-auto-router.json')
}

/** A request as the web server would hand it to a prefix handler. */
function makeRequest(options = {}) {
  const { method = 'GET', path = '/state', headers = {}, body } = options
  const text = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
  const chunks = text === undefined ? [] : [Buffer.from(text, 'utf8')]
  return {
    method,
    url: `${API_PREFIX}${path}`,
    headers: { host: '127.0.0.1:19387', ...headers },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** A response that records what the handler wrote. */
function makeResponse() {
  const state = { status: 0, headers: {}, body: '' }
  return {
    state,
    writeHead(status, headers) {
      state.status = status
      Object.assign(state.headers, headers)
    },
    end(body) {
      state.body = body ?? ''
    },
    /** Parsed body, or undefined for an empty one. */
    json() {
      return state.body === '' ? undefined : JSON.parse(state.body)
    },
  }
}

/** Build the handler against a real file and a real router. */
function setup(t, initial, options = {}) {
  const configPath = useTempConfig(t)
  if (initial !== undefined) writeFileSync(configPath, JSON.stringify(initial, null, 2), 'utf8')

  const router = new ModelAutoRouter({ log: () => {} })
  if (initial !== undefined) router.configure(initial)

  const handler = createApiRoutes({
    router,
    configPath,
    version: 'test',
    catalog: options.catalog ?? (async () => ({ providers: [], declared: [], discoveredAt: 0 })),
    warn: options.warn,
    io: {
      read: path => (existsSync(path) ? readFileSync(path, 'utf8') : undefined),
      exists: existsSync,
      write: (path, text) => writeFileSync(path, text, 'utf8'),
    },
  })

  return { router, handler, configPath }
}

/** Run one request through the handler and return the response state. */
async function call(handler, options) {
  const res = makeResponse()
  await handler(makeRequest(options), res)
  return res
}

const DRAFT = {
  enabled: true,
  mainPool: 'work',
  subagentPool: '',
  fallbackPool: '',
  inheritMain: true,
  health: { failureThreshold: 2, cooldownMs: 60_000 },
  pools: {
    work: { provider: 'deepseek', strategy: 'primary-failover', candidates: [{ provider: '', model: 'deepseek-chat' }] },
  },
}

test('GET /state answers with the file projected as an editable draft', async (t) => {
  const { handler, configPath } = setup(t, {
    $comment: 'docs',
    mainPool: 'main',
    pools: { main: { provider: 'deepseek', candidates: ['deepseek-chat'] } },
  })

  const res = await call(handler, { path: '/state' })
  assert.equal(res.state.status, 200)
  assert.equal(res.state.headers['cache-control'], 'no-store')

  const payload = res.json()
  assert.equal(payload.configPath, configPath)
  assert.equal(payload.config.mainPool, 'main')
  assert.deepEqual(payload.commentKeys, ['$comment'], 'the page is told which comments are kept')
  assert.equal(payload.version, 'test')
  assert.equal(payload.validation.ok, true)
  assert.ok(payload.runtime !== undefined, 'live state rides along')
})

test('GET /state on a missing file offers saveable defaults', async (t) => {
  const { handler } = setup(t)
  const payload = (await call(handler, { path: '/state' })).json()
  assert.equal(payload.fileExists, false)
  assert.equal(payload.config.mainPool, 'main')
  assert.equal(payload.validation.ok, true, 'the offered defaults save without edits')
})

test('PUT /config writes the file and the running router picks the change up at once', async (t) => {
  const { handler, router, configPath } = setup(t, {
    mainPool: 'old',
    pools: { old: { provider: 'deepseek', candidates: ['deepseek-chat'] } },
  })

  assert.equal(router.select({ agent: { id: 's1' } }).model, 'deepseek-chat')

  const res = await call(handler, {
    method: 'PUT',
    path: '/config',
    headers: { 'content-type': 'application/json' },
    body: {
      ...DRAFT,
      pools: { work: { provider: 'deepseek', candidates: ['deepseek-reasoner'] } },
    },
  })

  assert.equal(res.state.status, 200, res.state.body)
  const payload = res.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.state.config.mainPool, 'work', 'the response carries the state after the save')

  // The file is the record...
  const written = JSON.parse(readFileSync(configPath, 'utf8'))
  assert.equal(written.mainPool, 'work')
  assert.deepEqual(written.pools.work.candidates, [{ model: 'deepseek-reasoner' }])

  // ...and the router is already using it, without waiting for the file watcher.
  assert.equal(router.select({ agent: { id: 's2' } }).model, 'deepseek-reasoner')
})

test('a save keeps the file\'s own comment documentation', async (t) => {
  const { handler, configPath } = setup(t, {
    $comment: 'read me',
    mainPool: 'main',
    health: { $comment_threshold: 'threshold docs', failureThreshold: 2, cooldownMs: 1000 },
    pools: { main: { $comment: 'pool docs', provider: 'deepseek', candidates: ['deepseek-chat'] } },
  })

  // A draft that keeps the same roster, which is what the page sends when the
  // user has not renamed anything.
  const res = await call(handler, {
    method: 'PUT',
    path: '/config',
    body: {
      ...DRAFT,
      mainPool: 'main',
      pools: { main: { provider: 'deepseek', strategy: 'primary-failover', candidates: [{ model: 'deepseek-chat' }] } },
    },
  })
  assert.equal(res.state.status, 200, res.state.body)

  const written = JSON.parse(readFileSync(configPath, 'utf8'))
  assert.equal(written.$comment, 'read me', 'a top-level comment survives')
  assert.equal(written.health.$comment_threshold, 'threshold docs', 'a nested comment survives')
  assert.equal(written.pools.main.$comment, 'pool docs', 'a pool-level comment survives')
  assert.equal(written.pools.main.candidates[0].model, 'deepseek-chat', 'and the route it documents')
})

test('an invalid draft is refused, the file is untouched and the router keeps routing', async (t) => {
  const initial = {
    mainPool: 'main',
    pools: { main: { provider: 'deepseek', candidates: ['deepseek-chat'] } },
  }
  const { handler, router, configPath } = setup(t, initial)
  const before = readFileSync(configPath, 'utf8')

  const res = await call(handler, {
    method: 'PUT',
    path: '/config',
    body: { mainPool: 'ghost', pools: { main: { candidates: ['orphan'] } } },
  })

  assert.equal(res.state.status, 400)
  const payload = res.json()
  assert.ok(Array.isArray(payload.errors) && payload.errors.length > 0, 'the refusal explains itself')
  assert.equal(readFileSync(configPath, 'utf8'), before, 'the file did not change')
  assert.equal(router.select({ agent: { id: 's1' } }).model, 'deepseek-chat', 'routing still works')
})

test('a non-loopback Host is refused', async (t) => {
  const { handler } = setup(t)
  const res = await call(handler, { path: '/state', headers: { host: 'evil.example.com' } })
  assert.equal(res.state.status, 403)
  assert.equal(res.json().error, 'forbidden')
})

test('a cross-site fetch is refused', async (t) => {
  const { handler } = setup(t)
  const res = await call(handler, { path: '/state', headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(res.state.status, 403)
})

test('an Origin that is not this host is refused', async (t) => {
  const { handler } = setup(t)
  const res = await call(handler, { path: '/state', headers: { origin: 'http://attacker.test' } })
  assert.equal(res.state.status, 403)
})

test('a same-origin request passes the fence', async (t) => {
  const { handler } = setup(t)
  const res = await call(handler, {
    path: '/state',
    headers: { origin: 'http://127.0.0.1:19387', referer: 'http://127.0.0.1:19387/settings' },
  })
  assert.equal(res.state.status, 200)
})

test('the connection service\'s own admission wins when the composition mounts one', async (t) => {
  const configPath = useTempConfig(t)
  const router = new ModelAutoRouter({ log: () => {} })
  const handler = createApiRoutes({
    router,
    configPath,
    io: {
      read: () => undefined,
      exists: () => false,
      write: () => {},
    },
    // The kernel's own decision, which the plugin must never be weaker than.
    connection: { admit: () => ({ rejection: 401 }) },
  })

  const res = await call(handler, { path: '/state' })
  assert.equal(res.state.status, 401)
  assert.equal(res.json().error, 'unauthorized')
})

test('GET /catalog answers the inventory the page suggests from', async (t) => {
  const catalog = {
    providers: [{ id: 'our-free-model', name: 'Our Free Model', models: [{ id: 'space-bunny-free', name: 'Space Bunny' }] }],
    declared: [{ id: 'pi-ai', name: 'pi-ai' }],
    discoveredAt: 42,
  }
  const { handler } = setup(t, undefined, { catalog: async () => catalog })

  const res = await call(handler, { path: '/catalog' })
  assert.equal(res.state.status, 200)
  assert.deepEqual(res.json(), catalog)
})

test('a failing catalog gather answers an empty inventory, not a failed page', async (t) => {
  // The inventory is advice. Free-text routes stay valid without it, so a broken
  // adapter must degrade the page to plain fields rather than break it.
  const warnings = []
  const { handler } = setup(t, undefined, {
    catalog: async () => { throw new Error('registry exploded') },
    warn: message => warnings.push(message),
  })

  const res = await call(handler, { path: '/catalog' })
  assert.equal(res.state.status, 200)
  assert.deepEqual(res.json(), { providers: [], declared: [], discoveredAt: 0 })
  assert.equal(warnings.length, 1, 'the failure is still reported to the host log')
  assert.match(warnings[0], /registry exploded/)
})

test('the catalog route is behind the same trust fence as the rest', async (t) => {
  const { handler } = setup(t)
  const res = await call(handler, { path: '/catalog', headers: { host: 'evil.example.com' } })
  assert.equal(res.state.status, 403)
})

test('GET /report returns the routing report text', async (t) => {
  const { handler } = setup(t, {
    mainPool: 'main',
    pools: { main: { provider: 'deepseek', candidates: ['deepseek-chat'] } },
  })
  const payload = (await call(handler, { path: '/report' })).json()
  assert.ok(payload.text.includes('enabled'), payload.text)
  assert.ok(payload.text.includes('main pool'), payload.text)
})

test('an unknown route is a 404, not a silent success', async (t) => {
  const { handler } = setup(t)
  const res = await call(handler, { path: '/nope' })
  assert.equal(res.state.status, 404)
  assert.ok(res.json().error.includes('no route'), res.state.body)
})

test('a malformed JSON body is a 400, not a 500', async (t) => {
  const { handler, configPath } = setup(t)
  const res = await call(handler, {
    method: 'PUT',
    path: '/config',
    headers: { 'content-type': 'application/json' },
    body: '{ not json',
  })
  assert.equal(res.state.status, 400)
  assert.ok(res.json().error.includes('invalid JSON'), res.state.body)
  assert.equal(existsSync(configPath), false, 'nothing was written')
})

test('a body that is not an object is refused', async (t) => {
  const { handler } = setup(t)
  const res = await call(handler, { method: 'PUT', path: '/config', body: [1, 2, 3] })
  assert.equal(res.state.status, 400)
  assert.ok(res.json().error.includes('must be a config object'), res.state.body)
})

test('an empty roster is accepted and simply routes nothing', async (t) => {
  // Nothing here is *invalid* — a config with no candidates describes no route.
  // The router's own normalization drops such a pool, so the honest outcome is
  // a successful save and a router that defers to DSH.
  const { handler, router } = setup(t, {
    mainPool: 'main',
    pools: { main: { provider: 'deepseek', candidates: ['deepseek-chat'] } },
  })

  const res = await call(handler, {
    method: 'PUT',
    path: '/config',
    body: { enabled: true, pools: { main: { candidates: [] } } },
  })

  assert.equal(res.state.status, 200, res.state.body)
  assert.equal(router.select({ agent: { id: 's1' } }), undefined, 'an empty roster routes nothing')
})

test('a router that rejects a saved config is disabled, not allowed to break the host', async (t) => {
  // The API's field validation is stronger than the router's normalization, so
  // this safety net is nearly unreachable through the page — which is exactly
  // why it needs a direct test: it is the last line before a bad config takes
  // the routing lane down.
  const configPath = useTempConfig(t)
  const configured = []
  const fakeRouter = {
    configure(config) {
      configured.push(config)
      if (configured.length === 1) throw new TypeError('pools must be an object mapping pool names to pool definitions')
    },
    snapshot: () => ({ enabled: false, assignments: [] }),
    report: () => 'disabled',
  }

  const handler = createApiRoutes({
    router: fakeRouter,
    configPath,
    io: {
      read: path => (existsSync(path) ? readFileSync(path, 'utf8') : undefined),
      exists: existsSync,
      write: (path, text) => writeFileSync(path, text, 'utf8'),
    },
  })

  const res = await call(handler, { method: 'PUT', path: '/config', body: DRAFT })
  assert.equal(res.state.status, 200, res.state.body)
  assert.equal(configured.length, 2, 'the rejection triggered a fallback configure')
  assert.deepEqual(configured[0].mainPool, 'work', 'the saved config was attempted first')
  assert.deepEqual(configured[1], { enabled: false }, 'the router was left explicitly disabled')
  assert.equal(res.json().ok, true, 'the caller is told the file was written')
})
