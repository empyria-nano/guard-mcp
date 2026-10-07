import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server'

/**
 * A validator provider that never actually validates — used for gateway-proxied tools, whose
 * arguments are already validated by the upstream server when the call is forwarded. Re-running
 * a second, independent JSON Schema implementation over the same input here would risk rejecting
 * (or silently reshaping) input the upstream itself considers valid, for zero benefit.
 * @type {import('./Validator.js').empyriaJsonSchemaValidator}
 */
const passthroughValidator = {
	getValidator: () => (input) => ({ valid: true, data: input }),
}

/**
 * @typedef {Object} UpstreamDef
 * @property {string} name - Namespace prefix for this upstream's tools in the gateway
 *   (`"<name>.<toolName>"`) — must be unique among the gateway's upstreams.
 * @property {import('@modelcontextprotocol/client').Client} client - An already-connected
 *   client (see `lib/Client.js`'s `connectStdioClient`/`connectHttpClient`). The gateway reads
 *   its tool list and forwards calls to it, but does not own its lifecycle — closing it is the
 *   caller's responsibility.
 */

/**
 * Builds an MCP server that aggregates a list of already-connected upstream MCP clients into
 * one: every upstream's tools are listed once, up front, and re-exposed as
 * `"<upstream.name>.<toolName>"`, with calls forwarded to the owning upstream and its result
 * passed straight through. Tool arguments are validated once, by the upstream itself — the
 * gateway does not re-validate.
 *
 * Building a gateway does real work (one `listTools()` round trip per upstream) — build it
 * once and reuse the same instance for every connection, rather than rebuilding per request;
 * `createMcpHandler`'s per-request factory can safely return the same instance every time.
 * @param {Object} options
 * @param {string} options.name - MCP server name, shown to clients.
 * @param {string} options.version - MCP server version, shown to clients.
 * @param {UpstreamDef[]} options.upstreams - Already-connected upstream clients to aggregate.
 * @param {import('@modelcontextprotocol/server').ServerCapabilities} [options.capabilities] -
 *   Defaults to `{ tools: {} }`.
 * @returns {Promise<McpServer>}
 * @throws {Error} If two upstreams share a `name`.
 */
export async function createMcpGateway({ name, version, upstreams, capabilities = { tools: {} } }) {
	const seen = new Set()
	for (const upstream of upstreams) {
		if (seen.has(upstream.name)) {
			throw new Error(`Duplicate upstream name '${upstream.name}'`)
		}
		seen.add(upstream.name)
	}

	const server = new McpServer({ name, version }, { capabilities })

	for (const upstream of upstreams) {
		const { tools } = await upstream.client.listTools()

		for (const tool of tools) {
			const config = {
				description: tool.description,
				// Always declared, even as an empty passthrough — matches lib/Server.js's own
				// rule: registerTool only calls the callback as (args, extra) when inputSchema
				// is set, collapsing to a single (extra) argument otherwise.
				inputSchema: fromJsonSchema(
					tool.inputSchema ?? { type: 'object', properties: {} },
					passthroughValidator,
				),
			}

			server.registerTool(`${upstream.name}.${tool.name}`, config, async (args) => {
				return upstream.client.callTool({ name: tool.name, arguments: args })
			})
		}
	}

	return server
}
