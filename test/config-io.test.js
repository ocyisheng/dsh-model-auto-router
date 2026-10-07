/**
 * Tests for the pure config layer behind the settings page.
 *
 * The properties that matter here are the ones a settings page gets wrong
 * silently: a round trip that quietly rewrites the file's own documentation, a
 * validation that accepts a config the router will refuse on its next load, or
 * a write that lands on disk before it has been checked.
 *
 * Run: node --test test/config-io.test.js
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LIMITS,
  commentKeysOf,
  fromDraft,
  readConfig,
  serializeConfig,
  toDraft,
  validateConfig,
  writeConfig,
} from '../src/config-io.js'

/** An in-memory file so no test touches the real disk. */
function memoryIo(initial) {
  const files = new Map(initial === undefined ? [] : [[initial.path, initial.text]])
  return {
    files,
    read: path => files.get(path),
    exists: path => files.has(path),
    write: (path, text) => { files.set(path, text) },
  }
}

const CONFIG = '/tmp/model-auto-router.json'

test('an absent config projects to working defaults', () => {
  const { config, existed } = toDraft(undefined)
  assert.equal(existed, false)
  assert.equal(config.enabled, true)
  assert.equal(config.mainPool, 'main')
  assert.equal(config.health.failureThreshold, 2)
  // A fresh install must show something routable rather than an empty page,
  // and every role default has to name a pool the defaults actually declare.
  assert.ok(Object.keys(config.pools).length > 0, 'defaults name at least one pool')
  assert.ok(config.mainPool in config.pools, 'the default main pool exists')
  assert.ok(config.fallbackPool in config.pools, 'the default fallback pool exists')
  assert.equal(validateConfig(config).ok, true, 'the projected defaults save without edits')
})

test('a role is never defaulted to a pool the file does not declare', () => {
  const { config } = toDraft({ pools: { work: { provider: 'p', candidates: ['m'] } } })
  // The file never mentioned a fallback, and it declares no "backup" pool, so
  // the page must show "(none)" rather than a pointer that fails validation.
  assert.equal(config.fallbackPool, '')
  assert.equal(config.mainPool, '')
  assert.equal(validateConfig(config).ok, true, 'the projection is saveable as it stands')
})

test('an explicit role pointer is kept even when it dangles', () => {
  const { config } = toDraft({
    mainPool: 'gone',
    pools: { work: { provider: 'p', candidates: ['m'] } },
  })
  // Kept, not silently rewritten: the user needs to see what the file says and
  // the page surfaces it as a validation error to fix.
  assert.equal(config.mainPool, 'gone')
  assert.equal(validateConfig(config).ok, false)
})

test('comment keys are preserved, nested ones included', () => {
  const previous = {
    $comment: 'keep me',
    $comment_main: 'and me',
    enabled: true,
    health: { $comment_threshold: 'threshold docs', failureThreshold: 3, cooldownMs: 1000 },
    pools: { main: { $comment: 'pool docs', provider: 'deepseek', candidates: ['deepseek-chat'] } },
  }

  const draft = toDraft(previous)
  assert.deepEqual(commentKeysOf(previous), ['$comment', '$comment_main'])

  const io = memoryIo()
  const result = writeConfig(io, CONFIG, draft.config, previous)
  assert.equal(result.ok, true)

  const reloaded = readConfig(io, CONFIG)
  assert.equal(reloaded.ok, true, 'the written file is still valid JSON')
  assert.equal(reloaded.config.$comment, 'keep me')
  assert.equal(reloaded.config.$comment_main, 'and me')
  assert.equal(reloaded.config.health.$comment_threshold, 'threshold docs', 'a nested comment survives')
  assert.equal(reloaded.config.pools.main.$comment, 'pool docs', 'a per-pool comment survives')
  assert.equal(reloaded.config.health.failureThreshold, 3, 'and the value it documents is unchanged')
  // Documentation reads first, exactly as the shipped sample lays it out.
  assert.deepEqual(Object.keys(reloaded.config).slice(0, 2), ['$comment', '$comment_main'])
})

