import { describe, test, expect, afterEach } from 'bun:test'
import { string } from '@principia/common'
import { createMcpClient, connectStdioClient, connectHttpClient } from '../lib/Client.js'
import { serveMcpHttp } from '../lib/Http.js'

describe('createMcpClient', () => {
	test('builds an unconnected client', () => {
		const client = createMcpClient({ name: 'x', version: '1.0.0' })
		expect(client).toBeDefined()
		expect(typeof client.connect).toBe('function')
	})
})

describe('connectStdioClient', () => {
	test('spawns a real server process and connects over stdio', async () => {
		const client = await connectStdioClient({
			name: 'test-client',
			version: '1.0.0',
			command: 'bun',
			args: [new URL('./fixtures/stdio-server.js', import.meta.url).pathname],
		})
		try {
			const { tools } = await client.listTools()
			expect(tools.map((t) => t.name)).toEqual(['Echo.say'])

			const result = await client.callTool({ name: 'Echo.say', arguments: { text: 'hi' } })
			expect(result.content).toEqual([{ type: 'text', text: 'hi' }])
		} finally {
			await client.close()
		}
	})
})

describe('connectHttpClient', () => {
	let server

	afterEach(async () => {
		if (server) {
			await server.close()
			server = undefined
		}
	})

	test('connects over HTTP and can call a tool', async () => {
		const Service = {
			name: 'Echo',
			actions: { say: { params: { text: string() }, handler: async ({ text }) => text } },
		}
		server = serveMcpHttp({ name: 'x', version: '1.0.0', services: [Service] }, { port: 0 })

		const client = await connectHttpClient({
			name: 'c',
			version: '1.0.0',
			url: server.url.toString(),
		})
		try {
			const { tools } = await client.listTools()
			expect(tools.map((t) => t.name)).toEqual(['Echo.say'])
		} finally {
			await client.close()
		}
	})

	test('the "token" shorthand sends an Authorization: Bearer header', async () => {
		let receivedToken
		const Service = {
			name: 'Secrets',
			resolveToken: async (tokenKey) => {
				receivedToken = tokenKey
				return { name: 'Bob' }
			},
			actions: { reveal: async () => 'secret' },
		}
		server = serveMcpHttp({ name: 'x', version: '1.0.0', services: [Service] }, { port: 0 })

		const client = await connectHttpClient({
			name: 'c',
			version: '1.0.0',
			url: server.url.toString(),
			token: 'my-token',
		})
		try {
			const result = await client.callTool({ name: 'Secrets.reveal', arguments: {} })
			expect(result.isError).toBeFalsy()
			expect(receivedToken).toBe('my-token')
		} finally {
			await client.close()
		}
	})

	test('a custom header (matching a custom tokenHeader guard) also works', async () => {
		let receivedToken
		const Service = {
			name: 'Secrets',
			resolveToken: async (tokenKey) => {
				receivedToken = tokenKey
				return { name: 'Bob' }
			},
			actions: { reveal: async () => 'secret' },
		}
		server = serveMcpHttp(
			{
				name: 'x',
				version: '1.0.0',
				services: [Service],
				guard: { tokenHeader: 'x-token-key' },
			},
			{ port: 0 },
		)

		const client = await connectHttpClient({
			name: 'c',
			version: '1.0.0',
			url: server.url.toString(),
			headers: { 'X-Token-Key': 'custom-token' },
		})
		try {
			const result = await client.callTool({ name: 'Secrets.reveal', arguments: {} })
			expect(result.isError).toBeFalsy()
			expect(receivedToken).toBe('custom-token')
		} finally {
			await client.close()
		}
	})
})
