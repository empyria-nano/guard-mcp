import { createMcpHandler } from '@modelcontextprotocol/server'

import { createMcpServer } from './Server.js'

/**
 * Builds a Web-standard (`fetch`) MCP HTTP handler for a list of Moleculer-shaped services —
 * runtime-agnostic; works with `Bun.serve`, Deno, Cloudflare Workers, Hono, or anything else
 * that speaks the Fetch API. A fresh {@link createMcpServer} instance is built per request
 * (this repo's `Server.js` builder is cheap — pure registration, no I/O), matching the MCP
 * HTTP transport's default stateless serving idiom.
 * @param {Parameters<typeof createMcpServer>[0]} options - Same shape as {@link createMcpServer}'s options.
 * @returns {{fetch: (request: Request) => Promise<Response>, close: () => Promise<void>}}
 */
export function createMcpHttpHandler(options) {
	return createMcpHandler(() => createMcpServer(options))
}

/**
 * Bun-only convenience: builds an MCP HTTP handler (see {@link createMcpHttpHandler}) and
 * serves it with `Bun.serve`.
 * @param {Parameters<typeof createMcpServer>[0]} options - Same shape as {@link createMcpServer}'s options.
 * @param {Object} [bunOptions] - Passed through to `Bun.serve` (e.g. `port`, `hostname`, `tls`).
 *   `fetch` is always taken from the built MCP handler and cannot be overridden here.
 * @returns {ReturnType<typeof Bun.serve> & {close: () => Promise<void>}} The running Bun
 *   server, with an added `close()` that stops both the MCP handler and the Bun server.
 */
export function serveMcpHttp(options, bunOptions = {}) {
	const handler = createMcpHttpHandler(options)
	const server = Bun.serve({ ...bunOptions, fetch: handler.fetch })

	return Object.assign(server, {
		close: async () => {
			await handler.close()
			server.stop()
		},
	})
}