test('a file with no comments gains none', () => {
  const io = memoryIo()
  const result = writeConfig(io, CONFIG, toDraft(undefined).config, undefined)
  assert.equal(result.ok, true)
  assert.equal(result.config.$comment, undefined)
})

test('a string candidate is shown as inheriting the pool provider', () => {
  const { config } = toDraft({
    pools: { main: { provider: 'deepseek', candidates: ['deepseek-chat', { model: 'deepseek-reasoner' }] } },
  })
  // Empty means "inherit the pool"; the pool carries the provider either way.
  assert.deepEqual(config.pools.main.candidates, [
    { provider: '', model: 'deepseek-chat', weight: 1 },
    { provider: '', model: 'deepseek-reasoner', weight: 1 },
  ])
  assert.equal(config.pools.main.provider, 'deepseek')
})

test('a candidate restating its pool provider is collapsed to inheritance', () => {
  const { config } = toDraft({
    pools: { main: { provider: 'deepseek', candidates: [{ provider: 'deepseek', model: 'deepseek-chat' }] } },
  })
  assert.deepEqual(config.pools.main.candidates, [{ provider: '', model: 'deepseek-chat', weight: 1 }])
})

test('a candidate that repeats the pool provider keeps the shorthand on save', () => {
  const draft = toDraft({
    pools: { main: { provider: 'deepseek', candidates: ['deepseek-chat', 'deepseek-reasoner'] } },
  })
  const saved = fromDraft(draft.config)
  assert.deepEqual(saved.pools.main.candidates, [{ model: 'deepseek-chat' }, { model: 'deepseek-reasoner' }])
  assert.equal(saved.pools.main.provider, 'deepseek', 'the pool still carries its provider')
})

test('a candidate with its own provider keeps it on save', () => {
  const draft = toDraft({
    pools: { mixed: { provider: 'deepseek', candidates: ['deepseek-chat', { provider: 'openai', model: 'gpt-5' }] } },
  })
  const saved = fromDraft(draft.config)
  assert.deepEqual(saved.pools.mixed.candidates, [
    { model: 'deepseek-chat' },
    { provider: 'openai', model: 'gpt-5' },
  ])
})

test('an unassigned role is omitted rather than written as an empty string', () => {
  const saved = fromDraft({
    enabled: true,
    mainPool: 'main',
    subagentPool: '',
    fallbackPool: '',
    health: {},
    pools: { main: { provider: 'deepseek', candidates: [{ model: 'deepseek-chat' }] } },
  })
  assert.equal(saved.mainPool, 'main')
  assert.ok(!('subagentPool' in saved), 'an empty subagent pool is not written')
  assert.ok(!('fallbackPool' in saved), 'an empty fallback pool is not written')
})

test('a non-default weight is preserved and a default one is not written', () => {
  const saved = fromDraft({
    enabled: true,
    health: {},
    pools: { main: { provider: 'p', candidates: [{ model: 'a', weight: 3 }, { model: 'b', weight: 1 }] } },
  })
  assert.deepEqual(saved.pools.main.candidates, [{ model: 'a', weight: 3 }, { model: 'b' }])
})

test('validation collects every problem at once', () => {
  const result = validateConfig({
    mainPool: 'nope',
    health: { failureThreshold: 0, cooldownMs: 'soon' },
    pools: { main: { strategy: 'chaos', candidates: ['orphan'] } },
  })
  assert.equal(result.ok, false)
  // One error per broken field, so the page can list them together.
  assert.ok(result.errors.length >= 4, `expected several errors, got ${JSON.stringify(result.errors)}`)
  assert.ok(result.errors.some(line => line.includes('no pool called "nope"')), 'dangling role pointer')
  assert.ok(result.errors.some(line => line.includes('failureThreshold')), 'bad threshold')
  assert.ok(result.errors.some(line => line.includes('cooldownMs')), 'bad cooldown')
  assert.ok(result.errors.some(line => line.includes('chaos')), 'bad strategy')
})

test('a string candidate without any provider is refused', () => {
  const result = validateConfig({ pools: { main: { candidates: ['orphan'] } } })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some(line => line.includes('needs a provider')), result.errors.join('; '))
})

