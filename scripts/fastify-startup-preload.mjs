// Proof of concept for one host-managed Fastify app per Node process.
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { patchstackFastify } from './fastify-guard.mjs';

const entry = process.argv[1];
if (!entry) throw new Error('The Fastify startup fixture needs an application entry file.');

const requireFromEntry = createRequire(entry);
const factoryPath = requireFromEntry.resolve('fastify');
if (requireFromEntry.cache[factoryPath]) throw new Error('The Fastify startup fixture must load before Fastify.');
const { version } = requireFromEntry('fastify/package.json');
if (version !== '5.12.1') throw new Error('The Fastify startup fixture needs Fastify 5.12.1.');

const fastify = requireFromEntry(factoryPath);
const factoryUrl = pathToFileURL(factoryPath).href;
const facadeUrl = new URL('./facade.mjs', import.meta.url).href;

export function createGuardedApp(...options) {
  return fastify(...options).register(patchstackFastify);
}
Object.assign(createGuardedApp, fastify);
createGuardedApp.fastify = createGuardedApp;
createGuardedApp.default = createGuardedApp;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (specifier !== 'fastify') return resolved;
    if (resolved.url !== factoryUrl) throw new Error('The Fastify startup fixture only covers one installed copy.');
    return { url: facadeUrl, format: 'module', shortCircuit: true };
  },
});
