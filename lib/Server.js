import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server'

import { defineSchema } from '@principia/common'

import { principiaJsonSchemaValidator } from './Validator.js'
import { withMetaGuard } from './Guard.js'

/**
 * @typedef {Object} ActionDef
 * @property {string} [description] - Shown to MCP clients as the tool's description.
 * @property {Object<string, Object>} [params] - Map of param name to JSON schema, built with
 *   `@principia/common`'s schema helpers (`string()`, `number()`, `bool()`, ...). Omit for a
 *   tool that takes no arguments.
 * @property {(params: Object, extra: Object) => *} handler - Receives the validated params
 *   (or `{}` if no `params` schema was declared) and the MCP request's `extra` context.
 *   May return anything JSON-serializable, a string, or an already MCP-shaped
 *   `{ content: [...] }` result; thrown errors are reported back to the client as a
 *   tool-call error automatically.
 */

/**
 * A Moleculer-shaped service definition: `{ name, actions }`, where each action is either
 * a bare async handler or an {@link ActionDef}. Every action becomes an MCP tool named
 * `"<service.name>.<actionName>"`.
 * @typedef {Object} ServiceDef
 * @property {string} name
 * @property {Object<string, ActionDef|((params: Object, extra: Object) => *)>} actions
 */

/**
 * Normalizes an MCP tool handler's return value into a `CallToolResult`. Passes an
 * already-shaped result through unchanged; wraps a string as-is and anything else as
 * pretty-printed JSON, both as a single text content block.
 * @param {*} result
 * @returns {{content: Array<{type: string, text: string}>}}
 */
function toCallToolResult(result) {
	if (result && typeof result === 'object' && Array.isArray(result.content)) return result
	if (typeof result === 'string') return { content: [{ type: 'text', text: result }] }
	return { content: [{ type: 'text', text: JSON.stringify(result ?? null) }] }
}

/**
 * Registers every action of a service as an MCP tool on `server`.
 * @param {McpServer} server
 * @param {ServiceDef} service
 */
function registerService(server, service) {
	if (!service?.name) throw new Error('Each service must have a name')

	for (const [actionName, action] of Object.entries(service.actions ?? {})) {
		const isBareHandler = typeof action === 'function'
		const handler = isBareHandler ? action : action.handler
		if (typeof handler !== 'function') {
			throw new Error(
				`Service '${service.name}' action '${actionName}' has no handler function`,
			)
		}

		const config = { description: isBareHandler ? undefined : action.description }
		const params = isBareHandler ? undefined : action.params
		// Always declare an inputSchema, even an empty one: the SDK only calls the tool
		// callback with (args, extra) when inputSchema is set. Omitting it for a
		// no-params action drops to a single-argument (extra) call instead — silently
		// handing the caller's own context object to `args` and leaving `extra` (and
		// therefore any auth context) undefined.
		config.inputSchema = fromJsonSchema(
			defineSchema(params ?? {}),
			principiaJsonSchemaValidator,
		)

		server.registerTool(`${service.name}.${actionName}`, config, async (args, extra) => {
			const result = await handler(args ?? {}, extra)
			return toCallToolResult(result)
		})
	}
}

/**
 * Builds an MCP server exposing a list of Moleculer-shaped services as tools —
 * `{ name: 'Weather', actions: { getForecast: { params, handler } } }` becomes the
 * `"Weather.getForecast"` tool, with `params` validated as JSON schema via
 * `@principia/common`'s `createValidator` (no Zod, no Ajv).
 *
 * Connecting the server to a transport (stdio, HTTP, ...) is the caller's responsibility —
 * this only builds and registers; see `@modelcontextprotocol/server/stdio`'s
 * `StdioServerTransport` or `serveStdio`, or `WebStandardStreamableHTTPServerTransport`.
 * @param {Object} options
 * @param {string} options.name - MCP server name, shown to clients.
 * @param {string} options.version - MCP server version, shown to clients.
 * @param {ServiceDef[]} [options.services] - Services to publish as tools.
 * @param {import('@modelcontextprotocol/server').ServerCapabilities} [options.capabilities] -
 *   Defaults to `{ tools: {} }`.
 * @param {Object} [options.guard] - Passed through to {@link withMetaGuard} for every service
 *   that declares a `resolveToken` (e.g. `{ tokenHeader: 'x-token-key' }`); services without
 *   one are unaffected. See `lib/Guard.js`.
 * @returns {McpServer}
 */
export function createMcpServer({
	name,
	version,
	services = [],
	capabilities = { tools: {} },
	guard,
}) {
	const server = new McpServer({ name, version }, { capabilities })

	for (const service of services) registerService(server, withMetaGuard(service, guard))

	return server
}
