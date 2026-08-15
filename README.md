# @principia/mcp

[MCP (Model Context Protocol)](https://modelcontextprotocol.io) helpers for **Principia**, a
nanoservice framework built primarily on Bun: publish a list of Moleculer-shaped services as
MCP tools, with JSON Schema input validation via `@principia/common`'s `createValidator` —
no Zod, no Ajv, in our own code.

## Requirements

- Bun `>=1.4.0` or Node.js `>=26`
- Plain ESM, no build step, no TypeScript

Both requirements come from [@principia/classification](https://github.com/imrefazekas/principia-classification)
and [@principia/common](https://github.com/imrefazekas/principia-common), which this package
depends on and which use the native `Temporal` global for all date/time handling.

## Install

```bash
bun add @principia/mcp
```

## Usage

```js
import { createMcpServer } from '@principia/mcp'
import { string, number } from '@principia/common'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'

const WeatherService = {
	name: 'Weather',
	actions: {
		getForecast: {
			description: 'Get the weather forecast for a city',
			params: { city: string(), days: number(3) },
			handler: async ({ city, days }) => ({ city, days, forecast: 'sunny' }),
		},
		// bare functions work too — no params schema, no description
		ping: async () => 'pong',
	},
}

const server = createMcpServer({
	name: 'my-mcp-server',
	version: '1.0.0',
	services: [WeatherService],
})

await server.connect(new StdioServerTransport())
```

Each action becomes an MCP tool named `"<service.name>.<actionName>"` — `Weather.getForecast`,
`Weather.ping` above — mirroring Moleculer's own `service.action` naming. `params` are JSON
schema property definitions built with `@principia/common`'s schema helpers (`string()`,
`number()`, `bool()`, `enumType()`, ...); incoming tool calls are validated against them before
your handler runs, and validation failures are reported back to the MCP client as a normal
tool-call error (`isError: true`) — your handler never sees invalid input. A handler's return
value can be a string, any JSON-serializable value, or an already MCP-shaped
`{ content: [...] }` result; thrown errors are also reported back as tool-call errors
automatically.

`createMcpServer` only builds and registers — connecting to a transport (stdio, HTTP, ...) is
up to you. For stdio, see `@modelcontextprotocol/server/stdio`'s `StdioServerTransport`/
`serveStdio`. For HTTP, this package has its own helper:

```js
import { serveMcpHttp } from '@principia/mcp'

serveMcpHttp(
	{ name: 'my-mcp-server', version: '1.0.0', services: [WeatherService] },
	{ port: 3000 },
)
```

`serveMcpHttp` serves MCP over `Bun.serve` directly — no web framework needed. MCP's official
`createMcpHandler` produces a plain Web-standard `{ fetch: (Request) => Promise<Response>,
close }` handler (usable with any Fetch-API server, Bun's included); `@modelcontextprotocol/hono`
is only one optional adapter among several for wiring that handler into Hono specifically, not
a requirement. If you need the bare `{fetch, close}` handler instead of an already-running Bun
server (e.g. to mount inside your own `Bun.serve`, or another Fetch-based runtime), use
`createMcpHttpHandler(options)` instead.

### Protecting services with a token

A service can require a token by adding a `resolveToken` function — the MCP-side equivalent of
`principia-guard-moleculer`'s `MetaGuard.middleware.js`, reusing the same shape as its
`getUser(ctx, action)`:

```js
const SecretsService = {
	name: 'Secrets',
	async resolveToken(tokenKey, { service, action }) {
		// look the token up however you like — call another service, hit a DB, etc.
		// return the resolved user/session, or a falsy value to reject the call
		return lookupUser(tokenKey)
	},
	actions: {
		reveal: {
			params: { id: string() },
			handler: async ({ id }, extra) => `secret for ${extra.user.name}`,
		},
	},
}
```

The token is read from the `Authorization` header (an optional `Bearer ` prefix is stripped),
or a custom header via `guard: { tokenHeader: 'x-token-key' }` passed to `createMcpServer`/
`serveMcpHttp`. Calls with a missing or unresolved token are rejected as a normal tool-call
error, and the resolved value is attached to the handler's `extra.user`, mirroring Moleculer's
`ctx.meta.user`. **This only works over HTTP** — tokens travel as request headers, and stdio has
none; a `resolveToken`-protected service called over stdio always rejects. Services without
`resolveToken` are unaffected (public) — it's entirely opt-in, per service.

### Connecting as a client

```js
import { connectStdioClient, connectHttpClient } from '@principia/mcp'

const stdioClient = await connectStdioClient({
	name: 'my-client',
	version: '1.0.0',
	command: 'node',
	args: ['./my-server.js'],
})

const httpClient = await connectHttpClient({
	name: 'my-client',
	version: '1.0.0',
	url: 'http://localhost:3000',
	token: 'my-token', // sends Authorization: Bearer my-token
})

const { tools } = await httpClient.listTools()
await httpClient.callTool({ name: 'Weather.getForecast', arguments: { city: 'Zurich' } })
```

### Aggregating many MCP servers into one (a gateway)

If you have several MCP servers and want to expose them to one agentic host as a single
connection — fewer config entries, one place to apply `lib/Guard.js`, etc. — connect to each as
a client and hand them to `createMcpGateway`:

```js
import { connectStdioClient, connectHttpClient, createMcpGateway } from '@principia/mcp'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'

const weather = await connectStdioClient({
	name: 'gw',
	version: '1.0.0',
	command: 'node',
	args: ['./weather-server.js'],
})
const search = await connectHttpClient({
	name: 'gw',
	version: '1.0.0',
	url: 'http://localhost:4000',
})

const gateway = await createMcpGateway({
	name: 'my-gateway',
	version: '1.0.0',
	upstreams: [
		{ name: 'Weather', client: weather },
		{ name: 'Search', client: search },
	],
})

await gateway.connect(new StdioServerTransport())
```

Each upstream's tools are listed once, up front, and re-exposed as
`"<upstream.name>.<toolName>"`; calls are forwarded to the owning upstream and its result
passed straight through, unvalidated a second time — the upstream already validated it.
Building a gateway does real work (one `listTools()` per upstream), so build it once and reuse
that same instance — including as `createMcpHandler`'s per-request factory for HTTP, e.g. inside
`serveMcpHttp`'s `bunOptions.fetch` — rather than reconnecting upstreams on every request.

## Modules

| Module                                 | Purpose                                                                                                                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [lib/Server.js](./lib/Server.js)       | `createMcpServer` — publishes a list of Moleculer-shaped `{ name, actions }` services as MCP tools.                                                                                                           |
| [lib/Http.js](./lib/Http.js)           | `createMcpHttpHandler` (runtime-agnostic Web-standard handler) and `serveMcpHttp` (Bun-only convenience, wraps `Bun.serve`).                                                                                  |
| [lib/Guard.js](./lib/Guard.js)         | `withMetaGuard` — optional per-service token protection; see above.                                                                                                                                           |
| [lib/Client.js](./lib/Client.js)       | `createMcpClient`, `connectStdioClient`, `connectHttpClient` — client-side helpers.                                                                                                                           |
| [lib/Gateway.js](./lib/Gateway.js)     | `createMcpGateway` — aggregates several already-connected upstream MCP clients into one server.                                                                                                               |
| [lib/Validator.js](./lib/Validator.js) | `principiaJsonSchemaValidator` — adapts `@principia/common`'s `createValidator` to the MCP SDK's pluggable JSON Schema validator interface, the same extension point its own `ajv`/`cf-worker` providers use. |

There is no official JSON-Schema-only convenience API in `@modelcontextprotocol/server` — its
`registerTool()` still needs a "Standard Schema" (what Zod produces). What _is_ official and
Zod-free is `fromJsonSchema(schema, validatorProvider)`, which wraps a plain JSON Schema object
into a Standard Schema given a validator provider — that's what `lib/Server.js` uses, backed by
`lib/Validator.js` instead of the SDK's own `ajv`/`cf-worker` providers.

Every exported function is documented with JSDoc directly in its source file — hovering
a function in VSCode or Zed shows its parameters and return type without any extra
tooling, since both editors read JSDoc from plain `.js` files automatically.

Tests live under [test/](./test/), one file per module. They drive a real
`@modelcontextprotocol/client` `Client` against the server over `InMemoryTransport` rather than
mocking the protocol.

## Scripts

```bash
bun run format       # check formatting (oxfmt)
bun run format:fix   # apply formatting
bun run lint         # lint (oxlint)
bun run lint:fix     # lint and fix
bun run test         # run tests with coverage
```

## License

MIT © Imre Fazekas
