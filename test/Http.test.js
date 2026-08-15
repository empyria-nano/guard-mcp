import { describe, test, expect, afterEach } from 'bun:test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { string } from '@principia/common'
import { createMcpHttpHandler, serveMcpHttp } from '../lib/Http.js'

let server

afterEach(async () => {
	if (server) {
		await server.close()
		server = undefined
	}
})

const EchoService = {
	name: 'Echo',
	actions: {
		say: { params: { text: string() }, handler: async ({ text }) => text },
	},
}

describe('createMcpHttpHandler', () => {
	test('returns a Web-standard {fetch, close} handler', async () => {
		const handler = createMcpHttpHandler({ name: 'x', version: '1.0.0', services: [] })
		expect(typeof handler.fetch).toBe('function')
		expect(typeof handler.close).toBe('function')
		await handler.close()
	})
})

describe('serveMcpHttp', () => {
	test('serves the MCP handler over a real Bun.serve HTTP server', async () => {
		server = serveMcpHttp(
			{ name: 'http-test', version: '1.0.0', services: [EchoService] },
			{ port: 0 },
		)

		const client = new Client({ name: 'test-client', version: '1.0.0' })
		const transport = new StreamableHTTPClientTransport(new URL(server.url.toString()))
		await client.connect(transport)

		const { tools } = await client.listTools()
		expect(tools.map((t) => t.name)).toEqual(['Echo.say'])

		const result = await client.callTool({ name: 'Echo.say', arguments: { text: 'hi' } })
		expect(result.content).toEqual([{ type: 'text', text: 'hi' }])

		await client.close()
	})

	test('passes bunOptions through to Bun.serve (e.g. explicit port 0 for an ephemeral port)', async () => {
		server = serveMcpHttp({ name: 'x', version: '1.0.0', services: [] }, { port: 0 })
		expect(server.port).toBeGreaterThan(0)
	})
})
