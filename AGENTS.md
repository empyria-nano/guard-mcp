# AGENTS.md

MCP (Model Context Protocol) helpers for **Empyria**, a nanoservice framework built
primarily on Bun: publishes Moleculer-shaped `{ name, actions }` service objects as MCP tools.

## The package split that matters here

There are **two different, unrelated npm package families** claiming the MCP name:

- `@modelcontextprotocol/sdk` (currently `1.30.0`) — the original, unified SDK. Its `McpServer`
  convenience API (`tool()`/`registerTool()`) only accepts Zod schemas for tool input, with no
  JSON-Schema escape hatch found in it.
- `@modelcontextprotocol/server` + `@modelcontextprotocol/core` + `@modelcontextprotocol/client`
  (currently `2.0.0`) — the newer split packages. **This is what this repo uses.** Its
  `registerTool()` still wants a "Standard Schema" too, but it ships `fromJsonSchema(schema,
validatorProvider)`, a first-class adapter that wraps a plain JSON Schema object into one,
  given a pluggable `{ getValidator(schema) => (input) => {valid, data, errorMessage} }`
  provider — the exact same extension point its own `./validators/ajv` and
  `./validators/cf-worker` subpath exports implement. `lib/Validator.js` is that same interface,
  backed by `@empyria/common`'s `createValidator` instead.

