/**
 * Tests for the browser half — the settings page bundle.
 *
 * This is the one file no other test can reach: it is not an ES module and it
 * never runs under Node in production, so a typo inside its render path would
 * otherwise only surface as a blank page in a real browser. The bundle is
 * loaded here through a stub `window.__ModuleLoader__` and rendered through a
 * small hook shim, which is enough to catch a broken registration, a missing
 * translation, a crash on the first paint, and a style rule referencing a theme
 * token this host does not have.
 *
 * Run: node --test test/client.test.js
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

/**
 * The host tokens this page may use.
 *
 * Grounded in the asar rather than in the Theme provider's `listTokens`, which
 * advertises only a subset: `label-tertiary` (367 uses), `bg-layer-3` (23) and
 * `state-business-primary` (197) are all *defined* by the host and used by its
 * own components, yet none of them appear in that list. Every entry below was
 * confirmed against a `--dsw-…:` definition in the shipped CSS.
 */
const THEME_TOKENS = new Set([
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-layer-3',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-bg-skeleton',
  '--dsw-alias-settings-card-fill',
  '--dsw-alias-settings-card-stroke',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-border-l3',
  '--dsw-alias-border-l4',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-label-caption',
  '--dsw-alias-label-dimmed',
  '--dsw-alias-label-primary-foreground',
  '--dsw-alias-state-business-primary',
  '--dsw-alias-state-business-tertiary',
  '--dsw-alias-button-primary-fill',
  '--dsw-alias-button-primary-hover',
  '--dsw-alias-button-primary-dimmed',
  '--dsw-alias-button-elevated-fill',
  '--dsw-alias-button-contrast-fill',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
  '--dsw-alias-state-warn-label',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-idle-primary',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-interactive-bg-hover-accent',
  '--dsw-alias-interactive-bg-active',
  '--dsw-alias-interactive-bg-hover-danger',
  '--dsw-alias-interactive-bg-hover-solid',
  '--dsw-alias-switch-thumb',
  '--dsw-alias-link',
  '--dsw-alias-brand-primary',
  '--dsw-radius-xs',
  '--dsw-radius-sm',
  '--dsw-radius-md',
  '--dsw-radius-lg',
  '--dsw-radius-xl',
  '--dsw-radius-panel',
])

/**
 * Tokens the shipped plugins use that the host does **not** define.
 *
 * `label-on-accent` and `state-warning-primary` appear in `dsh-our-free-model`'s
 * CSS but have no `--dsw-…:` definition anywhere in the asar, so a `var()`
 * reference to them is invalid at computed-value time — the declaration is
 * dropped rather than rendering. This page avoids both deliberately; the list
 * exists so a future edit cannot quietly reintroduce one.
 */
const UNDEFINED_TOKENS = new Set(['--dsw-alias-label-on-accent', '--dsw-alias-state-warning-primary'])

/** Values the next `useState` calls should return, for the render smoke test. */
let hookQueue = []

/**
 * Execute the bundle body once with stub globals and return what it produced.
 *
 * The body runs as a function rather than through `import` so the test controls
 * the globals it sees and does not depend on the module cache.
 *
 * @returns {{ definition: any, exports: any, styles: any[], context: () => any }}
 */
function bootBundle() {
  /** @type {any} */
  let captured
  const styles = []

  const createElement = (type, props, ...children) => {
    const merged = { ...(props ?? {}) }
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    // Function components are invoked eagerly. That is what turns a render into
    // a whole-tree smoke test instead of a check of the outermost element.
    if (typeof type === 'function') return type(merged)
    return { type, props: merged }
  }

  const react = {
    createElement,
    Fragment: Symbol('Fragment'),
    useState: initial => [hookQueue.length > 0 ? hookQueue.shift() : (typeof initial === 'function' ? initial() : initial), () => {}],
    useEffect: () => {},
    useMemo: fn => fn(),
    useCallback: fn => fn,
    useRef: value => ({ current: value }),
  }

  const windowStub = {
    __ModuleLoader__: { load: definition => { captured = definition } },
    confirm: () => true,
    localStorage: { getItem: () => null, setItem: () => {} },
  }
  const documentStub = {
    createElement: () => ({
      attributes: {},
      setAttribute(name, value) { this.attributes[name] = value },
      remove() {},
      textContent: '',
    }),
    head: { appendChild: element => styles.push(element), removeChild() {} },
  }

  const require = specifier => {
    if (specifier === 'react') return react
    throw new Error(`the bundle required an unexpected module: ${specifier}`)
  }

  new Function('window', 'document', 'require', `${source}\n;return undefined`)(windowStub, documentStub, require)
  assert.ok(captured !== undefined, 'the bundle called window.__ModuleLoader__.load')

  const exports = captured.factory(require)
  return { definition: captured, exports, styles, react }
}

