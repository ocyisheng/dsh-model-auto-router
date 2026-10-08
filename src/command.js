/**
 * `/model-auto-router` slash command.
 *
 * Gives the operator a live view of pool membership, which agent is pinned to
 * which route, and what is currently cooling down — the three things needed to
 * tell "the router switched me" apart from "the provider is down".
 *
 *   /model-auto-router status          full report
 *   /model-auto-router pools           just the configured pools
 *   /model-auto-router use <route>     pin this session to one route
 *   /model-auto-router auto            release the pin and resume pool selection
 */

import { splitRouteInput } from './route-input.js'

/**
 * @param {any} router the ModelAutoRouter instance
 * @param {any} commands the host command service
 */
export function registerModelAutoRouterCommand(router, commands) {
  return commands.register({
    name: 'model-auto-router',
    description: '查看或调整模型池路由与故障转移状态。',
    input: { hint: '[status | pools | use <provider/model> | auto]' },
    handler: async invocation => {
      const raw = (invocation.rawInput ?? '').trim()
      const [verb = 'status', ...rest] = raw.split(/\s+/).filter(Boolean)
      const argument = rest.join(' ')

      switch (verb.toLowerCase()) {
        case 'status':
          return { kind: 'success', text: router.report() }

        case 'pools':
          return { kind: 'success', text: router.reportPools() }

        case 'use': {
          const route = splitRouteInput(argument)
          if (!route) {
            return { kind: 'error', text: 'usage: /model-auto-router use <provider/model>' }
          }
          const resolved = router.pin(invocation.agent?.id, route)
          if (!resolved) {
            return { kind: 'error', text: `No configured route matches "${route}". Try /model-auto-router pools.` }
          }
          return {
            kind: 'success',
            text: `Pinned this session to ${resolved}. Pool selection resumes after /model-auto-router auto.`,
          }
        }

        case 'auto':
          router.pin(invocation.agent?.id, undefined)
          return { kind: 'success', text: 'Released the pin; the pool picks this session\'s route again.' }

        default:
          return {
            kind: 'error',
            text: `unknown subcommand "${verb}". Try: status, pools, use <provider/model>, auto`,
          }
      }
    },
  })
}
