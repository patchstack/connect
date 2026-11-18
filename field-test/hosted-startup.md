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
so the host can leave `NODE_OPTIONS` untouched.

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