/**
 * The minimum of the client Context the page touches.
 *
 * `effect` runs its callback immediately, so installing an effect also proves
 * the callback did not throw.
 */
function fakeContext() {
  const context = {
    dictionaries: [],
    registrations: [],
    labels: [],
    locale: {
      register(namespace, dicts) {
        context.dictionaries.push({ namespace, dicts })
        return () => {}
      },
      bind: () => key => key,
    },
    effect(callback, label) {
      context.labels.push(label)
      return callback()
    },
    slots: {
      inject: (key, callback) => callback(),
      register(options, component) {
        context.registrations.push({ options, component })
        return () => {}
      },
    },
  }
  return context
}

/** Load the bundle, apply it, and hand back the registered page component. */
function mountPage() {
  const { exports } = bootBundle()
  const ctx = fakeContext()
  exports.apply(ctx)
  assert.equal(ctx.registrations.length, 1, 'apply registered exactly one settings section')
  return { ctx, page: ctx.registrations[0].component, exports }
}

test('the bundle declares the plugin identity the host looks for', () => {
  const { definition, exports } = bootBundle()
  assert.equal(definition.id, 'dsh-model-auto-router', 'the bundle id must equal the package name')
  assert.equal(exports.name, 'dsh-model-auto-router')
  assert.deepEqual(exports.inject, ['slots', 'locale'], 'it needs the slot registry and the dictionary registry')
  assert.equal(typeof exports.apply, 'function')
})

test('apply registers the dictionaries, the styles and the settings section', () => {
  const { exports, styles } = bootBundle()
  const ctx = fakeContext()
  exports.apply(ctx)

  assert.deepEqual(ctx.dictionaries.map(entry => entry.namespace), ['settings.modelAutoRouter'])
  const dicts = ctx.dictionaries[0].dicts
  assert.ok(dicts.zh !== undefined && dicts.en !== undefined, 'both languages are registered')

  assert.equal(styles.length, 1, 'exactly one style element is injected')
  assert.equal(styles[0].attributes['data-plugin'], 'dsh-model-auto-router', 'styles are tagged for HMR cleanup')
  assert.ok(styles[0].textContent.includes('.mr_root'), 'the stylesheet actually carries the page CSS')

  const section = ctx.registrations[0].options
  assert.equal(section.name, 'settings.section')
  assert.equal(section.id, 'model-auto-router')
  assert.equal(typeof section.order, 'number', 'the nav order is set')
  assert.equal(typeof section.label, 'function', 'the nav label is localised lazily')
  assert.equal(section.locale, 'settings.modelAutoRouter')
})

test('every effect is labelled, so a failure names its owner', () => {
  const { ctx } = mountPage()
  assert.ok(ctx.labels.length > 0, 'effects were installed')
  for (const label of ctx.labels) {
    assert.equal(typeof label, 'string')
    assert.ok(label.startsWith('model-auto-router:'), `effect label "${label}" must be namespaced`)
  }
})

test('the page survives its first paint while the backend is still loading', () => {
  const { page } = mountPage()
  // The real registration supplies `t` through the slot's inject face.
  const tree = page({ t: key => key, close: () => {} })
  assert.equal(tree.type, 'div', 'the loading state renders a container')
  assert.equal(tree.props.className, 'mr_root')
})

