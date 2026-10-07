import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  createEffortReconciler,
  supportedEfforts,
  EFFORT_CACHE_MAX,
} from '../src/effort.js'

/** An `llm` stub whose resolveModelInfo answers per route. */
function llmStub(table) {
  return {
    calls: [],
    async resolveModelInfo(provider, model) {
      this.calls.push(`${provider}/${model}`)
      const entry = table[`${provider}/${model}`]
      if (entry === 'throw') throw new Error('unknown model')
      return entry
    },
  }
}

const reasoner = { reasoning: { efforts: [{ id: 'off' }, { id: 'balanced' }, { id: 'high' }], defaultEffort: 'balanced' } }
const plain = {} // a model that advertises no reasoning at all

describe('supportedEfforts', () => {
  it('reads the effort ids a model advertises', () => {
    assert.deepEqual([...supportedEfforts(reasoner)], ['off', 'balanced', 'high'])
  })

  it('reports nothing when the model advertises no reasoning', () => {
    // This is precisely the shape DSH rejects any requested effort for.
    assert.equal(supportedEfforts(plain), undefined)
    assert.equal(supportedEfforts(undefined), undefined)
    assert.equal(supportedEfforts({ reasoning: {} }), undefined)
  })

  it('ignores malformed entries instead of inventing an effort', () => {
    const efforts = supportedEfforts({ reasoning: { efforts: [{ id: 'high' }, {}, { id: '  ' }, null, 'high'] } })
    assert.deepEqual([...efforts], ['high'])
  })
})