Don't add `zod` as a dependency of this repo's own code — we never import it. It's still an
unavoidable transitive dependency of `@modelcontextprotocol/server` (used internally for the
SDK's own request/notification envelope schemas), so it'll be in `node_modules`, but nothing
here should ever construct or reference a Zod schema directly.

## HTTP transport

`lib/Http.js`'s `createMcpHttpHandler()` wraps `createMcpHandler(factory)` from
`@modelcontextprotocol/server` — it wants a **factory** (`() => McpServer`), not an
already-built server, because HTTP serving defaults to stateless: a fresh server instance per
request. `createMcpServer()` is cheap (pure registration, no I/O) so `() => createMcpServer(options)`
is the whole adapter.

The resulting handler is `{ fetch: (Request) => Promise<Response>, close }` — plain Web
Standard, no framework required. `serveMcpHttp()` wires that straight into `Bun.serve` (uses
the global `Bun`, so it only works under Bun — `createMcpHttpHandler` itself stays
runtime-agnostic and works under Node too, since nothing in it touches `Bun` unless
`serveMcpHttp` is actually called). Don't add `@modelcontextprotocol/hono` or another web
framework as a dependency for this — it's one optional adapter among several, not a
requirement, and would be an unnecessary dependency here.

## `extra` is only populated when `inputSchema` is set — always declare one

`registerTool(name, config, cb)`'s runtime dispatch (`createToolExecutor` in the SDK) checks
`config.inputSchema` at _call_ time, not just at registration: if it's set, `cb` is invoked as
`(args, extra)`; if it's unset, `cb` collapses to a **single-argument** `(extra)` call — the
would-be `args` position silently receives `extra`'s value instead, and the real `extra`
argument is `undefined`. `lib/Server.js` always builds an `inputSchema` (an empty-object one via
`defineSchema(params ?? {})` when an action declares no `params`) specifically to avoid this —
don't special-case the "no params" path back to an omitted `inputSchema`, it silently breaks
`extra` (and therefore `lib/Guard.js`, which reads `extra.http.req` for every action regardless
of whether it takes params). See the regression test in `test/Server.test.js` ("still receives a
real extra context, not undefined").

## Optional params (`defineSchema(params, { optional: true })`)

`@empyria/common`'s `defineSchema` (>= 0.1.4) accepts an `{ optional: true }` option: a property
is excluded from JSON Schema `required` when its own schema carries `optional: true` (that
marker is stripped before the property is embedded — not a real JSON Schema keyword, never
leaked into the tool's advertised inputSchema). Without the option (the default, and every call
elsewhere in the Empyria ecosystem — restate, moleculer), behavior is unchanged from before this
existed: every declared property is required, even one with its own `default`.
`registerService` in `lib/Server.js` always passes `{ optional: true }`, so any action's `params`
here can mark a field optional this way. Added upstream (not as a local derivative in this repo —
see git history for that discarded first attempt and why) 2026-08-26 for a real downstream need:
a service wrapping an S3-shaped API had several genuinely optional/defaulted params
(`contentType`, `expiresInSeconds`, ...) and `registerService`'s previous unconditional
`defineSchema` call would have silently advertised all of them as required — a real API-contract
regression, not a style preference. Usage: `params: { limit: { ...number(10), optional: true } }`.
Requires `@empyria/common` >= 0.1.4 — this package's own `package.json` is pinned there or later.

## Auth (`lib/Guard.js`)

`extra.http.req` (the raw `Request`, with real header access via `.headers.get(name)`) is
only ever populated over HTTP — confirmed empirically, not from docs alone: `extra.http` is
absent entirely over `InMemoryTransport`/stdio. `withMetaGuard`-protected services will reject
_every_ call made over a non-HTTP transport, by design (there's nowhere for a token to live).
Don't try to thread a token through `extra` for stdio — there isn't a protocol-level place to
put it short of smuggling it into every action's own `params`, which was deliberately not done
here (it would leak into every tool's public schema).

`resolveToken(tokenKey, { service, action, extra })`'s signature intentionally mirrors
`empyria-guard-moleculer`'s `getUser(ctx, action)` — passing the service/action a guarded call
is targeting, the same way that file's `action.service.meta` does, for callers whose token
resolution needs to vary per action.

## Gateway (`lib/Gateway.js`)

`createMcpGateway` does **not** re-validate arguments for proxied tools — `lib/Guard.js`'s
`passthroughValidator` in `Gateway.js` always reports `{valid: true}`. This is deliberate, not a
shortcut: the upstream server already validates the same arguments when the call is forwarded
to it via `client.callTool()`. Running a second, independent JSON Schema implementation
(ata-validator) over an already-upstream-validated payload would risk rejecting input the
upstream itself accepts (dialect/keyword coverage differences) for zero real benefit. If you
ever need the gateway to enforce something upstream doesn't, that's a deliberate new feature,
not "fixing" a missing validation step.

An `inputSchema` is still always declared per proxied tool (even a bare passthrough one for a
schema-less upstream tool) — same reason as `lib/Server.js`'s own rule: omitting it collapses
`registerTool`'s callback to a single-argument `(extra)` call instead of `(args, extra)`.

A gateway is expensive to build (one `listTools()` round trip per upstream) — it's meant to be
built once and reused, not rebuilt per request. Confirmed empirically: a `createMcpHandler`
factory can safely return the _same_ already-built `McpServer` on every call (no "already
connected" error, no per-request rebuild needed) — see the HTTP test in `test/Gateway.test.js`.

`createMcpGateway` takes already-connected `Client` instances, not transport configs — it
doesn't manage upstream connection lifecycle (that's `lib/Client.js`'s job, and the caller's to
close). Keep it that way; don't fold stdio/HTTP connection logic into `Gateway.js` a third time.

## Runtime

- Requires Bun `>=1.4.0` or Node.js `>=26`, inherited from `@empyria/classification`'s use
  of native `Temporal`. Both `@empyria/classification` and `@empyria/common` are **git
  dependencies** — this package only sees their pushed commits, not local working-tree changes
  in sibling repos.
- Plain ESM, no TypeScript, no build step.
- Relative imports must include explicit `.js` extensions — Bun tolerates missing ones, Node's
  ESM resolver doesn't.

## Tool errors vs. protocol errors

A tool call that fails validation, or whose handler throws, does **not** reject the client's
`callTool()` promise — `McpServer` catches it and resolves with `{ content: [...], isError:
true }` (the SDK's own `createToolError`), per MCP's own tool-error convention. Only genuine
protocol errors (e.g. calling a tool name that was never registered) actually reject. Write
tests accordingly — `await expect(client.callTool(...)).rejects.toThrow()` is wrong for a
validation-failure or handler-throw test; check `result.isError` instead. See `test/Server.test.js`.

## Testing

Tests drive a real `@modelcontextprotocol/client` `Client` against the server — over
`InMemoryTransport.createLinkedPair()` for transport-agnostic behavior, a real `Bun.serve` HTTP
server for anything header/auth-related (`test/Guard.test.js`, `test/Http.test.js`), and a real
spawned child process (`test/fixtures/stdio-server.js`) for `connectStdioClient`
(`test/Client.test.js`) — rather than mocking the protocol. `@modelcontextprotocol/client` is a
real dependency (not devDependency-only): `lib/Client.js` needs it at runtime, not just tests.

## Style

- Formatting is enforced by oxfmt ([.oxfmtrc.json](./.oxfmtrc.json)): tabs, single quotes, no
  semicolons, trailing commas. Run `bun run format:fix` before committing.