test('the page renders its whole tree once state has arrived', () => {
  const draftConfig = {
    enabled: true,
    mainPool: 'main',
    subagentPool: '',
    fallbackPool: 'backup',
    inheritMain: true,
    health: { failureThreshold: 2, cooldownMs: 60_000 },
    pools: {
      main: {
        provider: 'deepseek',
        strategy: 'primary-failover',
        // The second candidate is one the catalog also offers, so the picker
        // renders a chip for it and this test can assert the three chip states:
        // used (in the target), elsewhere (in another list), and free.
        candidates: [
          { provider: '', model: 'deepseek-chat', weight: 1 },
          { provider: 'our-free-model', model: 'space-bunny-free', weight: 1 },
        ],
      },
      backup: {
        provider: '',
        strategy: 'weighted-random',
        candidates: [{ provider: 'our-free-model', model: 'mimo-v2.5-free', weight: 3 }],
      },
    },
  }
  const state = {
    version: '1.1.0',
    configPath: 'C:/Users/x/.dsh/model-auto-router.json',
    fileExists: true,
    fileError: '',
    config: draftConfig,
    commentKeys: ['$comment'],
    unknownKeys: ['customKey'],
    runtime: {
      enabled: true,
      main: { name: 'main', strategy: 'primary-failover', candidates: [{ label: 'deepseek/deepseek-chat', coolingDown: false }] },
      subagent: undefined,
      fallback: { name: 'backup', strategy: 'weighted-random', candidates: [{ label: 'openai/gpt-5', coolingDown: true }] },
      assignments: [{ agentId: 'abcdef1234567890', route: 'deepseek/deepseek-chat', pool: 'main', reason: 'selected', failovers: 0 }],
      health: [{ route: 'openai/gpt-5', failures: 1, coolingDown: true, cooldownRemainingMs: 5000 }],
      recentSwitches: [{ time: 1, agentId: 'abcdef1234567890', from: undefined, to: 'deepseek/deepseek-chat', reason: 'selected' }],
      options: { failureThreshold: 2, cooldownMs: 60_000 },
    },
    validation: { ok: true, errors: [] },
  }

  const { page, exports } = mountPage()

  // The catalog the page would have fetched from /catalog, indexed by the page's
  // own indexer — hand-rolling the indexed shape here would let the two drift.
  const catalog = exports.__test.indexCatalog({
    providers: [
      { id: 'our-free-model', name: 'Our Free Model', models: [{ id: 'space-bunny-free', name: 'Space Bunny' }, { id: 'mimo-v2.5-free', name: 'MiMo 2.5' }] },
      { id: 'deepseek', name: 'DeepSeek', models: [] },
    ],
    declared: [{ id: 'pi-ai', name: 'pi-ai' }],
    // A route this host really dispatched, on a provider that advertises
    // nothing — the case the observer exists for. It also carries a route on
    // the dormant `pi-ai` provider, which is what lets that badge render: a
    // dormant provider has no advertised models, so only an observed one gives
    // the picker anything to show for it.
    observed: [
      { provider: 'our-free-model-vision', model: 'space-bunny-free', count: 9 },
      { provider: 'pi-ai', model: 'pi-free', count: 2 },
    ],
    defaults: { provider: 'our-free-model-vision', model: 'space-bunny-free' },
    discoveredAt: 1,
  })

  // The page's own useState slots, in order: state, draft, baseline, error,
  // fieldErrors, busy, report, catalog, target — then the picker's filter and
  // its collapsed-provider set. Seeding them drives the page past its loading
  // branch without a reconciler.
  hookQueue = [state, draftConfig, draftConfig, '', [], false, '', catalog, 'main', '', new Set()]
  let tree
  try {
    tree = page({ t: key => key, close: () => {} })
  } finally {
    hookQueue = []
  }

  assert.equal(tree.type, 'div')
  const rendered = JSON.stringify(tree, (key, value) => (typeof value === 'symbol' ? String(value) : value))
  // Every section rendered, which means every child component executed rather
  // than being skipped by the eager renderer.
  assert.ok(rendered.includes('deepseek-chat'), 'the main list rendered')
  assert.ok(rendered.includes('space-bunny-free'), 'the backup list and inventory both rendered')
  assert.ok(rendered.includes('customKey'), 'the unmanaged-key warning rendered')
  assert.ok(rendered.includes('catalog.dormant'), 'a declared-but-dormant route is labelled as such')
  // The live line names the route the router is on right now.
  assert.ok(rendered.includes('deepseek/deepseek-chat'), 'the live status names the current route')

  // The per-list strategy select is what keeps a `round-robin` pool expressible
  // in a view that otherwise shows order only.
  const selects = []
  const walkSelects = node => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walkSelects); return }
    if (node.type === 'select') selects.push(node)
    walkSelects(node.props?.children)
  }
  walkSelects(tree)
  assert.ok(selects.length >= 2, `expected a strategy select per list, got ${selects.length}`)

  // Chips must be real buttons, not text: one click is the entire interaction
  // between seeing a model and having it in use.
  const chips = []
  const walk = node => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (typeof node.props?.className === 'string' && node.props.className.includes('mr_routechip')) chips.push(node)
    walk(node.props?.children)
  }
  walk(tree)
  assert.ok(chips.length > 0, 'the inventory rendered clickable route chips')
  assert.ok(chips.some(chip => chip.props.onClick !== undefined), 'each chip can add itself to a list')
  assert.ok(chips.some(chip => chip.props.disabled !== true), 'and a model not yet chosen is clickable')
  assert.ok(
    chips.some(chip => JSON.stringify(chip).includes('space-bunny-free')),
    'the observed route is offered even though its provider advertises no models',
  )

  // Providers collapse: each group header is a real toggle button carrying its
  // model count, and honours aria-expanded, so the inventory reads as two
  // levels — which providers, then which models — instead of one flat wall.
  const toggles = []
  const walkToggles = node => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walkToggles); return }
    if (typeof node.props?.className === 'string' && node.props.className.includes('mr_grouptoggle')) toggles.push(node)
    walkToggles(node.props?.children)
  }
  walkToggles(tree)
  assert.ok(toggles.length > 0, 'each provider group has a collapse toggle')
  assert.ok(toggles.every(toggle => toggle.props.onClick !== undefined), 'the toggle can be clicked')
  assert.ok(toggles.every(toggle => toggle.props['aria-expanded'] === 'true'), 'groups start expanded')

  // A model already in the *target* list is struck out and cannot be re-added.
  const inTarget = chips.filter(chip => String(chip.props.className).includes(' used'))
  assert.ok(inTarget.length > 0, 'the model already in the target list is marked used')
  assert.ok(inTarget.every(chip => chip.props.disabled === true), 'and cannot be clicked again')

  // A model already in a *different* list stays clickable — the same route in
  // two lists is a legitimate fallback — but it says so, so the picker is never
  // silent about what is already in use.
  const elsewhere = chips.filter(chip => String(chip.props.className).includes(' elsewhere'))
  assert.ok(elsewhere.length > 0, 'the model already in another list is marked')
  assert.ok(elsewhere.every(chip => chip.props.disabled !== true), 'but remains clickable')
  assert.ok(
    elsewhere.every(chip => String(chip.props.className).includes('mr_elsewhere') || JSON.stringify(chip).includes('mr_elsewhere')),
    'and carries the elsewhere marker',
  )

  // The ordered lists are the simple view's whole idea, so a rank per row and a
  // per-row control set have to be there.
  const items = []
  const walkItems = node => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walkItems); return }
    if (node.props?.className === 'mr_item') items.push(node)
    walkItems(node.props?.children)
  }
  walkItems(tree)
  assert.ok(items.length > 0, 'the ordered model lists rendered')
  assert.ok(JSON.stringify(items[0]).includes('mr_rank'), 'each row shows its position')

  // Diagnostics sit behind one disclosure, out of the way of the flow.
  const details = []
  const walkDetails = node => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walkDetails); return }
    if (node.type === 'details') details.push(node)
    walkDetails(node.props?.children)
  }
  walkDetails(tree)
  assert.equal(details.length, 1, 'diagnostics sit behind one disclosure')
  assert.ok(JSON.stringify(details[0]).includes('diag.title'), 'and the disclosure is labelled')
})

