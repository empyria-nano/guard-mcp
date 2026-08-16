import { describe, test, expect, afterEach } from 'bun:test'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { Client } from '@modelcontextprotocol/client'
import { string } from '@empyria/common'
import { createMcpServer } from '../lib/Server.js'
import { createMcpGateway } from '../lib/Gateway.js'

const openClients = []

afterEach(async () => {
	await Promise.all(openClients.splice(0).map((c) => c.close()))
})

/** Builds a backend server from `services` and returns a connected client to it. */
async function backendClient(services) {
	const backend = createMcpServer({ name: 'backend', version: '1.0.0', services })
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
	await backend.connect(serverTransport)
	const client = new Client({ name: 'upstream-client', version: '1.0.0' })
	await client.connect(clientTransport)
	openClients.push(client)
	return client
}

/** Connects a client to an already-built gateway server. */
async function connectTo(server) {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
	await server.connect(serverTransport)
	const client = new Client({ name: 'gateway-client', version: '1.0.0' })
	await client.connect(clientTransport)
	openClients.push(client)
	return client
}

describe('createMcpGateway', () => {
	test('aggregates tools from every upstream, namespaced by upstream name', async () => {
		const weather = await backendClient([
			{ name: 'Weather', actions: { getForecast: async () => 'sunny' } },
		])
		const search = await backendClient([
			{ name: 'Search', actions: { query: async () => 'results' } },
		])

		const gateway = await createMcpGateway({
			name: 'gw',
			version: '1.0.0',
			upstreams: [
				{ name: 'WeatherSrv', client: weather },
				{ name: 'SearchSrv', client: search },
			],
		})
		const client = await connectTo(gateway)

		const { tools } = await client.listTools()
		expect(tools.map((t) => t.name).sort()).toEqual([
			'SearchSrv.Search.query',
			'WeatherSrv.Weather.getForecast',
		])
	})

	test('forwards a call to the owning upstream and returns its result unchanged', async () => {
		const weather = await backendClient([
			{
				name: 'Weather',
				actions: {
					getForecast: {
						params: { city: string() },
						handler: async ({ city }) => `sunny in ${city}`,
					},
				},
			},
		])
		const gateway = await createMcpGateway({
			name: 'gw',
			version: '1.0.0',
			upstreams: [{ name: 'WeatherSrv', client: weather }],
		})
		const client = await connectTo(gateway)

		const result = await client.callTool({
			name: 'WeatherSrv.Weather.getForecast',
			arguments: { city: 'Zurich' },
		})
		expect(result.content).toEqual([{ type: 'text', text: 'sunny in Zurich' }])
	})

	test('an invalid-argument error from the upstream is forwarded, not swallowed', async () => {
		const weather = await backendClient([
			{
				name: 'Weather',
				actions: {
					getForecast: { params: { city: string() }, handler: async ({ city }) => city },
				},
			},
		])
		const gateway = await createMcpGateway({
			name: 'gw',
			version: '1.0.0',
			upstreams: [{ name: 'WeatherSrv', client: weather }],
		})
		const client = await connectTo(gateway)

		const result = await client.callTool({
			name: 'WeatherSrv.Weather.getForecast',
			arguments: {},
		})
		expect(result.isError).toBe(true)
		expect(result.content[0].text).toContain('city')
	})

	test('a schema-less upstream tool proxies correctly too', async () => {
		const svc = await backendClient([{ name: 'Svc', actions: { ping: async () => 'pong' } }])
		const gateway = await createMcpGateway({
			name: 'gw',
			version: '1.0.0',
			upstreams: [{ name: 'SvcSrv', client: svc }],
		})
		const client = await connectTo(gateway)

		const result = await client.callTool({ name: 'SvcSrv.Svc.ping', arguments: {} })
		expect(result.content[0].text).toBe('pong')
	})

	test('rejects two upstreams sharing a name, before connecting anything', async () => {
		const weather = await backendClient([
			{ name: 'Weather', actions: { ping: async () => 'a' } },
		])
		const search = await backendClient([{ name: 'Search', actions: { ping: async () => 'b' } }])

		await expect(
			createMcpGateway({
				name: 'gw',
				version: '1.0.0',
				upstreams: [
					{ name: 'Dup', client: weather },
					{ name: 'Dup', client: search },
				],
			}),
		).rejects.toThrow(/Duplicate upstream name/)
	})

	test('an empty upstream list produces a server with no tools', async () => {
		const gateway = await createMcpGateway({ name: 'gw', version: '1.0.0', upstreams: [] })
		const client = await connectTo(gateway)
		expect((await client.listTools()).tools).toEqual([])
	})

	test('one built gateway instance, reused (not rebuilt) as the factory, serves multiple HTTP requests', async () => {
		// Gateways are expensive to build (a listTools() round trip per upstream) — the
		// documented pattern is build once, hand createMcpHandler a factory that returns
		// that same instance every time, rather than a factory that rebuilds per request.
		const svc = await backendClient([{ name: 'Svc', actions: { ping: async () => 'pong' } }])
		const gateway = await createMcpGateway({
			name: 'gw',
			version: '1.0.0',
			upstreams: [{ name: 'SvcSrv', client: svc }],
		})

		const { createMcpHandler } = await import('@modelcontextprotocol/server')
		const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client')
		const handler = createMcpHandler(() => gateway)
		const bunServer = Bun.serve({ port: 0, fetch: handler.fetch })

		try {
			for (let i = 0; i < 2; i++) {
				const client = new Client({ name: `http-client-${i}`, version: '1.0.0' })
				await client.connect(
					new StreamableHTTPClientTransport(new URL(bunServer.url.toString())),
				)
				const result = await client.callTool({ name: 'SvcSrv.Svc.ping', arguments: {} })
				expect(result.content[0].text).toBe('pong')
				await client.close()
			}
		} finally {
			await handler.close()
			bunServer.stop()
		}
	})
})
