// Minimal MCP server run as a child process by test/Client.test.js's stdio tests.
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'

import { createMcpServer } from '../../lib/Server.js'
import { string } from '@empyria/common'

const EchoService = {
	name: 'Echo',
	actions: {
		say: { params: { text: string() }, handler: async ({ text }) => text },
	},
}

const server = createMcpServer({
	name: 'fixture-server',
	version: '1.0.0',
	services: [EchoService],
})
await server.connect(new StdioServerTransport())