test('every token the page uses is one the host actually defines', () => {
  const used = new Set(source.match(/--dsw-[a-z0-9-]+/g) ?? [])
  assert.ok(used.size > 0, 'the page styles itself with theme tokens')

  const unknown = [...used].filter(token => !THEME_TOKENS.has(token))
  assert.deepEqual(unknown, [], `tokens with no definition in the host: ${unknown.join(', ')}`)

  // The two tokens the shipped plugins use that the host never defines must not
  // appear here at all: a `var()` to an undefined token is invalid at
  // computed-value time, so the declaration is dropped rather than rendered.
  const fake = [...used].filter(token => UNDEFINED_TOKENS.has(token))
  assert.deepEqual(fake, [], `these tokens do not exist in the host: ${fake.join(', ')}`)
})

test('a disabled primary button sets a readable text colour', () => {
  // `label-primary-foreground` is white, correct only on the dark primary fill.
  // The disabled state swaps in a *light* background (`button-primary-dimmed`),
  // so it must also swap the text colour — otherwise the button is white on
  // near-white and reads as blank. That is exactly what shipped once already.
  const rule = /\.mr_btn\.primary:disabled\{([^}]*)\}/.exec(source)
  assert.ok(rule !== undefined, 'the disabled primary rule exists')
  const body = rule[1]

  const colour = /(?:^|;)\s*color:\s*var\((--[a-z0-9-]+)/.exec(body)
  assert.ok(colour !== undefined, `the disabled rule sets its own colour, got: ${body}`)
  assert.notEqual(
    colour[1],
    '--dsw-alias-label-primary-foreground',
    'the disabled colour must not be the white-on-dark foreground',
  )
})

