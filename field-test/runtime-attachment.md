# Runtime attachment options

| Host boundary | What it can cover | Next test |
| --- | --- | --- |
| Node module loader | Known package factories in apps whose startup the host controls. The Fastify pilot attaches after body parsing and before the handler. | Test coexisting instrumentation and a managed Linux service restart. |
| Node HTTP diagnostics | Compare which HTTP requests Node observed with those that traversed a Connect adapter. HTTP/2 has separate events. | Use counters to identify missing coverage. Keep enforcement at a hook that controls the request or response. |
| Node HTTP listener or outbound transport | An early listener can work with URL and headers. The stock runtime can screen supported outbound calls. | Validate HTTP/2, upgrades, and framework body ownership separately before adding enforcement at a core listener. |
| Host proxy or network policy | Request and response policy at a TLS-terminating proxy. Network policy can constrain process egress independently. | Test tenant identity at the trusted proxy boundary and compare it with in-process reporting. |
| Native Fetch handler | Wrap the handler in Bun, Deno, Workers, or another runtime that passes a Web Request to the app. | Start with the native handler, then add tests for the runtime's route tables, streaming and outbound APIs. |

Node's [module hooks](https://nodejs.org/api/module.html#moduleregisterhooksoptions)
support host startup integrations with explicit arguments. Node's
[diagnostics channels](https://nodejs.org/api/diagnostics_channel.html#built-in-channels)
publish HTTP lifecycle events. Package-load inventory and any future
version-specific package replacement need their own rules, provenance and
rollback tests.

Deno documents [synchronous loader hooks](https://docs.deno.com/runtime/reference/loader_hooks/)
and [native Fetch serving](https://docs.deno.com/runtime/fundamentals/http_server/).
Bun has [runtime plugins](https://bun.com/docs/runtime/plugins) and
[a native HTTP handler](https://bun.com/docs/runtime/http/server). Workers
provide a [Fetch entry point](https://developers.cloudflare.com/workers/runtime-apis/handlers/fetch/).
Bundled apps need their deployment or framework integration because the original
package may never reach a runtime loader.

The local smoke test exercises a synthetic module and real loopback HTTP with
the Connect build for each runtime. It does not authenticate to a rules service.
Run it after building:

```sh
bun scripts/fetch-runtime-consumer.mjs
deno run --no-prompt --allow-net=127.0.0.1 --allow-env --allow-read=. scripts/fetch-runtime-consumer.mjs
```

Run the Deno test in an isolated shell without application secrets. Its
environment and filesystem permissions let the guard load its configuration and
code. Its network permission limits the test to loopback.
