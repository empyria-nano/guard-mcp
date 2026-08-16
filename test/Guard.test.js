import { describe, test, expect, afterEach } from 'bun:test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { string } from '@empyria/common'
import { createMcpServer } from '../lib/Server.js'
import { serveMcpHttp } from '../lib/Http.js'
import { withMetaGuard } from '../lib/Guard.js'

let server

afterEach(async () => {
	if (server) {
		await server.close()
		server = undefined
	}
})

describe('withMetaGuard', () => {
	test('returns the service unchanged when it has no resolveToken', () => {
		const service = { name: 'Open', actions: { ping: async () => 'pong' } }
		expect(withMetaGuard(service)).toBe(service)
	})

	test('wraps every action of a service that declares resolveToken', () => {
		const service = {
			name: 'Guarded',
			resolveToken: async () => ({ id: 'u1' }),
			actions: { a: async () => 'a', b: { params: {}, handler: async () => 'b' } },
		}
		const guarded = withMetaGuard(service)
		expect(guarded).not.toBe(service)
		expect(typeof guarded.actions.a).toBe('function')
		expect(typeof guarded.actions.b.handler).toBe('function')
		// non-handler action config (params, description, ...) is preserved
		expect(guarded.actions.b.params).toEqual({})
	})
})

// Auth tokens only exist as HTTP headers — `extra.http.req` is undefined over stdio (and any
// other non-HTTP transport), so these run against a real Bun.serve HTTP server, not
// InMemoryTransport, to exercise real header extraction.
describe('withMetaGuard: end-to-end over HTTP', () => {
	function protectedServer(resolveToken, guardOptions) {
		const Service = {
			name: 'Secrets',
			resolveToken,
			actions: {
				reveal: {
					params: { id: string() },
					handler: async ({ id }, extra) => `secret-${id}-for-${extra.user.name}`,
				},
			},
		}
		return serveMcpHttp(
			{ name: 'guard-test', version: '1.0.0', services: [Service], guard: guardOptions },
			{ port: 0 },
		)
	}

	async function connectWithHeaders(headers) {
		const client = new Client({ name: 'c', version: '1.0.0' })
		const transport = new StreamableHTTPClientTransport(new URL(server.url.toString()), {
			requestInit: { headers },
		})
		await client.connect(transport)
		return client
	}

	test('rejects a call with no token at all', async () => {
		server = protectedServer(async () => ({ name: 'Bob' }))
		const client = await connectWithHeaders({})
		const result = await client.callTool({ name: 'Secrets.reveal', arguments: { id: '1' } })
		expect(result.isError).toBe(true)
		expect(result.content[0].text).toContain('missing auth token')
		await client.close()
	})

	test('rejects a call whose token resolves to nothing', async () => {
		server = protectedServer(async () => undefined)
		const client = await connectWithHeaders({ Authorization: 'Bearer bad-token' })
		const result = await client.callTool({ name: 'Secrets.reveal', arguments: { id: '1' } })
		expect(result.isError).toBe(true)
		expect(result.content[0].text).toContain('invalid auth token')
		await client.close()
	})

	test('accepts a Bearer token, strips the prefix, and resolves it into extra.user', async () => {
		let receivedToken
		server = protectedServer(async (tokenKey) => {
			receivedToken = tokenKey
			return { name: 'Bob' }
		})
		const client = await connectWithHeaders({ Authorization: 'Bearer good-token' })
		const result = await client.callTool({ name: 'Secrets.reveal', arguments: { id: '1' } })
		expect(result.isError).toBeFalsy()
		expect(result.content[0].text).toBe('secret-1-for-Bob')
		expect(receivedToken).toBe('good-token')
		await client.close()
	})

	test('passes service/action context to resolveToken, mirroring getUser(ctx, action)', async () => {
		let seenContext
		server = protectedServer(async (tokenKey, context) => {
			seenContext = context
			return { name: 'Bob' }
		})
		const client = await connectWithHeaders({ Authorization: 'Bearer t' })
		await client.callTool({ name: 'Secrets.reveal', arguments: { id: '1' } })
		expect(seenContext.service).toBe('Secrets')
		expect(seenContext.action).toBe('reveal')
		expect(seenContext.extra).toBeDefined()
		await client.close()
	})

	test('a configurable tokenHeader reads from a custom header instead of Authorization', async () => {
		let receivedToken
		server = protectedServer(
			async (tokenKey) => {
				receivedToken = tokenKey
				return { name: 'Bob' }
			},
			{ tokenHeader: 'x-token-key' },
		)
		const client = await connectWithHeaders({ 'X-Token-Key': 'custom-key' })
		const result = await client.callTool({ name: 'Secrets.reveal', arguments: { id: '1' } })
		expect(result.isError).toBeFalsy()
		expect(receivedToken).toBe('custom-key')
		await client.close()
	})

	test('a service without resolveToken stays public even when others are guarded', async () => {
		const PublicService = { name: 'Public', actions: { ping: async () => 'pong' } }
		const GuardedService = {
			name: 'Guarded',
			resolveToken: async () => ({ name: 'Bob' }),
			actions: { secret: async () => 'shh' },
		}
		server = serveMcpHttp(
			{ name: 'mixed', version: '1.0.0', services: [PublicService, GuardedService] },
			{ port: 0 },
		)
		const client = await connectWithHeaders({})

		const publicResult = await client.callTool({ name: 'Public.ping', arguments: {} })
		expect(publicResult.isError).toBeFalsy()
		expect(publicResult.content[0].text).toBe('pong')

		const guardedResult = await client.callTool({ name: 'Guarded.secret', arguments: {} })
		expect(guardedResult.isError).toBe(true)

		await client.close()
	})
})

describe('withMetaGuard: no HTTP context (stdio-equivalent)', () => {
	test('rejects — there is no request/headers to read a token from', async () => {
		const Service = {
			name: 'Secrets',
			resolveToken: async () => ({ name: 'Bob' }),
			actions: { reveal: async () => 'secret' },
		}
		const mcpServer = createMcpServer({ name: 'x', version: '1.0.0', services: [Service] })
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
		await mcpServer.connect(serverTransport)
		const client = new Client({ name: 'c', version: '1.0.0' })
		await client.connect(clientTransport)

		const result = await client.callTool({ name: 'Secrets.reveal', arguments: {} })
		expect(result.isError).toBe(true)
		expect(result.content[0].text).toContain('missing auth token')

		await client.close()
	})
})
