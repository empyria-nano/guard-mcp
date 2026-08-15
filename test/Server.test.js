import { describe, test, expect } from 'bun:test'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { Client } from '@modelcontextprotocol/client'
import { string, number } from '@principia/common'
import { createMcpServer } from '../lib/Server.js'

/** Builds a server from `services` and a connected client pointed at it. */
async function connected(services) {
	const server = createMcpServer({ name: 'test-server', version: '1.0.0', services })
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
	await server.connect(serverTransport)
	const client = new Client({ name: 'test-client', version: '1.0.0' })
	await client.connect(clientTransport)
	return { server, client }
}

describe('createMcpServer', () => {
	test('exposes no tools when given no services', async () => {
		const { client } = await connected([])
		expect((await client.listTools()).tools).toEqual([])
	})

	test('registers each action as "Service.action", with its JSON schema', async () => {
		const WeatherService = {
			name: 'Weather',
			actions: {
				getForecast: {
					description: 'Get the weather forecast for a city',
					params: { city: string(), days: number(3) },
					handler: async (params) => params,
				},
			},
		}
		const { client } = await connected([WeatherService])
		const { tools } = await client.listTools()

		expect(tools).toHaveLength(1)
		expect(tools[0].name).toBe('Weather.getForecast')
		expect(tools[0].description).toBe('Get the weather forecast for a city')
		expect(tools[0].inputSchema.properties.city).toEqual({ type: 'string' })
		expect(tools[0].inputSchema.properties.days).toEqual({ type: 'number', default: 3 })
		expect(tools[0].inputSchema.required).toEqual(['city', 'days'])
	})

	test('applies schema defaults and returns the handler result as JSON text', async () => {
		const WeatherService = {
			name: 'Weather',
			actions: {
				getForecast: {
					params: { city: string(), days: number(3) },
					handler: async (params) => params,
				},
			},
		}
		const { client } = await connected([WeatherService])
		const result = await client.callTool({
			name: 'Weather.getForecast',
			arguments: { city: 'Zurich' },
		})
		expect(result.isError).toBeFalsy()
		expect(JSON.parse(result.content[0].text)).toEqual({ city: 'Zurich', days: 3 })
	})

	test('a bare-function action needs no params and gets an empty-object schema', async () => {
		const PingService = { name: 'Ping', actions: { ping: async () => 'pong' } }
		const { client } = await connected([PingService])

		const { tools } = await client.listTools()
		expect(tools[0].inputSchema).toEqual({
			type: 'object',
			properties: {},
			required: [],
			additionalProperties: true,
		})

		const result = await client.callTool({ name: 'Ping.ping', arguments: {} })
		expect(result.content[0].text).toBe('pong')
	})

	test('a no-params action still receives a real extra context, not undefined', async () => {
		// Regression test: the SDK only calls the tool callback with (args, extra) when
		// inputSchema is set — omit it for a no-params action and the callback collapses
		// to a single-argument (extra) call, silently handing extra's value to `args`
		// and leaving the handler's own `extra` argument undefined.
		let seenExtra
		const Service = {
			name: 'Svc',
			actions: {
				whoami: async (params, extra) => {
					seenExtra = extra
					return 'ok'
				},
			},
		}
		const { client } = await connected([Service])
		await client.callTool({ name: 'Svc.whoami', arguments: {} })
		expect(seenExtra).toBeDefined()
		expect(typeof seenExtra).toBe('object')
	})

	test('a string handler result becomes a single text block, unwrapped', async () => {
		const Service = { name: 'Svc', actions: { hello: async () => 'hi there' } }
		const { client } = await connected([Service])
		const result = await client.callTool({ name: 'Svc.hello', arguments: {} })
		expect(result.content).toEqual([{ type: 'text', text: 'hi there' }])
	})

	test('an already MCP-shaped result passes through unchanged', async () => {
		const shaped = { content: [{ type: 'text', text: 'custom' }], _meta: { x: 1 } }
		const Service = { name: 'Svc', actions: { raw: async () => shaped } }
		const { client } = await connected([Service])
		const result = await client.callTool({ name: 'Svc.raw', arguments: {} })
		expect(result.content).toEqual(shaped.content)
	})

	test('invalid input is reported as a tool error, not a thrown protocol error', async () => {
		const Service = {
			name: 'Weather',
			actions: {
				getForecast: { params: { city: string() }, handler: async (p) => p },
			},
		}
		const { client } = await connected([Service])
		const result = await client.callTool({ name: 'Weather.getForecast', arguments: {} })
		expect(result.isError).toBe(true)
		expect(result.content[0].text).toContain('city')
	})

	test('a handler that throws is reported as a tool error', async () => {
		const Service = {
			name: 'Svc',
			actions: {
				explode: async () => {
					throw new Error('kaboom')
				},
			},
		}
		const { client } = await connected([Service])
		const result = await client.callTool({ name: 'Svc.explode', arguments: {} })
		expect(result.isError).toBe(true)
		expect(result.content[0].text).toContain('kaboom')
	})

	test('calling an unregistered tool rejects', async () => {
		const { client } = await connected([{ name: 'Svc', actions: { ping: async () => 'pong' } }])
		await expect(client.callTool({ name: 'Nope.action', arguments: {} })).rejects.toThrow()
	})

	test('multiple services register distinct, non-colliding tools', async () => {
		const A = { name: 'A', actions: { act: async () => 'a' } }
		const B = { name: 'B', actions: { act: async () => 'b' } }
		const { client } = await connected([A, B])
		const names = (await client.listTools()).tools.map((t) => t.name).sort()
		expect(names).toEqual(['A.act', 'B.act'])
	})

	test('throws when a service has no name', () => {
		expect(() =>
			createMcpServer({ name: 'x', version: '1', services: [{ actions: {} }] }),
		).toThrow(/name/)
	})

	test('throws when an action has no handler function', () => {
		expect(() =>
			createMcpServer({
				name: 'x',
				version: '1',
				services: [{ name: 'Svc', actions: { bad: { description: 'oops' } } }],
			}),
		).toThrow(/handler/)
	})
})