test('a fractional threshold is refused but a fractional weight is allowed', () => {
  assert.equal(validateConfig({ health: { failureThreshold: 1.5 } }).ok, false)
  assert.equal(validateConfig({ health: { cooldownMs: 1500 } }).ok, true)
  assert.equal(validateConfig({ pools: { m: { provider: 'p', candidates: [{ model: 'a', weight: 0.5 }] } } }).ok, true)
})

test('a weight outside the supported range is refused', () => {
  const result = validateConfig({ pools: { m: { provider: 'p', candidates: [{ model: 'a', weight: 5000 }] } } })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some(line => line.includes('outside')), result.errors.join('; '))
  assert.equal(LIMITS.weight.max, 1000)
})

test('an empty config is valid: only pools make routing do anything', () => {
  assert.equal(validateConfig({}).ok, true)
})

test('a missing file is not an error and is reported as absent', () => {
  const io = memoryIo()
  const result = readConfig(io, CONFIG)
  assert.equal(result.ok, true)
  assert.equal(result.existed, false)
  assert.deepEqual(result.config, {})
})

test('an empty file is a fresh install, not a parse failure', () => {
  const io = memoryIo({ path: CONFIG, text: '   \n' })
  const result = readConfig(io, CONFIG)
  assert.equal(result.ok, true)
  assert.equal(result.existed, true)
})

test('a malformed file is reported instead of thrown', () => {
  const io = memoryIo({ path: CONFIG, text: '{ not json' })
  const result = readConfig(io, CONFIG)
  assert.equal(result.ok, false)
  assert.ok(result.error.includes('not valid JSON'), result.error)
})

test('a file holding an array is refused', () => {
  const io = memoryIo({ path: CONFIG, text: '[1,2,3]' })
  const result = readConfig(io, CONFIG)
  assert.equal(result.ok, false)
  assert.ok(result.error.includes('must contain a JSON object'), result.error)
})

test('writeConfig refuses an invalid draft without touching the file', () => {
  const io = memoryIo({ path: CONFIG, text: '{"enabled":true}' })
  const result = writeConfig(io, CONFIG, { pools: { main: { candidates: ['orphan'] } } })
  assert.equal(result.ok, false)
  assert.ok(result.errors.length > 0, 'the rejection carries reasons')
  assert.equal(io.files.get(CONFIG), '{"enabled":true}', 'the file is left exactly as it was')
})

test('writeConfig validates, normalizes, then writes', () => {
  const io = memoryIo()
  const previous = { $comment: 'a note', enabled: true }
  const result = writeConfig(io, CONFIG, {
    enabled: true,
    mainPool: 'main',
    subagentPool: '',
    fallbackPool: '',
    inheritMain: false,
    health: { failureThreshold: 1, cooldownMs: 5000 },
    pools: { main: { provider: 'deepseek', strategy: 'round-robin', candidates: [{ model: 'deepseek-chat' }] } },
  }, previous)

  assert.equal(result.ok, true)
  assert.equal(result.config.health.failureThreshold, 1)
  assert.equal(result.config.inheritMain, false)

  const written = io.files.get(CONFIG)
  assert.ok(written !== undefined, 'the file was created')
  assert.ok(written.includes('a note'), 'the comment is carried into the file')
  // The written bytes must parse back to exactly what writeConfig returned.
  assert.deepEqual(JSON.parse(written), result.config)
})

test('a saved file loads back to the same draft it came from', () => {
  const io = memoryIo()
  const draft = toDraft({
    enabled: true,
    mainPool: 'main',
    fallbackPool: 'backup',
    health: { failureThreshold: 3, cooldownMs: 30_000 },
    pools: {
      main: { provider: 'deepseek', strategy: 'round-robin', candidates: ['deepseek-chat', 'deepseek-reasoner'] },
      backup: { candidates: [{ provider: 'openai', model: 'gpt-5' }] },
    },
  })

  const written = writeConfig(io, CONFIG, draft.config)
  assert.equal(written.ok, true)

  const reloaded = readConfig(io, CONFIG)
  assert.equal(reloaded.ok, true)
  assert.deepEqual(toDraft(reloaded.config).config, draft.config, 'the round trip is lossless')
})
