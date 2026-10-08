# dsh-model-auto-router

> English | [中文](README.md)

Autonomous **model pool routing** and **automatic failover** for DeepSeek Harness.

- The **main agent** and every **subagent** draw their model from a pool you configure,
  instead of being pinned to one fixed model.
- When the current model **becomes unavailable** (rate limit, overload, timeout,
  5xx, DNS failure, model withdrawn), the plugin switches to a healthy fallback
  **on the very next attempt** — the turn keeps going, the user sees no error.
- A **settings page** (Settings → Model Router) edits the pools, the role
  assignment and the failover policy, and shows what the running router is
  actually doing. It writes the same config file a hand edit would.

---

## How it works

The plugin installs two of DSH's agent waterfalls. Both fire for the main agent and
for every subagent, because both run through the same agent loop:

| Waterfall | Job |
| --- | --- |
| `agent/request` | Replace the frozen `LlmCallConfig` for the coming step. This is where a pool picks a route. |
| `agent/request-error` | A request failed. Demote the route when the failure means "unavailable" and return `{ kind: 'retry' }`, which re-enters `agent/request` and lands on the next candidate. |

Because selection happens per request rather than per session, a failover takes
effect immediately — no restart, no new session.

### Failover, precisely

1. A request fails. The plugin classifies the failure.
2. **Unavailable** (429, 5xx, 502/503/504/529, `model_overloaded`, `ECONNREFUSED`,
   `ENOTFOUND`, a server-side code like `SERVER`, a status quoted in the message, a
   model the provider says it has retired, …) → the route's failure counter grows.
   Once it reaches `failureThreshold` the route is **demoted** for `cooldownMs`.
3. If a healthy alternative exists, the plugin returns `{ kind: 'retry' }`, which
   re-enters `agent/request`. Below the threshold the route is still healthy, so
   that retry lands back on it — one free retry, which is what the threshold is
   for. At the threshold the route is skipped and the retry moves on.
4. **Not unavailable** (400, 401/403, `context_length_exceeded`, …) → nothing
   changes. Switching models would only swap one wrong answer for another, so the
   built-in retry policy and the normal error path handle it.
5. If **every** route is demoted and no fallback exists, the plugin does not claim
   the retry — the real error is surfaced instead of being masked.

Three notes on that classification:

- **A failure can carry its meaning in the message.** `LlmFailure` has a required
  `code` but an optional `status`, and an in-stream error envelope is classified
  with no status to pass at all — so what arrives is
  `{ code: 'SERVER', message: 'Streaming response failed: [503] Upstream error from
  Nvidia: Service temporarily overloaded' }`. The 503 is nowhere but the text. A
  classifier reading `status` alone sees an unknown failure and leaves a plainly
  overloaded upstream in place, which is how a turn ends for no good reason. So the
  plugin reads a status quoted as `[503]`, `HTTP 503` or `status 503` from the
  message, and treats wording like *temporarily overloaded* / *service unavailable*
  / *try again later* as unavailable too.
- **A server-side code is unavailable.** `dsh-our-free-model` splits its vocabulary
  in two and says so in its own source — `CLIENT_ERROR` for a 4xx, and `SERVER` for
  the retryable bucket, explicitly not the fallback for a request fault. The rest
  of its `CODE` table (`TRANSPORT` for a failed fetch, `RATE_LIMIT`, `TIMEOUT`,
  `EMPTY_RESPONSE`) names the same side of the wire and is read the same way. A
  bare `SERVER` with no other detail is therefore an availability signal.
- **A retiring model is treated as unavailable, not as gone.** Providers phrase a
  retirement in prose rather than in a failure code — `dsh-our-free-model`
  surfaces `Model X has been deprecated. Use Y instead.` as a generic client
  error — so the message is the only signal, and this plugin reads it. But
  "deprecated" is the provider's word for its own catalogue, and the same route
  can be serving again later (a staged rollout, an overstated notice, an upstream
  rotation). So a retirement decides only *whether* a failover may happen, never
  how many failures it takes: `failureThreshold` stays the single lever, and
  `1` is how to make a retirement move on the first error.

A quoted **4xx** stays a request fault — `[400] bad request` does not trigger a
failover just because the adapter labelled the envelope `SERVER` — and a named
request fault (`invalid_request`) outranks a quoted 5xx. Only one of the two
directions is recoverable, so the asymmetry is deliberate.

