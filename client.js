/**
 * dsh-model-auto-router — browser half: the settings page.
 *
 * One page, under Settings. The flow is deliberately linear, because that is
 * how the job actually reads:
 *
 *   1. pick models from what this host can dispatch;
 *   2. order them — that order *is* the failover chain;
 *   3. save.
 *
 * The config's unit is a named pool that a role points at. That is right for the
 * file and wrong for a person, who is asking "which models should the agent use,
 * in what order" — so a pool *is* an ordered candidate list under the default
 * strategy, and the page presents exactly that. The three lists below are the
 * pools; each edits the pool its role already names, and creates one only when a
 * list is first filled in. Strategy stays available as one control per list,
 * because `round-robin` and friends distribute across agents in a way an ordered
 * list cannot show.
 *
 * Styling follows the host's own settings vocabulary rather than a look of its
 * own: the settings-card tokens for panels, the button-primary tokens for the
 * one primary action, the radius scale for corners, and the DeepSeek accent for
 * the single place a colour should draw the eye. Nothing here invents a token,
 * and nothing depends on one the host does not define — the suite fails if a
 * used token is not among the verified set.
 *
 * Hand-written ModuleLoader bundle: no build step, and the only dependency is
 * the `react` the shell already provides.
 */
window.__ModuleLoader__.load({
  id: 'dsh-model-auto-router',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, Fragment, useState, useEffect, useCallback, useRef } = React

    const NS = 'settings.modelAutoRouter'
    const inject = ['slots', 'locale']
    const API = '/api/model-auto-router'

    /** The strategies a pool may use; the host validates against the same set. */
    const STRATEGIES = ['primary-failover', 'round-robin', 'least-used', 'random', 'weighted-random']

    /** Field bounds, mirroring `LIMITS` in src/config-io.js. */
    const LIMITS = {
      failureThreshold: { min: 1, max: 100 },
      cooldownMs: { min: 1000, max: 86_400_000 },
    }

    /**
     * The role keys this page edits, and the only ones `rolePools` names.
     *
     * One list, used by the target selector and by every list writer, so the two
     * can never drift: a role key the writers do not know about makes
     * `writeRoleList` look up a pool that is never named, and the list silently
     * fails to save.
     *
     * There is deliberately no "follow the main agent" switch: an empty subagent
     * list already means that, because `writeRoleList` writes no `subagentPool`
     * for an empty list and the router falls back to the main pool. The list is
     * here for the case that is *not* the default — subagents on their own
     * models — and its absence is the default, not an unset preference.
     */
    const ROLES = ['main', 'subagent', 'fallback']

    // ── copy ──────────────────────────────────────────────────────────────────
    const DICT = {
      zh: {
        nav: '模型自主路由',
        title: '模型自主路由',
        subtitle: '模型池路由 · 自动故障转移',
        loading: '正在读取配置…',
        loadFailed: '无法连接插件后端',
        retry: '重试',
        save: '保存',
        saving: '保存中…',
        revert: '还原',
        saved: '已保存',
        unsaved: '未保存',
        enabled: '启用路由',
        disabled: '路由已停用',

        'state.file': '配置文件',
        'state.fileMissing': '尚不存在，保存后创建',
        'state.unknownKeys': '文件里有本页不管理的字段，保存时会丢弃：',
        'state.invalidFile': '当前配置无法保存，请先修正：',

        'sec.models': '模型',
        'sec.modelsHint': '点击加入下面的列表',
        'sec.main': '主 Agent',
        'sec.mainHint': '从上到下依次尝试',
        'sec.subagent': '子 Agent',
        'sec.backup': '备用',
        'sec.backupHint': '可选；上面的全部不可用时才用',
        'sec.failover': '失败切换',
        'sec.failoverHint': '一般不用改',

        'target.label': '加入',
        'target.main': '主 Agent',
        'target.subagent': '子 Agent',
        'target.fallback': '备用',

        'picker.filter': '筛选模型…',
        'picker.add': '加入列表',
        'picker.added': '已在列表中',
        'picker.elsewhere': '已在其他列表中；仍可加入当前列表',
        'picker.addAll': '全部加入',
        'picker.noMatch': '没有匹配的模型',
        'picker.refreshCatalog': '刷新目录',
        'picker.refreshState': '刷新状态',
        'picker.toggleGroup': '展开或收起此 provider 的模型',

        'list.emptyMain': '还没有模型。',
        'list.emptySubagent': '留空即跟随主 Agent；只有需要子 Agent 用别的模型时才填。',
        'list.emptyBackup': '没有备用模型，可留空。',
        'list.up': '上移',
        'list.down': '下移',
        'list.remove': '移除',
        'list.strategy': '策略',


        'health.failureThreshold': '降级阈值',
        'health.cooldownMs': '冷却（毫秒）',
        'health.thresholdHint': '连续失败多少次后切换路由',
        'health.cooldownHint': '降级后多久重新参与选择',

        'strategy.primary-failover': '按顺序故障转移',
        'strategy.round-robin': '轮询',
        'strategy.least-used': '最少使用',
        'strategy.random': '随机',
        'strategy.weighted-random': '按权重随机',
        'strategy.primary-failover.hint': '池内顺序即优先级，会话固定在一个路由上，失败后下移。默认。',
        'strategy.round-robin.hint': '新会话按顺序轮流分配；单个会话仍保持稳定。',
        'strategy.least-used.hint': '新会话分给当前使用次数最少的路由。',
        'strategy.random.hint': '新会话等概率随机分配。',
        'strategy.weighted-random.hint': '新会话按各候选的权重随机分配。',

        'catalog.unavailable': '没能读到本机的 provider 目录，只列出实际用过的路由。',
        'catalog.empty': '这台机器还没有可列出的模型。',
        'catalog.dormant': '未启用',
        'catalog.unlisted': '未注册但在用',

        'live.current': '当前',
        'live.idle': '还没有会话被路由',
        'live.sessions': '个会话',
        'live.cooling': '冷却中',

        'diag.title': '诊断',
        'report': '状态报告',
        'reportHide': '收起报告',
      },
      en: {
        nav: 'Model Router',
        title: 'Model Router',
        subtitle: 'Model pool routing · automatic failover',
        loading: 'Reading configuration…',
        loadFailed: 'Cannot reach the plugin backend',
        retry: 'Retry',
        save: 'Save',
        saving: 'Saving…',
        revert: 'Revert',
        saved: 'Saved',
        unsaved: 'Unsaved',
        enabled: 'Routing enabled',
        disabled: 'Routing disabled',

        'state.file': 'Config file',
        'state.fileMissing': 'does not exist yet — saving creates it',
        'state.unknownKeys': 'The file holds fields this page does not manage; saving will drop them:',
        'state.invalidFile': 'The config on disk cannot be saved as it stands — fix these first:',

        'sec.models': 'Models',
        'sec.modelsHint': 'click one to add it to a list below',
        'sec.main': 'Main agent',
        'sec.mainHint': 'tried top to bottom',
        'sec.subagent': 'Subagents',
        'sec.backup': 'Backup',
        'sec.backupHint': 'optional; used only when every model above is unavailable',
        'sec.failover': 'Failover',
        'sec.failoverHint': 'sensible defaults — usually nothing to change',

        'target.label': 'Add to',
        'target.main': 'Main agent',
        'target.subagent': 'Subagents',
        'target.fallback': 'Backup',

        'picker.filter': 'Filter models…',
        'picker.add': 'Add to the list',
        'picker.added': 'Already in the list',
        'picker.elsewhere': 'Already in another list; you can still add it here',
        'picker.addAll': 'Add all',
        'picker.noMatch': 'No matching model',
        'picker.refreshCatalog': 'Refresh catalog',
        'picker.refreshState': 'Refresh state',
        'picker.toggleGroup': 'Expand or collapse this provider\'s models',

        'list.emptyMain': 'No models yet.',
        'list.emptySubagent': 'Leave this empty to follow the main agent; fill it only when subagents should use different models.',
        'list.emptyBackup': 'No backup models — leaving this empty is fine.',
        'list.up': 'Move up',
        'list.down': 'Move down',
        'list.remove': 'Remove',
        'list.strategy': 'Strategy',


        'health.failureThreshold': 'Demote after',
        'health.cooldownMs': 'Cooldown (ms)',
        'health.thresholdHint': 'consecutive failures before switching route',
        'health.cooldownHint': 'how long a demoted route waits before retrying',

        'strategy.primary-failover': 'Primary with failover',
        'strategy.round-robin': 'Round robin',
        'strategy.least-used': 'Least used',
        'strategy.random': 'Random',
        'strategy.weighted-random': 'Weighted random',
        'strategy.primary-failover.hint': 'Pool order is priority; a session stays on one route and moves down on failure. Default.',
        'strategy.round-robin.hint': 'New sessions cycle through the pool in order; each session stays stable.',
        'strategy.least-used.hint': 'New sessions go to the least-used route so far.',
        'strategy.random.hint': 'New sessions are assigned uniformly at random.',
        'strategy.weighted-random.hint': 'New sessions are drawn at random, biased by each candidate\'s weight.',

        'catalog.unavailable': 'Could not read the host\'s provider catalog, so only the routes actually used are listed.',
        'catalog.empty': 'No models to list on this machine yet.',
        'catalog.dormant': 'not activated',
        'catalog.unlisted': 'unregistered but in use',

        'live.current': 'Now',
        'live.idle': 'No session routed yet',
        'live.sessions': 'sessions',
        'live.cooling': 'cooling',

        'diag.title': 'Diagnostics',
        'report': 'Status report',
        'reportHide': 'Hide report',
      },
    }

    // ── styles ────────────────────────────────────────────────────────────────
    // Every colour is a host token; every corner comes from the radius scale. The
    // semantic settings-card tokens are used where they exist (panels) with the
    // layer/border they resolve to as a fallback, so a renamed token degrades
    // the look rather than the layout.
    const CSS = `
.mr_root{display:flex;flex-direction:column;gap:14px;max-width:1080px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary)}
.mr_root *{box-sizing:border-box}
.mr_card{display:flex;flex-direction:column;gap:12px;padding:14px 16px;border-radius:var(--dsw-radius-md);border:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l4));background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2))}
.mr_hero{display:flex;flex-direction:column;gap:8px;padding:16px 18px;border-radius:var(--dsw-radius-lg);border:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l4));background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2))}
.mr_herotop{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.mr_logotype{font-size:17px;font-weight:700;letter-spacing:-.2px}
.mr_tagline{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px}
.mr_live{display:flex;align-items:center;gap:7px;margin:0;font-size:12px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap}
.mr_spacer{margin-left:auto}
.mr_sechead{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.mr_sec_title{font-size:13.5px;font-weight:650}
.mr_sec_hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-left:auto}
.mr_sec_aside{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mr_body{display:flex;flex-direction:column;gap:10px}
.mr_row{display:flex;gap:9px;align-items:center;flex-wrap:wrap}
.mr_field{display:flex;flex-direction:column;gap:4px;min-width:110px}
.mr_field>span{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.mr_input,.mr_select{font:inherit;font-size:12px;padding:4px 8px;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);min-width:0;width:100%}
.mr_input:focus,.mr_select:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.mr_input.bad{border-color:var(--dsw-alias-state-error-primary)}
.mr_btn{font:inherit;font-size:12px;padding:5px 12px;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-button-elevated-fill,var(--dsw-alias-bg-layer-3));color:var(--dsw-alias-label-primary);cursor:pointer;font-weight:500}
.mr_btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}
.mr_btn:disabled{opacity:.5;cursor:default}
.mr_btn.primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}
.mr_btn.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.mr_btn.primary:disabled{background:var(--dsw-alias-button-primary-dimmed);color:var(--dsw-alias-label-tertiary)}
.mr_btn.ghost{background:transparent}
.mr_link{font:inherit;font-size:11.5px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;text-decoration:underline}
.mr_link:hover:not(:disabled){color:var(--dsw-alias-state-business-primary)}
.mr_link:disabled{opacity:.5;cursor:default}
.mr_switch{display:inline-flex;align-items:center;gap:8px;cursor:pointer;user-select:none;background:transparent;border:0;padding:0;color:inherit;font:inherit;font-size:12px}
.mr_switch i{width:32px;height:18px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);position:relative;transition:background .16s ease,border-color .16s ease;flex:none}
.mr_switch i::after{content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:var(--dsw-alias-switch-thumb,var(--dsw-alias-label-primary));transition:transform .16s ease,background .16s ease}
.mr_switch[aria-checked="true"] i{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}
.mr_switch[aria-checked="true"] i::after{transform:translateX(14px)}
.mr_seg{display:inline-flex;padding:2px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);gap:2px}
.mr_seg button{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;padding:3px 10px;border-radius:999px;cursor:pointer}
.mr_seg button:hover{color:var(--dsw-alias-label-primary)}
.mr_seg button[aria-pressed="true"]{background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground)}
.mr_chips{display:flex;gap:5px;flex-wrap:wrap}
.mr_routechip{display:inline-flex;align-items:center;gap:5px;font:inherit;font-size:11.5px;padding:3px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-button-elevated-fill,var(--dsw-alias-bg-layer-3));color:var(--dsw-alias-label-primary);cursor:pointer;max-width:100%}
.mr_routechip:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}
.mr_routechip:disabled{opacity:.6;cursor:default}
.mr_routechip.used{border-color:var(--dsw-alias-state-success-primary);background:transparent;color:var(--dsw-alias-label-tertiary)}
.mr_routechip.elsewhere{border-color:var(--dsw-alias-state-business-tertiary,var(--dsw-alias-border-l2));background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 7%,var(--dsw-alias-button-elevated-fill,var(--dsw-alias-bg-layer-3)))}
.mr_routechip .mr_mono{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mr_star{color:var(--dsw-alias-state-success-primary);font-weight:700;line-height:1}
.mr_elsewhere{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-business-primary);flex:none}
.mr_chipadd{color:var(--dsw-alias-label-tertiary)}
.mr_group{display:flex;flex-direction:column;gap:6px;padding:9px 10px;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.mr_grouphead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mr_groupname{font-size:12.5px;font-weight:600}
.mr_grouptoggle{display:inline-flex;align-items:center;gap:6px;border:0;background:transparent;padding:0;color:inherit;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer}
.mr_grouptoggle:hover{color:var(--dsw-alias-state-business-primary)}
.mr_chevron{display:inline-flex;align-items:center;justify-content:center;width:12px;flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary);transition:transform .15s ease}
.mr_chevron.open{transform:rotate(90deg)}
.mr_badge{font-size:10.5px;padding:1px 7px;border-radius:var(--dsw-radius-xs);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.mr_list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.mr_item{display:flex;align-items:center;gap:9px;padding:6px 8px;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.mr_item:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.mr_rank{flex:none;width:19px;height:19px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:10.5px;font-weight:600;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.mr_routecell{display:flex;align-items:baseline;gap:8px;min-width:0;flex:1;flex-wrap:wrap}
.mr_routecell .mr_mono{font-size:12px;overflow:hidden;text-overflow:ellipsis}
.mr_provider{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.mr_itemtools{display:flex;gap:3px;margin-left:auto;flex:none}
.mr_icon{font:inherit;font-size:12px;line-height:1;width:23px;height:23px;border-radius:var(--dsw-radius-xs);border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.mr_icon:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary)}
.mr_icon:disabled{opacity:.35;cursor:default}
.mr_icon.danger:hover:not(:disabled){border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.mr_mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.mr_note{font-size:11.5px;color:var(--dsw-alias-label-tertiary);line-height:1.5;margin:0}
.mr_callout{display:flex;flex-direction:column;gap:5px;padding:9px 11px;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.mr_callout.error{border-color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,var(--dsw-alias-bg-layer-1))}
.mr_callout ul{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:3px}
.mr_pre{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;padding:9px 11px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);overflow-x:auto;white-space:pre;color:var(--dsw-alias-label-secondary)}
.mr_path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;margin:0}
.mr_sticky{position:sticky;bottom:0;display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:10px 12px;border-radius:var(--dsw-radius-md);border:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l4));background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2))}
.mr_status{font-size:11.5px;color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;gap:6px;margin-left:auto}
.mr_dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}
.mr_dot.ok{background:var(--dsw-alias-state-success-primary)}
.mr_dot.warn{background:var(--dsw-alias-state-warn-primary)}
.mr_dot.err{background:var(--dsw-alias-state-error-primary)}
`

    // ── helpers ───────────────────────────────────────────────────────────────
    async function api(path, options) {
      const { timeout = 10_000, ...rest } = options ?? {}
      const control = new AbortController()
      const timer = setTimeout(() => control.abort(), timeout)
      try {
        const response = await fetch(`${API}${path}`, { ...rest, redirect: 'error', signal: control.signal })
        const text = await response.text()
        let payload
        try { payload = text === '' ? {} : JSON.parse(text) } catch { payload = { error: text.slice(0, 300) } }
        if (!response.ok) {
          const error = new Error(payload?.error ?? (payload?.errors ?? []).join('; ') ?? `HTTP ${response.status}`)
          // The route reports field-level problems as `errors`; carrying them on
          // the thrown value is what lets the page list every one at once
          // instead of one per save attempt.
          error.errors = Array.isArray(payload?.errors) ? payload.errors : undefined
          throw error
        }
        return payload
      } finally {
        clearTimeout(timer)
      }
    }

    const save = config => api('/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config),
    })


    /**
     * Index the catalog for lookups the render path makes constantly.
     *
     * Three sources merge into one list, in the order the page trusts them: the
     * routes this host was *observed* dispatching (real by construction), the
     * agent's default selection, then whatever each adapter advertises. The last
     * is the weakest evidence — some keep their roster in their own store — so it
     * supplements the first two rather than replacing them.
     */
    function indexCatalog(catalog) {
      const providers = Array.isArray(catalog?.providers) ? catalog.providers : []
      const declared = Array.isArray(catalog?.declared) ? catalog.declared : []
      const observed = Array.isArray(catalog?.observed) ? catalog.observed : []
      const defaults = catalog?.defaults

      const modelsByProvider = new Map()
      const providerNames = new Set()
      for (const provider of providers) {
        providerNames.add(provider.id)
        modelsByProvider.set(provider.id, Array.isArray(provider.models) ? provider.models.map(model => ({ ...model, advertised: true })) : [])
      }
      for (const route of observed) {
        const known = modelsByProvider.get(route.provider) ?? []
        modelsByProvider.set(route.provider, known.some(model => model.id === route.model)
          ? known.map(model => (model.id === route.model ? { ...model, observed: true } : model))
          : [...known, { id: route.model, name: route.model, observed: true }])
      }
      if (defaults !== undefined) {
        providerNames.add(defaults.provider)
        const known = modelsByProvider.get(defaults.provider) ?? []
        if (!known.some(model => model.id === defaults.model)) {
          modelsByProvider.set(defaults.provider, [...known, { id: defaults.model, name: defaults.model, observed: true }])
        }
      }

      const allProviders = []
      const added = new Set()
      for (const provider of providers) {
        added.add(provider.id)
        allProviders.push({ id: provider.id, name: provider.name, live: true })
      }
      for (const provider of declared) {
        if (added.has(provider.id)) continue
        added.add(provider.id)
        allProviders.push({ id: provider.id, name: provider.name, live: false })
      }
      for (const id of providerNames) {
        if (added.has(id)) continue
        added.add(id)
        allProviders.push({ id, name: id, live: true, unlisted: true })
      }

      return {
        providers,
        declared,
        observed,
        defaults,
        providerNames: added,
        modelsByProvider,
        allProviders,
        catalogUnavailable: catalog?.catalogUnavailable === true,
        known: added.size > 0,
      }
    }

    /** Deep structural equality, good enough for a JSON draft. */
    function same(left, right) {
      return JSON.stringify(left) === JSON.stringify(right)
    }

    function clone(value) {
      return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
    }

    /** A name no pool is using yet, so a pool created here never collides. */
    function freeName(pools, base) {
      const taken = new Set(Object.keys(pools ?? {}))
      if (!taken.has(base)) return base
      for (let i = 2; i < 1000; i++) {
        const candidate = `${base}-${i}`
        if (!taken.has(candidate)) return candidate
      }
      return `${base}-${Date.now()}`
    }

    // ── the simple view's model: ordered lists onto named pools ──────────────
    // The page shows three ordered lists; the file stores named pools that roles
    // point at. Everything that can go wrong between those two views is silent
    // data loss, so the mapping is pure, exported, and tested directly.

    /** The pool name each role currently points at. */
    function rolePools(draft = {}) {
      return {
        main: typeof draft.mainPool === 'string' ? draft.mainPool : '',
        subagent: typeof draft.subagentPool === 'string' ? draft.subagentPool : '',
        fallback: typeof draft.fallbackPool === 'string' ? draft.fallbackPool : '',
      }
    }

    /** True when subagents follow the main pool rather than their own. */
    function subagentsInherit(draft = {}) {
      return rolePools(draft).subagent === '' && draft.inheritMain !== false
    }

    /** The pool a role draws from, or undefined when it has none of its own. */
    function poolOf(draft, role) {
      const names = rolePools(draft)
      // An inheriting subagent draws from the main pool, so that is what it must
      // read — returning nothing here would make the subagent list appear empty
      // even though it is showing the main pool's routes.
      if (role === 'subagent' && subagentsInherit(draft)) return draft.pools?.[names.main]
      return names[role] === '' ? undefined : draft.pools?.[names[role]]
    }

    /** The pool's selection strategy, defaulting to the primary one. */
    function poolStrategy(draft, role) {
      const strategy = poolOf(draft, role)?.strategy
      return STRATEGIES.includes(strategy) ? strategy : 'primary-failover'
    }

    /**
     * The ordered candidate routes of a role's list.
     *
     * A candidate with no provider of its own inherits the pool's, which is what
     * makes a pool-level provider useful shorthand.
     */
    function roleList(draft, role) {
      const pool = poolOf(draft, role)
      const poolProvider = typeof pool?.provider === 'string' ? pool.provider.trim() : ''
      return (Array.isArray(pool?.candidates) ? pool.candidates : [])
        .map(candidate => ({
          provider: (typeof candidate?.provider === 'string' ? candidate.provider.trim() : '') || poolProvider,
          model: typeof candidate?.model === 'string' ? candidate.model.trim() : '',
          weight: Number.isFinite(Number(candidate?.weight)) && Number(candidate?.weight) > 0 ? Number(candidate.weight) : 1,
        }))
        .filter(candidate => candidate.model !== '')
    }

    /**
     * Write a role's ordered list back, creating the pool when needed.
     *
     * Returns a *patch* rather than a whole draft, so the caller composes it with
     * whatever else it is changing and `update` stays a single shallow merge.
     * An omitted strategy keeps the pool's, so editing the list cannot silently
     * reset a pool the operator configured by hand.
     */
    function writeRoleList(draft, role, routes, strategy) {
      const pools = { ...(draft.pools ?? {}) }
      const current = rolePools(draft)[role]
      // A list being filled in for the first time needs a pool to live in; an
      // empty one keeps whatever pool it had, so clearing a list does not delete
      // a pool the operator may still be using from the file.
      const name = current !== '' ? current : (routes.length > 0 ? freeName(pools, role) : '')
      if (name === '') return {}

      const existing = pools[name] ?? { provider: '', strategy: 'primary-failover', candidates: [] }
      const provider = typeof existing.provider === 'string' ? existing.provider.trim() : ''

      const written = routes.map(route => {
        const entry = { model: route.model }
        // Only write a provider that differs from the pool's, matching the
        // shorthand the config file already uses.
        if (route.provider !== '' && route.provider !== provider) entry.provider = route.provider
        const weight = Number(route.weight)
        if (Number.isFinite(weight) && weight > 0 && weight !== 1) entry.weight = weight
        return entry
      })

      const next = { ...existing, candidates: written }
      if (typeof strategy === 'string' && STRATEGIES.includes(strategy)) next.strategy = strategy
      pools[name] = next

      const patch = { pools, [`${role}Pool`]: name }
      if (role === 'subagent') patch.inheritMain = false
      return patch
    }

    /** Append a route, refusing an incomplete one and ignoring a duplicate. */
    function addRoute(routes, route) {
      const provider = typeof route?.provider === 'string' ? route.provider.trim() : ''
      const model = typeof route?.model === 'string' ? route.model.trim() : ''
      if (provider === '' || model === '') return routes
      if (routes.some(existing => existing.provider === provider && existing.model === model)) return routes
      return [...routes, { provider, model, weight: 1 }]
    }

    function removeRoute(routes, index) {
      return routes.filter((_, i) => i !== index)
    }

    function moveRoute(routes, index, delta) {
      const target = index + delta
      if (target < 0 || target >= routes.length) return routes
      const next = routes.slice()
      const [row] = next.splice(index, 1)
      next.splice(target, 0, row)
      return next
    }

    /** Is this exact route already in the list? Used to mark inventory chips. */
    function hasRoute(routes, provider, model) {
      return routes.some(route => route.provider === provider && route.model === model)
    }

    // ── primitives ────────────────────────────────────────────────────────────
    const Switch = props => h('button', {
      type: 'button',
      className: 'mr_switch',
      role: 'switch',
      'aria-checked': props.checked ? 'true' : 'false',
      disabled: props.disabled,
      onClick: () => props.onChange(!props.checked),
    }, h('i'), props.label === undefined ? null : h('span', null, props.label))

    const Button = props => h('button', {
      type: 'button',
      className: 'mr_btn' + (props.kind === undefined ? '' : ' ' + props.kind),
      disabled: props.disabled,
      title: props.title,
      onClick: props.onClick,
    }, props.children)

    /**
     * One settings card: a title, an optional right-hand control, a body.
     *
     * The right-hand slot carries the controls the host's own settings pages put
     * in a section head — a small select, a switch — which keeps each section
     * self-contained instead of moving its controls somewhere else on the page.
     */
    function Section(props) {
      return h('section', { className: 'mr_card' },
        h('div', { className: 'mr_sechead' },
          h('span', { className: 'mr_sec_title' }, props.title),
          props.hint === undefined ? null : h('span', { className: 'mr_sec_hint' }, props.hint),
          props.aside === undefined ? null : h('div', { className: 'mr_sec_aside' }, props.aside)),
        props.children)
    }

    /** A compact strategy select, for a pool's right-hand control. */
    function StrategySelect(props) {
      const { value, onChange, t, title } = props
      return h('select', {
        className: 'mr_select',
        style: { width: 'auto', minWidth: '130px' },
        value,
        title: title ?? t(`strategy.${value}.hint`),
        'aria-label': t('list.strategy'),
        onChange: event => onChange(event.target.value),
      }, STRATEGIES.map(id => h('option', { key: id, value: id }, t(`strategy.${id}`))))
    }

    // ── the model picker ──────────────────────────────────────────────────────
    /**
     * The inventory: what this machine can dispatch, one click from being in use.
     *
     * Providers render as collapsible rows — a header that folds its models
     * away, and the chips only when it is open — because the operator's
     * question is first "which providers do I have" and only then "which of
     * this one's models". A live filter opens every matching group, so
     * searching never makes the user click twice.
     */
    function InventoryPicker(props) {
      const { catalog, t, isUsed, isUsedElsewhere, onAdd, onAddAll } = props
      const [filter, setFilter] = useState('')
      const [collapsed, setCollapsed] = useState(() => new Set())

      if (catalog === undefined) return h('p', { className: 'mr_note' }, t('loading'))

      const needle = filter.trim().toLowerCase()
      const matches = (provider, model) => needle === ''
        || provider.toLowerCase().includes(needle)
        || model.toLowerCase().includes(needle)

      const groups = []
      for (const provider of catalog.allProviders) {
        const models = (catalog.modelsByProvider.get(provider.id) ?? [])
          .filter(model => matches(provider.id, model.id))
        if (models.length === 0) continue
        groups.push({ provider, models })
      }
      const total = groups.reduce((sum, group) => sum + group.models.length, 0)

      // With a filter live, every group that survives is a match worth showing,
      // so the collapse state is suspended rather than honoured. The empty
      // state below still tells the truth when nothing matched.
      const isOpen = providerId => needle === '' ? !collapsed.has(providerId) : true

      const toggle = providerId => setCollapsed(current => {
        const next = new Set(current)
        if (next.has(providerId)) next.delete(providerId)
        else next.add(providerId)
        return next
      })

      return h('div', { className: 'mr_body' },
        groups.length > 0
          ? h('input', {
            className: 'mr_input',
            value: filter,
            placeholder: t('picker.filter'),
            'aria-label': t('picker.filter'),
            onChange: event => setFilter(event.target.value),
          })
          : null,

        total === 0
          ? h('p', { className: 'mr_note' }, needle === ''
            ? (catalog.catalogUnavailable ? t('catalog.unavailable') : t('catalog.empty'))
            : t('picker.noMatch'))
          : null,

        groups.map(group => h('div', { key: group.provider.id, className: 'mr_group' },
          h('div', { className: 'mr_grouphead' },
            h('button', {
              type: 'button',
              className: 'mr_groupname mr_grouptoggle',
              'aria-expanded': isOpen(group.provider.id) ? 'true' : 'false',
              title: t('picker.toggleGroup'),
              onClick: () => toggle(group.provider.id),
            },
            h('span', { className: `mr_chevron ${isOpen(group.provider.id) ? 'open' : ''}` }, '▸'),
            group.provider.name,
            h('span', { className: 'mr_badge' }, String(group.models.length))),
            group.provider.live === false ? h('span', { className: 'mr_badge' }, t('catalog.dormant')) : null,
            group.provider.unlisted === true ? h('span', { className: 'mr_badge' }, t('catalog.unlisted')) : null,
            h('span', { className: 'mr_spacer' }),
            h('button', {
              type: 'button',
              className: 'mr_link',
              onClick: () => onAddAll(group.provider.id, group.models.map(model => model.id)),
            }, t('picker.addAll'))),
          isOpen(group.provider.id)
            ? h('div', { className: 'mr_chips' }, group.models.map(model => {
              const used = isUsed(group.provider.id, model.id)
              // A model already in *another* list is still worth adding here — the
              // same route in two lists is a legitimate fallback — but it should
              // say so, or the picker looks like it has no idea what is already in
              // use.
              const elsewhere = !used && isUsedElsewhere?.(group.provider.id, model.id) === true
              return h('button', {
                key: model.id,
                type: 'button',
                className: 'mr_routechip' + (used ? ' used' : elsewhere ? ' elsewhere' : ''),
                disabled: used,
                title: used ? t('picker.added') : elsewhere ? t('picker.elsewhere') : t('picker.add'),
                onClick: () => onAdd(group.provider.id, model.id),
              },
              used ? h('span', { className: 'mr_star' }, '✓') : elsewhere ? h('span', { className: 'mr_elsewhere' }) : null,
              h('span', { className: 'mr_mono' }, model.id),
              used ? null : h('span', { className: 'mr_chipadd' }, '＋'))
            }))
            : null)))
    }

    // ── the ordered list ──────────────────────────────────────────────────────
    /**
     * One ordered model list — the whole idea of the simple view.
     *
     * A pool *is* an ordered failover chain under the default strategy, so the
     * page presents exactly that: top to bottom, tried in that order. Position
     * is carried by a rank badge rather than by the row's text, so the model id
     * stays copyable and the order is still legible at a glance.
     */
    function RouteList(props) {
      const { routes, t, onChange, empty } = props

      if (routes.length === 0) return h('p', { className: 'mr_note' }, empty)

      return h('ol', { className: 'mr_list' }, routes.map((route, index) => h('li', {
        key: `${route.provider}\u0000${route.model}\u0000${index}`,
        className: 'mr_item',
      },
      h('span', { className: 'mr_rank' }, String(index + 1)),
      h('span', { className: 'mr_routecell' },
        h('span', { className: 'mr_mono' }, route.model),
        route.provider === '' ? null : h('span', { className: 'mr_provider' }, route.provider)),
      h('span', { className: 'mr_itemtools' },
        h('button', {
          type: 'button',
          className: 'mr_icon',
          disabled: index === 0,
          title: t('list.up'),
          onClick: () => onChange(moveRoute(routes, index, -1)),
        }, '↑'),
        h('button', {
          type: 'button',
          className: 'mr_icon',
          disabled: index === routes.length - 1,
          title: t('list.down'),
          onClick: () => onChange(moveRoute(routes, index, 1)),
        }, '↓'),
        h('button', {
          type: 'button',
          className: 'mr_icon danger',
          title: t('list.remove'),
          onClick: () => onChange(removeRoute(routes, index)),
        }, '✕')))))
    }

    // ── the failover policy ───────────────────────────────────────────────────
    /** The two numbers that decide when a route is demoted and for how long. */
    function HealthEditor(props) {
      const { draft, t, update } = props
      const health = draft.health ?? {}
      const set = patch => update({ health: { ...health, ...patch } })
      return h('div', { className: 'mr_row' },
        h('div', { className: 'mr_field' },
          h('span', null, t('health.failureThreshold')),
          h('input', {
            className: 'mr_input',
            type: 'number',
            min: String(LIMITS.failureThreshold.min),
            max: String(LIMITS.failureThreshold.max),
            value: health.failureThreshold ?? 2,
            title: t('health.thresholdHint'),
            onChange: event => set({ failureThreshold: event.target.value }),
          })),
        h('div', { className: 'mr_field' },
          h('span', null, t('health.cooldownMs')),
          h('input', {
            className: 'mr_input',
            type: 'number',
            min: String(LIMITS.cooldownMs.min),
            max: String(LIMITS.cooldownMs.max),
            step: '1000',
            value: health.cooldownMs ?? 60_000,
            title: t('health.cooldownHint'),
            onChange: event => set({ cooldownMs: event.target.value }),
          })))
    }

    // ── page ──────────────────────────────────────────────────────────────────
    function SettingsPage(props) {
      const t = props.t

      const [state, setState] = useState(undefined)
      const [draft, setDraft] = useState(undefined)
      const [baseline, setBaseline] = useState(undefined)
      const [error, setError] = useState('')
      const [fieldErrors, setFieldErrors] = useState([])
      const [busy, setBusy] = useState(false)
      const [report, setReport] = useState(undefined)
      const [catalog, setCatalog] = useState(undefined)
      // Which list the inventory chips feed. One shared target rather than a
      // picker beside each list: three lists with three pickers is three times
      // the page, and the main list is the common case anyway.
      const [target, setTarget] = useState('main')
      // A live refresh must never clobber what the user is typing: the draft is
      // only re-seeded from the server while it is untouched.
      const dirtyRef = useRef(false)

      const dirty = draft !== undefined && baseline !== undefined && !same(draft, baseline)

      const adopt = useCallback(payload => {
        setState(payload)
        const next = clone(payload.config)
        setBaseline(clone(next))
        dirtyRef.current = false
        setDraft(next)
      }, [])

      const load = useCallback(async () => {
        setError('')
        try {
          adopt(await api('/state'))
        } catch (problem) {
          setError(String(problem?.message ?? problem))
        }
      }, [adopt])

      /**
       * Load the provider/model inventory.
       *
       * Kept out of the state poll: the host caches it, but asking on a timer
       * would still be a periodic round trip for data that only changes when a
       * plugin is enabled or disabled. A failure here degrades the page to plain
       * fields, which stay perfectly valid.
       */
      const loadCatalog = useCallback(async () => {
        try {
          setCatalog(indexCatalog(await api('/catalog', { timeout: 20_000 })))
        } catch {
          setCatalog(indexCatalog(undefined))
        }
      }, [])

      /** Refresh only the live half, leaving an edited draft alone. */
      const refreshRuntime = useCallback(async () => {
        try {
          const payload = await api('/state')
          if (dirtyRef.current) setState(current => ({ ...payload, config: current?.config ?? payload.config }))
          else adopt(payload)
        } catch (problem) {
          setError(String(problem?.message ?? problem))
        }
      }, [adopt])

      useEffect(() => { void load() }, [load])
      useEffect(() => { void loadCatalog() }, [loadCatalog])

      // The routing state moves on its own — a failover happens in another
      // fiber — so the page polls while it is open. It is a small JSON read,
      // and a status line that is only right on mount is worse than none.
      useEffect(() => {
        const timer = setInterval(() => { void refreshRuntime() }, 5000)
        return () => clearInterval(timer)
      }, [refreshRuntime])

      const update = useCallback(patch => {
        dirtyRef.current = true
        setDraft(current => ({ ...current, ...patch }))
      }, [])

      /**
       * Replace one role's ordered list, and optionally its pool's strategy.
       *
       * Derived from the live draft rather than from the render's copy, so two
       * quick clicks compose instead of the second one overwriting the first
       * with a list it computed before the first landed.
       */
      const setRole = useCallback((role, routes, strategy) => {
        dirtyRef.current = true
        setDraft(current => (current === undefined
          ? current
          : { ...current, ...writeRoleList(current, role, routes, strategy) }))
      }, [])

      const onSave = useCallback(async () => {
        setBusy(true)
        setError('')
        setFieldErrors([])
        try {
          const payload = await save(draft)
          adopt(payload.state)
        } catch (problem) {
          setFieldErrors(Array.isArray(problem?.errors) ? problem.errors : [])
          setError(String(problem?.message ?? problem))
        } finally {
          setBusy(false)
        }
      }, [adopt, draft])

      const onRevert = useCallback(() => {
        if (baseline === undefined) return
        dirtyRef.current = false
        setDraft(clone(baseline))
        setError('')
        setFieldErrors([])
      }, [baseline])

      const toggleReport = useCallback(async () => {
        if (report !== undefined) { setReport(undefined); return }
        try {
          const payload = await api('/report')
          setReport(payload.text ?? '')
        } catch (problem) {
          setError(String(problem?.message ?? problem))
        }
      }, [report])

      if (state === undefined) {
        return h('div', { className: 'mr_root' },
          error === ''
            ? h('p', { className: 'mr_note' }, t('loading'))
            : h(Fragment, null,
              h('div', { className: 'mr_callout error' }, h('b', null, t('loadFailed')), h('div', null, error)),
              h(Button, { onClick: () => void load() }, t('retry'))))
      }

      const runtime = state.runtime ?? {}
      const current = (runtime.assignments ?? [])[0]
      const cooling = (runtime.health ?? []).filter(row => row.coolingDown).length
      // Built from ROLES, so the picker's target and the lists it writes to are
      // guaranteed to name the same keys the config does.
      const lists = Object.fromEntries(ROLES.map(role => [role, roleList(draft, role)]))

      // One section helper per list, so the page reads as the flow it is rather
      // than as a form that happens to contain the same three widgets.
      // The strategy select only means something once a pool exists, so it
      // appears with the list rather than before it: an empty list has no pool
      // to carry a strategy, and a select that changes nothing is worse than
      // no select.
      const listSection = (role, title, hint, empty) => h(Section, {
        title,
        aside: lists[role].length > 0
          ? h(StrategySelect, {
            value: poolStrategy(draft, role),
            t,
            onChange: strategy => setRole(role, lists[role], strategy),
          })
          : undefined,
        children: h(RouteList, {
          routes: lists[role],
          t,
          empty,
          onChange: routes => setRole(role, routes),
        }),
      })

      return h('div', { className: 'mr_root' },
        h('header', { className: 'mr_hero' },
          h('div', { className: 'mr_herotop' },
            h('span', { className: 'mr_logotype' }, t('title')),
            h('span', { className: 'mr_spacer' }),
            h(Switch, {
              checked: draft.enabled !== false,
              label: draft.enabled === false ? t('disabled') : t('enabled'),
              onChange: checked => update({ enabled: checked }),
            })),
          h('p', { className: 'mr_tagline' }, t('subtitle')),
          h('p', { className: 'mr_live' },
            h('span', { className: `mr_dot ${current === undefined ? '' : 'ok'}` }),
            current === undefined
              ? t('live.idle')
              : h(Fragment, null, `${t('live.current')} `, h('span', { className: 'mr_mono' }, current.route)),
            ` · ${(runtime.assignments ?? []).length} ${t('live.sessions')}`,
            cooling > 0 ? ` · ${cooling} ${t('live.cooling')}` : null)),

        state.fileError !== undefined && state.fileError !== ''
          ? h('div', { className: 'mr_callout error' }, h('b', null, t('loadFailed')), h('div', null, state.fileError))
          : null,
        state.validation !== undefined && state.validation.ok === false
          ? h('div', { className: 'mr_callout error' },
            h('b', null, t('state.invalidFile')),
            h('ul', null, state.validation.errors.map((line, index) => h('li', { key: index }, line))))
          : null,
        fieldErrors.length > 0
          ? h('div', { className: 'mr_callout error' },
            h('b', null, t('save')),
            h('ul', null, fieldErrors.map((line, index) => h('li', { key: index }, line))))
          : null,
        error !== '' && fieldErrors.length === 0
          ? h('div', { className: 'mr_callout error' }, h('div', null, error))
          : null,
        (state.unknownKeys ?? []).length > 0
          ? h('div', { className: 'mr_callout' },
            h('b', null, t('state.unknownKeys')),
            h('div', { className: 'mr_mono' }, state.unknownKeys.join(', ')))
          : null,

        h(Section, {
          title: t('sec.models'),
          hint: t('sec.modelsHint'),
          aside: h(Fragment, null,
            h('span', { className: 'mr_note' }, t('target.label')),
            h('div', { className: 'mr_seg' }, ROLES.map(role => h('button', {
              key: role,
              type: 'button',
              'aria-pressed': target === role ? 'true' : 'false',
              onClick: () => setTarget(role),
            }, t(`target.${role}`))))),
        },
        h(InventoryPicker, {
          catalog,
          t,
          isUsed: (provider, model) => hasRoute(lists[target] ?? [], provider, model),
          // Already in a *different* list: still addable, but worth saying so.
          isUsedElsewhere: (provider, model) => ROLES.some(
            role => role !== target && hasRoute(lists[role] ?? [], provider, model),
          ),
          // Adding a route is the whole interaction, so it writes straight
          // through: no staging step between seeing a model and using it.
          onAdd: (provider, model) => setRole(target, addRoute(lists[target] ?? [], { provider, model })),
          onAddAll: (provider, models) => setRole(target, models.reduce(
            (routes, model) => addRoute(routes, { provider, model }),
            lists[target] ?? [],
          )),
        })),

        listSection('main', t('sec.main'), t('sec.mainHint'), t('list.emptyMain')),

        // No "follow main" switch here: an empty list already means that, since
        // an empty subagent list writes no `subagentPool` and the router falls
        // back to the main pool. The list exists for the non-default case.
        listSection('subagent', t('sec.subagent'), undefined, t('list.emptySubagent')),

        listSection('fallback', t('sec.backup'), t('sec.backupHint'), t('list.emptyBackup')),

        h(Section, { title: t('sec.failover'), hint: t('sec.failoverHint') },
          h(HealthEditor, { draft, t, update })),

        h('details', { className: 'mr_card', style: { padding: '10px 14px' } },
          h('summary', { style: { cursor: 'pointer', fontSize: '12.5px', fontWeight: 600 } }, t('diag.title')),
          h('div', { className: 'mr_body', style: { marginTop: '10px' } },
            h('p', { className: 'mr_path' },
              `${t('state.file')}: ${state.configPath}${state.fileExists ? '' : ` — ${t('state.fileMissing')}`}`),
            h('div', { className: 'mr_row' },
              h(Button, { kind: 'ghost', disabled: busy, onClick: () => void toggleReport() },
                report === undefined ? t('report') : t('reportHide')),
              h(Button, { kind: 'ghost', disabled: busy, onClick: () => void loadCatalog() }, t('picker.refreshCatalog')),
              h(Button, { kind: 'ghost', disabled: busy, onClick: () => void refreshRuntime() }, t('picker.refreshState'))),
            report === undefined || report === ''
              ? null
              : h('pre', { className: 'mr_pre' }, report))),

        h('div', { className: 'mr_sticky' },
          h(Button, { kind: 'primary', disabled: busy || !dirty, onClick: () => void onSave() },
            busy ? t('saving') : t('save')),
          h(Button, { kind: 'ghost', disabled: busy || !dirty, onClick: onRevert }, t('revert')),
          h('span', { className: 'mr_status' },
            h('span', { className: `mr_dot ${dirty ? 'warn' : 'ok'}` }),
            dirty ? t('unsaved') : t('saved'))))
    }

    // ── registration ──────────────────────────────────────────────────────────
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'model-auto-router: dictionaries')
      const t = ctx.locale.bind(NS)

      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-model-auto-router')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'model-auto-router: styles')

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'model-auto-router',
        // Between the agent presets and the free-model lane: it is a routing
        // concern, so it belongs beside the model configuration rather than at
        // the end of the list.
        order: 30,
        label: () => t('nav'),
        locale: NS,
        inject: () => ({ t }),
      }, SettingsPage))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-model-auto-router'
    // Seams for the headless suite, which exercises the pure mapping layer
    // directly rather than through a renderer it would have to bring its own
    // React for.
    exports.__test = {
      ROLES,
      indexCatalog,
      rolePools,
      subagentsInherit,
      poolOf,
      poolStrategy,
      roleList,
      writeRoleList,
      addRoute,
      removeRoute,
      moveRoute,
      hasRoute,
      freeName,
    }
    return module.exports
  },
})
