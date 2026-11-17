# Host-managed startup without app source changes

The Fastify fixture starts the same entry file with and without a host-owned
Node loader hook. The hook uses `node:module.registerHooks()` to attach the
existing Fastify adapter when the app imports its installed Fastify factory.
It preserves the default and named exports. The fixture pins one copy of
Fastify 5.12.1 and uses a local synthetic rule bundle.

Build and pack Connect, then run the fixtures against the resulting tarball.

```sh
npm run build
tarball=$(npm pack --ignore-scripts --quiet)
npm run test:frameworks -- fastify-startup-esm "$tarball"
npm run test:frameworks -- fastify-startup-cjs "$tarball"
```

Both fixtures send HTTP requests to a real server. They check the source is
byte-for-byte identical, parsed JSON still reaches the app, a matching request
is blocked, scoped response rules redact values, and a stream's first chunk
reaches the client while the response is still open. The tests ran on Node
22.22, 24.21 and 26.8. The hook runs via an explicit `node --import` argument,
so the host can leave `NODE_OPTIONS` untouched. The live fixture starts the
package's `@patchstack/connect/register/fastify` export, then runs the separate
test probe. A deployed app only needs the package preload.

For a partner pilot, start with one app per process and add the hook through
the service manager or container command. Verify the framework and package
version, rule delivery for the deployment, and actual HTTP coverage before
enabling enforcement. Use the framework-native scaffold when the host can
participate in the build. That model also gives bundled and edge apps an
appropriate place to attach the guard.

The experiment covers unbundled Fastify apps that load the tested factory by
package name. Bundled or alternate entry points, raw replies that bypass
Fastify's send hook, and shared tenant processes need separate integration. Stream
headers are screened and their bodies pass through. Live rule delivery and
build identity are verified separately by the hosted deployment fixture.

A host-side proxy could apply request and response rules to traffic it
terminates. It would need separate integration for app-specific parsed fields,
dependency activity and outbound calls. A separate loader experiment could
observe which package versions really load, then evaluate version-specific
patches. Package replacement has its own compatibility and rollback
requirements and is outside this fixture.

## Live Linux smoke test

For a dedicated sandbox site, supply `PATCHSTACK_SITE_UUID` and
`PATCHSTACK_API_KEY` through the Linux runner's environment. From the same
checkout used to build the tarball, run either Fastify fixture with
`PS_FASTIFY_LIVE=1`.

```sh
PS_FASTIFY_LIVE=1 npm run test:frameworks -- fastify-startup-esm "$tarball"
PS_FASTIFY_LIVE=1 npm run test:frameworks -- fastify-startup-cjs "$tarball"
```

This uploads the fixture's package inventory and input map, starts Fastify in
dry-run mode, and checks a signed activation response over loopback HTTP. It
compares the uploaded build ID with a different local ID, and checks the
service's verdict in both cases. The fixture uses `prepare-deploy` with the
runtime's configured artifact path, and runs `verify-deploy` before sending
ordinary fixture traffic. Readiness must pass on the matching candidate and
refuse the different deployment. Use a sandbox site reserved for this fixture
because each run uploads an app map. Rule delivery and a matching build do not
establish that this fixture has any generated rules to enforce.

## Build-scoped rule check against a local service

Use `PS_FASTIFY_LOCAL_SAAS=http://127.0.0.1:<port>/monitor/pulse` with the
same command above. Run once to upload the fixture's map. In the local service,
attach a synthetic request rule to that map's build for `POST /fixture`. Match
the literal `fixture-block` in `post.label` and configure the sandbox site for
blocking. Rerun the same fixture and tarball with `PS_FASTIFY_SCOPE_RULE` set to
the served rule ID. The matching build returns 403. The other build's lookup
omits the rule and returns 200.

Optionally set `PS_FASTIFY_FALLBACK_RULES_URL` to a second loopback endpoint that
delivers the sandbox site's unfiltered bundle. The same mismatched build must
then load the rule in detect-only mode and still return 200. Verify the two
recorded matches share a rule revision and only the first was enforced.

## AI builder deployment targets

Select the adapter from the deployed server entry. Build tools listed in
`package.json` can also produce static output. Install protection separately
at any backend the browser calls directly.

| Builder | Documented deployment shape | Connect integration |
| --- | --- | --- |
| GoDaddy Airo AI Builder | Exports code as a ZIP. GoDaddy's separate Node.js Hosting product runs apps on Node 22 using their build and start scripts. [Airo export](https://www.godaddy.com/en-in/help/download-my-airo-ai-builder-files-and-code-42993), [Node.js Hosting requirements](https://www.godaddy.com/help/nodejs-hosting-faq-42915) | Inspect the exported entry. Supported Fastify apps can use the preload on Node hosting when the host controls startup. Managed Airo publishing needs its own deployment verification. |
| Hostinger Horizons | Typically React and Vite with Node.js backend code. Integrated backend projects can also use PocketBase. [Horizons overview](https://www.hostinger.com/support/11004356-hostinger-horizons-creating-and-managing-your-projects/), [Integrated backend](https://www.hostinger.com/changelog) | Use the framework adapter for a supported server-rendered project. A static Vite export supports inventory scanning. PocketBase and separate managed APIs need a separate protection boundary. |
| Lovable | Current TanStack Start apps run on Cloudflare Workers. Earlier React/Vite apps were static and used separate backend functions. [Lovable deployment stack](https://lovable.dev/blog/building-apps-using-tanstack-start) | Use the TanStack Fetch adapter on the Worker. Separate functions and direct Supabase calls need their own coverage. |
| IONOS | MyWebsite Now publishes within IONOS. Momentum AI App & Site Builder can export PHP, Node.js, and static files. [MyWebsite export limits](https://www.ionos.com/help/websites-stores/organize-websites-and-stores/website-builders-overview-of-export-options/), [Momentum export](https://www.ionos.co.uk/help/ai/using-the-ai-app-site-builder/exporting-data-from-the-ai-app-site-builder/) | Select the adapter from the exported Node app's actual entry. PHP and static sites need their own protection coverage. |

Exercise representative builds locally against a packed Connect artifact. The
Worker fixture runs the production bundle in local `workerd`. The React Router
fixture uses the server-rendered framework mode.

```sh
npm run test:frameworks -- tanstack-worker "$tarball"
npm run test:frameworks -- react-router "$tarball"
```

For a managed builder rollout, repeat the check against a sandbox deployed
through the builder itself. Inspect the emitted entry and verify that a
request actually reaches the guard before enabling blocking.
