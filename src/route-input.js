/**
 * Normalize a user-typed route from `/model-auto-router use ...`.
 *
 * Accepts `provider/model`, and tolerates stray quoting or a trailing comma so
 * a pasted value does not silently become a bogus route label. A bare `model`
 * is returned as-is; the router resolves it against the pool, so the user does
 * not have to know the provider name.
 *
 * @param {string} input
 * @returns {string | undefined}
 */
export function splitRouteInput(input) {
  const trimmed = (input ?? '').trim().replace(/^["']|["']$/g, '').replace(/,+$/, '').trim()
  if (!trimmed) return undefined
  return trimmed
}