Compaction and session-title calls are **never** rerouted. That is structural
rather than a filter: those calls stream straight through `ctx.llm` — the title
plugin's own envelope deliberately omits the agent loop's request identity — so
they never reach an `agent/request` listener at all.

### Route stability

An agent stays on its chosen route for its lifetime unless that route is demoted.
This is deliberate: provider prompt caches are keyed by model, so reshuffling on
every step would pay full input cost on every call. The `round-robin` and
`least-used` strategies therefore distribute **across agents**, not within one.

### Reasoning effort belongs to the model

A pool changes which model a request uses, and `reasoningEffort` is a property of
the model, not the request. DSH resolves the effort and **validates the pair
before dispatching**:

```
provider "our-free-model-vision" model "mimo-v2.5-free" does not support reasoning effort "high"
```

So carrying DSH's effort across a model change turns a recoverable failover into a
hard failure — a failover that dies on the way out. The plugin therefore
reconciles it: it reads the chosen model's own capabilities through
`llm.resolveModelInfo` (the same call DSH makes) and

- **keeps the effort** when that model accepts it, so an explicit setting is
  honoured; and
- **drops it** when it does not — or when the capability cannot be read at all —
  so DSH falls back to that model's own default. An absent effort is always
  valid, which makes dropping the safe direction.

Capabilities are cached per route for five minutes, since this runs in the
request path and a model's reasoning support does not change between two requests
a second apart. `llm.resolveModelInfo` is the public service method; if a
composition lacks it, the effort is dropped rather than guessed at.

---

## Install

The plugin registers itself through the profile bundle list:

```
dsh install git+https://github.com/ocyisheng/dsh-model-auto-router.git
```

To work on it locally instead, clone the repository and point `dsh install` at
the checkout — the profile records it as a `link:` dependency, so edits take
effect after a reload rather than a reinstall:

```
git clone https://github.com/ocyisheng/dsh-model-auto-router.git
dsh install .\dsh-model-auto-router
```

> Restart DSH after the first install. The host caches the plugin module in its
> ESM registry, so a later file edit needs a restart (or a plugin toggle) to take
> effect.

## Configure

There are two ways to edit the same file, and they are interchangeable:

- the **settings page** — Settings → **Model Router** in the Web GUI; or
- the **config file** itself, at `~/.dsh/model-auto-router.json`.

The file is polled and reloaded automatically, so a hand edit takes effect
without restarting. A save from the page applies immediately *and* writes the
file, so the two never drift apart.

### Settings page

One page, read top to bottom:

| Section | What it does |
| --- | --- |
| Models | Every provider and model route this host can dispatch, grouped by provider. One click adds it to the list chosen by the **Add to** buttons; a filter narrows it. The picker offers only what the system provides. |
| Main agent | The ordered list the main agent walks, top to bottom, on failure. Its strategy select decides how *new* agents are spread. |
| Subagents | The list subagents draw from. **Left empty, it is not a setting — subagents follow the main agent**, because that is what the router does when a subagent has no pool of its own. Fill it only when subagents should use different models. |
| Backup | Optional. Used only when every model above is unavailable. |
| Failover | How many consecutive failures demote a route, and how long it then cools down. |

There is deliberately no "follow the main agent" switch. An empty subagent list
already means exactly that: `writeRoleList` writes no `subagentPool` for an
empty list, and the router falls back to the main pool. The list exists for the
one case that is *not* the default — subagents on their own models — and its
absence is the default, not an unset preference.

**A pool is an ordered failover chain, so the page shows exactly that.** The
config's unit is a named pool that a role points at — right for the file, wrong
for a person, who is thinking "which models should the agent use, in what order".
So the three lists *are* the pools: each edits the pool its role already names,
and creates one only when a list is first filled in. Strategy stays one control
per list, because `round-robin` and friends distribute *across agents* in a way
an ordered list cannot show; everything else a pool can express lives in the file.

Clearing a list empties the pool but does not delete it, since you may still be
pointing at it from the file, or about to fill it again. The **Diagnostics**
disclosure at the bottom carries the config path and a status-report toggle —
the same routing status the settings page shows — without competing with the flow.

The inventory draws on three sources, in descending order of authority:

1. **Observed** — `provider/model` pairs this plugin watched the host actually
   dispatch, recorded by the routing lane itself. Real by construction: a request
   went out on that exact pair.
2. **The agent's default selection** — the route the host is configured to use,
   available before any request has been made.
3. **The `llm` catalog** — every registered provider and the models its adapter
   advertises. The broadest list, and the only one that can show a model this
   machine has not used yet.