describe('effort reconciliation', () => {
  it('keeps the effort when the chosen model accepts it', async () => {
    const llm = llmStub({ 'p/reasoner': reasoner })
    const reconcile = createEffortReconciler({ resolveLlm: () => llm })
    const effort = await reconcile(
      { provider: 'p', model: 'reasoner' },
      { provider: 'other', model: 'small', reasoningEffort: 'high' },
    )
    assert.equal(effort, 'high')
  })

  it('drops the effort when the chosen model does not accept it', async () => {
    // The reported failure: the pool's model takes no reasoning effort, and the
    // config asks for one. DSH would throw UNSUPPORTED_REASONING_EFFORT.
    const llm = llmStub({ 'our-free-model-vision/mimo-v2.5-free': plain })
    const reconcile = createEffortReconciler({ resolveLlm: () => llm })
    const effort = await reconcile(
      { provider: 'our-free-model-vision', model: 'mimo-v2.5-free' },
      { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
    )
    assert.equal(effort, undefined)
  })

  it('drops the effort when the model supports reasoning but not that level', async () => {
    const llm = llmStub({ 'p/limited': { reasoning: { efforts: [{ id: 'off' }, { id: 'low' }], defaultEffort: 'low' } } })
    const reconcile = createEffortReconciler({ resolveLlm: () => llm })
    assert.equal(
      await reconcile({ provider: 'p', model: 'limited' }, { reasoningEffort: 'max' }),
      undefined,
    )
    assert.equal(
      await reconcile({ provider: 'p', model: 'limited' }, { reasoningEffort: 'low' }),
      'low',
    )
  })

  it('reports nothing to change when no effort was requested', async () => {
    const llm = llmStub({ 'p/reasoner': reasoner })
    const reconcile = createEffortReconciler({ resolveLlm: () => llm })
    assert.equal(await reconcile({ provider: 'p', model: 'reasoner' }, {}), undefined)
    assert.equal(await reconcile({ provider: 'p', model: 'reasoner' }, { reasoningEffort: '   ' }), undefined)
    // No effort means nothing to look up, either.
    assert.deepEqual(llm.calls, [])
  })

  it('leaves the effort alone when the router did not change the model', async () => {
    // DSH resolved this exact pair itself, so the effort is already known-good
    // and a lookup would be pure cost.
    const llm = llmStub({ 'p/reasoner': reasoner })
    const reconcile = createEffortReconciler({ resolveLlm: () => llm })
    const effort = await reconcile(
      { provider: 'p', model: 'reasoner' },
      { provider: 'p', model: 'reasoner', reasoningEffort: 'max' },
    )
    assert.equal(effort, 'max', 'even an effort the model does not list is left alone')
    assert.deepEqual(llm.calls, [], 'and no capability lookup happens')
  })

  it('drops the effort when the capability cannot be learned', async () => {
    // An error must not fail the request: dropping is always valid, and DSH
    // reports an unresolvable model on its own.
    const llm = llmStub({ 'p/gone': 'throw' })
    const logs = []
    const reconcile = createEffortReconciler({ resolveLlm: () => llm, log: message => logs.push(message) })
    const effort = await reconcile({ provider: 'p', model: 'gone' }, { reasoningEffort: 'high' })
    assert.equal(effort, undefined)
    assert.equal(logs.length, 1, 'the reason is logged once')
  })

  it('drops the effort when the llm service cannot resolve anything', async () => {
    for (const llm of [undefined, {}, { resolveModelInfo: 'not a function' }]) {
      const reconcile = createEffortReconciler({ resolveLlm: () => llm })
      assert.equal(
        await reconcile({ provider: 'p', model: 'm' }, { reasoningEffort: 'high' }),
        undefined,
        `llm=${JSON.stringify(llm)}`,
      )
    }
  })

  it('caches capabilities instead of asking per request', async () => {
    const llm = llmStub({ 'p/reasoner': reasoner })
    const reconcile = createEffortReconciler({ resolveLlm: () => llm })
    for (let i = 0; i < 5; i++) {
      await reconcile({ provider: 'p', model: 'reasoner' }, { reasoningEffort: 'high' })
    }
    assert.deepEqual(llm.calls, ['p/reasoner'], 'one lookup for five requests')
  })

  it('re-reads capabilities once the cache entry expires', async () => {
    let clock = 1_000
    const llm = llmStub({ 'p/reasoner': reasoner })
    const reconcile = createEffortReconciler({
      resolveLlm: () => llm,
      ttlMs: 100,
      now: () => clock,
    })
    await reconcile({ provider: 'p', model: 'reasoner' }, { reasoningEffort: 'high' })
    clock += 50
    await reconcile({ provider: 'p', model: 'reasoner' }, { reasoningEffort: 'high' })
    assert.equal(llm.calls.length, 1, 'still cached')
    clock += 100
    await reconcile({ provider: 'p', model: 'reasoner' }, { reasoningEffort: 'high' })
    assert.equal(llm.calls.length, 2, 're-read after the TTL')
  })

  it('remembers a failed lookup for the TTL rather than retrying per request', async () => {
    const llm = llmStub({ 'p/gone': 'throw' })
    const reconcile = createEffortReconciler({ resolveLlm: () => llm, log: () => {} })
    for (let i = 0; i < 4; i++) {
      await reconcile({ provider: 'p', model: 'gone' }, { reasoningEffort: 'high' })
    }
    assert.equal(llm.calls.length, 1, 'the failure is cached too')
  })

  it('does not grow without bound', async () => {
    const table = {}
    for (let i = 0; i < EFFORT_CACHE_MAX + 40; i++) table[`p/m${i}`] = reasoner
    const llm = llmStub(table)
    const reconcile = createEffortReconciler({ resolveLlm: () => llm })
    for (let i = 0; i < EFFORT_CACHE_MAX + 40; i++) {
      await reconcile({ provider: 'p', model: `m${i}` }, { reasoningEffort: 'high' })
    }
    // Every route is still answered correctly; the point is only that the cache
    // is pruned rather than kept forever.
    assert.equal(await reconcile({ provider: 'p', model: 'm7' }, { reasoningEffort: 'high' }), 'high')
  })

  it('abandons a lookup that never answers', async () => {
    const llm = { resolveModelInfo: () => new Promise(() => {}) }
    const logs = []
    const reconcile = createEffortReconciler({
      resolveLlm: () => llm,
      log: message => logs.push(message),
      timeoutMs: 20,
    })
    const effort = await reconcile({ provider: 'p', model: 'stuck' }, { reasoningEffort: 'high' })
    assert.equal(effort, undefined, 'a hung lookup drops the effort rather than hanging the turn')
    assert.equal(logs.length, 1)
  })
})