test('the enabled primary button keeps the foreground on its dark fill', () => {
  // The counterpart: when the button *is* filled, the white foreground is right.
  // This pins the pairing so a future edit cannot swap the two and leave both
  // states unreadable.
  const rule = /\.mr_btn\.primary\{([^}]*)\}/.exec(source)
  assert.ok(rule !== undefined, 'the primary rule exists')
  assert.ok(
    /color:\s*var\(--dsw-alias-label-primary-foreground/.test(rule[1]),
    'the filled primary uses the foreground colour',
  )
})

test('the two dictionaries cover exactly the same keys', () => {
  const { ctx } = mountPage()
  const { zh, en } = ctx.dictionaries[0].dicts

  const zhKeys = Object.keys(zh).sort()
  const enKeys = Object.keys(en).sort()
  assert.ok(zhKeys.length > 30, `expected a substantial dictionary, got ${zhKeys.length} keys`)

  assert.deepEqual(zhKeys.filter(key => !(key in en)), [], 'keys present in zh but not en')
  assert.deepEqual(enKeys.filter(key => !(key in zh)), [], 'keys present in en but not zh')
})

test('every selectable strategy has a label and a hint in both languages', () => {
  // A strategy the page can select but cannot describe would render an empty
  // row; one the host does not implement would be normalized away on load.
  const { ctx } = mountPage()
  const { zh, en } = ctx.dictionaries[0].dicts
  const strategies = ['primary-failover', 'round-robin', 'least-used', 'random', 'weighted-random']

  for (const strategy of strategies) {
    assert.ok(source.includes(`'${strategy}'`), `the page offers ${strategy}`)
    for (const dict of [zh, en]) {
      assert.ok(`strategy.${strategy}` in dict, `strategy.${strategy} has no label`)
      assert.ok(`strategy.${strategy}.hint` in dict, `strategy.${strategy} has no hint`)
    }
  }
})

test('the page talks to the routes the host actually mounts', () => {
  // A hard-coded prefix that drifted from API_PREFIX would 404 every call, and
  // the page would report a backend failure with nothing to point at.
  const apiModule = readFileSync(join(here, '..', 'src', 'api.js'), 'utf8')
  const hostPrefix = /export const API_PREFIX = '([^']+)'/.exec(apiModule)?.[1]
  assert.ok(hostPrefix !== undefined, 'the host declares its prefix')
  assert.ok(source.includes(`const API = '${hostPrefix}'`), `the page must fetch ${hostPrefix}`)
})

test('a new pool name never collides with an existing one', () => {
  const { exports } = bootBundle()
  assert.equal(exports.__test.freeName({}, 'new-pool'), 'new-pool')
  assert.equal(exports.__test.freeName({ 'new-pool': {} }, 'new-pool'), 'new-pool-2')
  assert.equal(exports.__test.freeName({ 'new-pool': {}, 'new-pool-2': {} }, 'new-pool'), 'new-pool-3')
})

// ── the simple view's translation layer ──────────────────────────────────────
// The page shows three ordered lists, but the file stores named pools with roles
// pointing at them. Everything that can go wrong between those two views is
// silent data loss, so the mapping is tested directly rather than through a
// renderer.

const blank = () => ({ enabled: true, health: {}, pools: {} })