That ordering is the point. An adapter's self-description is the *weakest*
evidence available — some keep their roster in their own store and advertise
nothing through `listModels` — so the page never depends on it alone. On a host
where every adapter declines to describe itself, the first two sources still fill
the page with routes that provably work.

Three things about the inventory are deliberate:

- **It shows what the system provides, and adds nothing of its own.** The
  picker offers only routes this host can actually dispatch — registered
  providers, routes it was observed dispatching, and the default selection.
  There is no free-text entry: a model the catalog does not list belongs in the
  config file, where the full `provider/model` pair can be written directly.
- **Dormant routes are offered and labelled.** A provider an adapter plugin owns
  but has not activated is listed as *not activated*, since naming it is how it
  becomes usable.
- **Unreadable inventory degrades honestly.** If the `llm` registry cannot be
  read, the page says so and lists only the observed routes, rather than implying
  the shorter list is the whole inventory.

Two more behaviours worth knowing:

- **A role is only defaulted to a pool that exists.** A file whose only pool is
  `main` loads with the fallback role unset rather than pointing at a `backup`
  pool that was never declared — otherwise the page would open onto a config it
  then refused to save.
- **`$comment` keys are preserved.** A save carries them over from the file,
  including nested ones such as `health.$comment_threshold`, so the sample's
  self-documentation survives being edited in the browser. Saving *does* replace
  the roster wholesale: a pool you delete in the page takes its comment with it.
- **Keys the page does not manage are dropped**, and the page lists the
  top-level ones it found before you save. Comment keys are the exception above;
  a non-comment key cannot be carried over, because a value you just deleted in
  the page would then reappear on the next save.

The page is available wherever a web server is mounted. Set `ui: false` in the
entry config to run routing with no page at all.

### The config file

Copy `model-auto-router.config.json` to `~/.dsh/model-auto-router.json`, or pass the config
inline through the profile entry.

```jsonc
{
  "mainPool": "main",
  "subagentPool": "subagent",
  "fallbackPool": "backup",
  "health": { "failureThreshold": 2, "cooldownMs": 60000 },
  "pools": {
    "main": {
      "provider": "deepseek",
      "strategy": "primary-failover",
      "candidates": ["deepseek-chat", "deepseek-reasoner"]
    },
    "subagent": {
      "provider": "deepseek",
      "strategy": "round-robin",
      "candidates": ["deepseek-chat", "deepseek-reasoner"]
    },
    "backup": {
      "candidates": [
        { "provider": "deepseek", "model": "deepseek-chat" },
        { "provider": "openai",    "model": "gpt-5" }
      ]
    }
  }
}
```

### Candidate forms

```jsonc
"candidates": [
  "deepseek-chat",                                  // uses the pool's provider
  { "model": "deepseek-reasoner" },                 // ditto
  { "provider": "openai", "model": "gpt-5" },       // explicit route
  { "provider": "openai", "model": "gpt-5", "weight": 3 }
]
```

### Strategies

| Strategy | Behaviour |
| --- | --- |
| `primary-failover` | Pool order is the priority; an agent gets a stable route. **Default.** |
| `round-robin` | New agents cycle through the pool in order. |
| `least-used` | New agents go to the least-used route. |
| `random` | Uniform random per new agent. |
| `weighted-random` | Random, biased by each candidate's `weight`. |

### Health settings

| Key | Default | Meaning |
| --- | --- | --- |
| `failureThreshold` | `2` | Consecutive unavailable failures before a route is demoted. Use `1` to switch on the first error. |
| `cooldownMs` | `60000` | How long a demoted route is skipped before it is retried. |

---

## Inspect and steer at runtime

