/** Header a token is read from by default; a `"Bearer "` prefix, if present, is stripped. */
export const DEFAULT_TOKEN_HEADER = 'authorization'

/**
 * Reads a token from the incoming HTTP request's headers, via the raw `Request` MCP's HTTP
 * transport exposes at `extra.http.req` — `undefined` over stdio (or any non-HTTP transport),
 * which has no headers at all; see the `MetaGuard`-equivalent design note in AGENTS.md.
 * @param {Object} extra - The MCP tool callback's context argument.
 * @param {string} headerName
 * @returns {string|undefined}
 */
function extractToken(extra, headerName) {
	const raw = extra?.http?.req?.headers?.get?.(headerName)
	if (!raw) return undefined
	return raw.replace(/^Bearer\s+/i, '')
}

/**
 * Wraps a {@link import('./Server.js').ServiceDef} so every action requires a resolved token
 * before its handler runs — the MCP-side equivalent of `principia-guard-moleculer`'s
 * `MetaGuard.middleware.js`. Optional and per-service: a service without a `resolveToken`
 * function is returned unchanged (public, unguarded).
 *
 * The resolved value `resolveToken` returns is attached to the handler's `extra.user`,
 * mirroring Moleculer's `ctx.meta.user`.
 * @param {import('./Server.js').ServiceDef & {resolveToken?: (tokenKey: string, context: {service: string, action: string, extra: Object}) => Promise<*>}} service
 * @param {Object} [options]
 * @param {string} [options.tokenHeader] - Header to read the token from. Defaults to
 *   {@link DEFAULT_TOKEN_HEADER} (`"authorization"`, with an optional `"Bearer "` prefix stripped).
 * @returns {import('./Server.js').ServiceDef}
 */
export function withMetaGuard(service, options = {}) {
	const { resolveToken } = service
	if (typeof resolveToken !== 'function') return service

	const tokenHeader = options.tokenHeader ?? DEFAULT_TOKEN_HEADER
	const guardedActions = {}

	for (const [actionName, action] of Object.entries(service.actions ?? {})) {
		const isBareHandler = typeof action === 'function'
		const handler = isBareHandler ? action : action.handler

		const guardedHandler = async (params, extra) => {
			const tokenKey = extractToken(extra, tokenHeader)
			if (!tokenKey) {
				throw new Error(`${service.name}.${actionName}: missing auth token`)
			}

			const user = await resolveToken(tokenKey, {
				service: service.name,
				action: actionName,
				extra,
			})
			if (!user) {
				throw new Error(`${service.name}.${actionName}: invalid auth token`)
			}

			return handler(params, { ...extra, user })
		}

		guardedActions[actionName] = isBareHandler
			? guardedHandler
			: { ...action, handler: guardedHandler }
	}

	return { ...service, actions: guardedActions }
}