test('every role the page can target is one the writers know about', () => {
  // This is the invariant that a `backup`/`fallback` mismatch silently breaks:
  // the picker's target selector and the list writers must agree on the role
  // keys, or a list is written against a pool name `rolePools` never returns and
  // the save silently does nothing. One list, two readers, tested together.
  const { exports } = bootBundle()
  const { ROLES } = exports.__test
  assert.deepEqual(ROLES, ['main', 'subagent', 'fallback'])
  assert.deepEqual(Object.keys(exports.__test.rolePools(blank())).sort(), [...ROLES].sort())
  // And each role actually round-trips through the writer.
  for (const role of ROLES) {
    const patch = exports.__test.writeRoleList(blank(), role, [{ provider: 'p', model: 'm' }])
    assert.equal(patch[`${role}Pool`], role, `${role} names a pool the writer created`)
  }
  // An empty subagent list writes no pool at all — that is what makes
  // "follow the main agent" the default rather than a preference to set.
  assert.deepEqual(exports.__test.writeRoleList(blank(), 'subagent', []), {})
})

test('a role with no pool reads as an empty list', () => {
  const { exports } = bootBundle()
  assert.deepEqual(exports.__test.roleList(blank(), 'main'), [])
  assert.deepEqual(exports.__test.roleList(blank(), 'subagent'), [])
})

test('a list reads its pool through the role pointer, resolving the pool provider', () => {
  const { exports } = bootBundle()
  const draft = {
    ...blank(),
    mainPool: 'work',
    pools: { work: { provider: 'our-free-model', candidates: [{ model: 'a' }, { provider: 'other', model: 'b' }] } },
  }
  assert.deepEqual(exports.__test.roleList(draft, 'main'), [
    { provider: 'our-free-model', model: 'a', weight: 1 },
    { provider: 'other', model: 'b', weight: 1 },
  ], 'a candidate with no provider inherits the pool\'s')
})

test('writing the first route creates the pool the role was missing', () => {
  const { exports } = bootBundle()
  const patch = exports.__test.writeRoleList(blank(), 'main', [{ provider: 'p', model: 'm' }])
  assert.equal(patch.mainPool, 'main', 'the role now points at a pool')
  assert.deepEqual(patch.pools.main.candidates, [{ provider: 'p', model: 'm' }])
})

test('writing into an existing pool keeps its name, strategy and other settings', () => {
  const { exports } = bootBundle()
  const draft = {
    ...blank(),
    mainPool: 'work',
    pools: { work: { provider: 'deepseek', strategy: 'least-used', candidates: [{ model: 'old' }] } },
  }
  const patch = exports.__test.writeRoleList(draft, 'main', [{ provider: 'deepseek', model: 'new' }])
  assert.equal(patch.mainPool, 'work', 'the pool was not renamed out from under the file')
  assert.equal(patch.pools.work.strategy, 'least-used', 'the strategy survived')
  assert.equal(patch.pools.work.provider, 'deepseek')
  assert.deepEqual(patch.pools.work.candidates, [{ model: 'new' }], 'a route matching the pool provider stays shorthand')
})

test('passing a strategy sets it, and an unknown one is ignored', () => {
  // The per-list strategy select writes through `writeRoleList`, so an omitted
  // strategy must not reset a hand-configured pool and an invalid one must not
  // reach the file.
  const { exports } = bootBundle()
  const draft = {
    ...blank(),
    mainPool: 'work',
    pools: { work: { provider: 'deepseek', strategy: 'least-used', candidates: [{ model: 'old' }] } },
  }

  const changed = exports.__test.writeRoleList(draft, 'main', [{ provider: 'deepseek', model: 'new' }], 'round-robin')
  assert.equal(changed.pools.work.strategy, 'round-robin', 'the requested strategy was applied')

  const rejected = exports.__test.writeRoleList(draft, 'main', [{ provider: 'deepseek', model: 'new' }], 'chaos')
  assert.equal(rejected.pools.work.strategy, 'least-used', 'an unknown strategy leaves the pool alone')
})

test('a route whose provider differs from the pool keeps its own provider', () => {
  const { exports } = bootBundle()
  const draft = { ...blank(), mainPool: 'work', pools: { work: { provider: 'a', candidates: [] } } }
  const patch = exports.__test.writeRoleList(draft, 'main', [{ provider: 'b', model: 'm' }])
  assert.deepEqual(patch.pools.work.candidates, [{ provider: 'b', model: 'm' }])
})