Routing state is shown live on the **settings page** (above): pool membership,
per-agent assignments, cooling routes and recent switches are all there. Behind
it sits the HTTP surface mounted at `/api/model-auto-router` (see "Settings-page
HTTP API"); `GET /report` returns the same plain-text report the diagnostics
panel shows, ready to copy-paste or poll from an external script.

---

## Entry Config

| Field | Default | Meaning |
| --- | --- | --- |
| `configPath` | `~/.dsh/model-auto-router.json` | Path to the JSON config. |
| `watch` | `true` | Poll the config file and reload pools on change. |
| `router` | — | Inline config, merged **under** the file's contents. |
| `enabled` | `true` | `false` leaves DSH's own model selection completely untouched. |
| `ui` | `true` | Mount the settings page (where a web server is mounted). `false` runs headless. |
| `selfTest` | `false` | Run the behavioural suite in-process at boot. |
| `selfTestOut` | — | Write the self-test report (JSON) to this path. |

---

## The settings page's HTTP surface

The browser half is a thin renderer over three routes the Host half mounts at
`/api/model-auto-router`:

| Route | Job |
| --- | --- |
| `GET /state` | The config as an editable draft, plus the router's live state. |
| `GET /catalog` | The provider/model routes this host can dispatch, plus the routes it has been observed dispatching. |
| `PUT /config` | Validate a draft, write the file atomically, and reload the pools. |
| `GET /report` | Plain-text routing report (pools, assignments, cooling routes, recent switches), matching the diagnostics panel. |

`/catalog` is separate from `/state` on purpose: state is polled every few
seconds, while the inventory means asking every adapter — third-party I/O that
does not belong on a timer. The host caches it for a minute, bounds each
provider's discovery with a timeout, and treats a provider that fails or hangs as
a note on that provider rather than as an empty answer.

This prefix is longer than the kernel's own `/api`, and webServer dispatch is
longest-prefix-wins — so these routes run *before* the app's own admission check
and need their own fence. Every request is therefore admitted by the
composition's `connection` service when one is mounted, and otherwise by a
structural replica of that check: loopback host only, no cross-site fetches, and
an `Origin`/`Referer` that matches the `Host` authority. One of these routes
writes the config, so the fence is not decorative.

A draft is validated before it reaches the disk, and a save that the router's
own normalization still rejects disables routing rather than aborting the host —
the same degradation a malformed hand-edited file already gets.

---

## Tests

```bash
node --test                      # or: node --test test/
```

| File | Covers |
| --- | --- |
| `test/router.test.js` | The behavioural suite in `src/selftest.js` — selection, failover, health, pinning, the structured snapshot. |
| `test/host.test.js` | `index.js` against a stand-in host: the two waterfalls, the settings API mount, and the `ui: false` path. |
| `test/config-io.test.js` | The config layer: projection, validation, comment retention, round trips. |
| `test/catalog.test.js` | The provider/model inventory: caching, adapter coercion, a hanging provider, a failing one, the runtime route observer, and the source hierarchy. |
| `test/api.test.js` | The HTTP surface: state, catalog, save, refusal, and the trust fence. |
| `test/effort.test.js` | Reasoning-effort reconciliation: keep what the model accepts, drop what it does not, caching, timeouts, and the shapes that must never be mistaken for support. |
| `test/client.test.js` | The browser bundle: registration, dictionaries, a full render smoke test, and the theme-token invariant. |

`test/client.test.js` is worth calling out: it executes `client.js` against a
stub `window.__ModuleLoader__` and renders the page with a small hook shim, so a
broken bundle fails here rather than as a blank settings page in a browser.

The same behavioural suite runs inside the host without a test runner:

```bash
dsh install F:\AI\dsh-model-auto-router
# entry config: { selfTest: true, selfTestOut: './selftest-report.json' }
# or: DSH_MODEL_AUTO_ROUTER_SELFTEST=1
```

`test/browser-harness.html` runs the same assertions in a browser for environments
without Node.

---

## Design notes

- **No build step.** The plugin ships plain ESM JavaScript and a hand-written
  ModuleLoader bundle, so the exact files that run are the exact files under
  review.
- **One writer for the config.** The page edits the file through the plugin's own
  routes and the router reloads from that file — it never mutates router
  internals. The file and the live routing cannot silently diverge.
- **Pure core.** `src/pool.js`, `src/health.js`, `src/config-io.js` and
  `src/router.js` have no host imports, no clock and no I/O, which is what makes
  the behaviour deterministic and directly testable. `src/config-io.js` takes its
  file access as injected callbacks, so the whole config path is testable in
  memory.
- **Fails quiet.** A malformed config, an unknown pool name or a missing file is
  logged once and leaves DSH's own routing in place — it never aborts a boot.
- **Never claims a retry it cannot honour.** If there is nowhere healthy to go,
  the original error reaches the user.
- **Host styling vocabulary, not a look of its own.** Panels use the settings-card
  tokens, the one primary action uses the button-primary tokens, corners come
  from the radius scale, and every colour is a token the host actually defines —
  verified against the shipped CSS rather than against the Theme provider's
  `listTokens`, which advertises only a subset. The suite fails if a used token
  has no definition in the host, and it names the two tokens the shipped plugins
  reference that the host never defines (`label-on-accent`,
  `state-warning-primary`), which this page deliberately avoids.

## License

MIT
