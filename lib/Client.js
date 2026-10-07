import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

/**
 * Builds a bare (unconnected) MCP client. See {@link connectStdioClient}/{@link connectHttpClient}
 * for the common case of building and connecting in one call.
 * @param {Object} options
 * @param {string} options.name - Client name, shown to the server.
 * @param {string} options.version - Client version, shown to the server.
 * @returns {Client}
 */
export function createMcpClient({ name, version }) {
	return new Client({ name, version })
}

/**
 * Builds an MCP client and connects it to a server over stdio, spawning the server as a
 * child process.
 * @param {Object} options
 * @param {string} options.name - Client name, shown to the server.
 * @param {string} options.version - Client version, shown to the server.
 * @param {string} options.command - Executable to run to start the server.
 * @param {string[]} [options.args] - Command-line arguments.
 * @param {Record<string, string>} [options.env] - Environment for the spawned process; inherits
 *   a safe default subset of the current process's environment if omitted.
 * @returns {Promise<Client>} The connected client.
 */
export async function connectStdioClient({ name, version, command, args, env }) {
	const client = createMcpClient({ name, version })
	await client.connect(new StdioClientTransport({ command, args, env }))
	return client
}

/**
 * Builds an MCP client and connects it to a server over streamable HTTP.
 * @param {Object} options
 * @param {string} options.name - Client name, shown to the server.
 * @param {string} options.version - Client version, shown to the server.
 * @param {string} options.url - The server's HTTP endpoint (e.g. what {@link import('./Http.js').serveMcpHttp} serves).
 * @param {string} [options.token] - Shorthand for an `Authorization: Bearer <token>` header —
 *   matches `lib/Guard.js`'s default `tokenHeader` convention for a `withMetaGuard`-protected
 *   server. Ignored if `headers` already sets `Authorization`.
 * @param {Record<string, string>} [options.headers] - Additional request headers (e.g. for a
 *   `withMetaGuard` server configured with a custom `tokenHeader`).
 * @returns {Promise<Client>} The connected client.
 */
export async function connectHttpClient({ name, version, url, token, headers = {} }) {
	const client = createMcpClient({ name, version })
	const requestHeaders = token ? { Authorization: `Bearer ${token}`, ...headers } : headers
	await client.connect(
		new StreamableHTTPClientTransport(new URL(url), {
			requestInit: { headers: requestHeaders },
		}),
	)
	return client
}