test('clearing a list does not delete the pool it lived in', () => {
  // The operator may still be pointing at that pool from the file, or about to
  // fill it again; removing the pool would be a much larger edit than emptying
  // a list.
  const { exports } = bootBundle()
  const draft = { ...blank(), mainPool: 'work', pools: { work: { provider: 'a', candidates: [{ model: 'm' }] } } }
  const patch = exports.__test.writeRoleList(draft, 'main', [])
  assert.deepEqual(patch.pools.work.candidates, [])
  assert.equal(patch.mainPool, 'work')
})

test('clearing a list that never had a pool writes nothing at all', () => {
  const { exports } = bootBundle()
  assert.deepEqual(exports.__test.writeRoleList(blank(), 'main', []), {}, 'no empty pool is invented')
})

test('subagents inherit the main pool until they are given their own', () => {
  const { exports } = bootBundle()
  const draft = { ...blank(), mainPool: 'work', pools: { work: { provider: 'a', candidates: [{ model: 'm' }] } } }
  assert.equal(exports.__test.subagentsInherit(draft), true)
  assert.deepEqual(exports.__test.roleList(draft, 'subagent'), exports.__test.roleList(draft, 'main'),
    'an inheriting subagent list reads the main one')

  const patch = exports.__test.writeRoleList(draft, 'subagent', [{ provider: 'a', model: 'cheap' }])
  assert.equal(patch.subagentPool, 'subagent')
  assert.equal(patch.inheritMain, false, 'writing its own list breaks the inheritance')
  const next = { ...draft, ...patch }
  assert.equal(exports.__test.subagentsInherit(next), false)
  assert.deepEqual(exports.__test.roleList(next, 'subagent'), [{ provider: 'a', model: 'cheap', weight: 1 }])
})

test('adding the same route twice is a no-op, not a duplicate', () => {
  const { exports } = bootBundle()
  const once = exports.__test.addRoute([], { provider: 'p', model: 'm' })
  const twice = exports.__test.addRoute(once, { provider: 'p', model: 'm' })
  assert.equal(twice.length, 1, 'a pool that names one route twice would just retry it twice')

  // The same model id on two different providers is two different routes.
  const both = exports.__test.addRoute(once, { provider: 'q', model: 'm' })
  assert.equal(both.length, 2)
})

test('an incomplete route is refused rather than half-added', () => {
  const { exports } = bootBundle()
  assert.deepEqual(exports.__test.addRoute([], { provider: '', model: 'm' }), [])
  assert.deepEqual(exports.__test.addRoute([], { provider: 'p', model: '  ' }), [])
})

test('reordering moves a route one place and stops at the ends', () => {
  const { exports } = bootBundle()
  const routes = [{ provider: 'p', model: 'a' }, { provider: 'p', model: 'b' }, { provider: 'p', model: 'c' }]
  assert.deepEqual(exports.__test.moveRoute(routes, 0, 1).map(r => r.model), ['b', 'a', 'c'])
  assert.deepEqual(exports.__test.moveRoute(routes, 2, -1).map(r => r.model), ['a', 'c', 'b'])
  // A move off either end is the same list back, so a held-down arrow cannot
  // reshuffle anything by accident.
  assert.deepEqual(exports.__test.moveRoute(routes, 0, -1).map(r => r.model), ['a', 'b', 'c'])
  assert.deepEqual(exports.__test.moveRoute(routes, 2, 1).map(r => r.model), ['a', 'b', 'c'])
})

test('removing takes out exactly one entry', () => {
  const { exports } = bootBundle()
  const routes = [{ provider: 'p', model: 'a' }, { provider: 'p', model: 'b' }]
  assert.deepEqual(exports.__test.removeRoute(routes, 0).map(r => r.model), ['b'])
})

test('the inventory can tell whether a route is already in the target list', () => {
  const { exports } = bootBundle()
  const routes = [{ provider: 'p', model: 'm' }]
  assert.equal(exports.__test.hasRoute(routes, 'p', 'm'), true)
  assert.equal(exports.__test.hasRoute(routes, 'p', 'other'), false, 'a different model on the same provider')
  assert.equal(exports.__test.hasRoute(routes, 'q', 'm'), false, 'the same model on a different provider')
})
