import * as nodeModule from 'node:module';
import { pathToFileURL } from 'node:url';
import { patchstackFastify } from '../protect/templates/fastify-plugin.js';

export function installFastifyHook(protection) {
  if (typeof nodeModule.registerHooks !== 'function' || !process.features.require_module) {
    throw new Error('The Patchstack Fastify preload needs Node module hooks and require(esm).');
  }
  const entry = process.argv[1];
  if (!entry) throw new Error('The Patchstack Fastify preload needs an application entry file.');

  const requireFromEntry = nodeModule.createRequire(entry);
  const factoryPath = requireFromEntry.resolve('fastify');
  if (requireFromEntry.cache[factoryPath]) {
    throw new Error('The Patchstack Fastify preload must run before Fastify is loaded.');
  }
  const { version } = requireFromEntry('fastify/package.json');
  if (version !== '5.12.1') throw new Error('The Patchstack Fastify pilot supports Fastify 5.12.1.');

  const factory = requireFromEntry(factoryPath);
  guardedFactory = Object.assign(
    (...options) => factory(...options).register(patchstackFastify, { protection }),
    factory,
  );
  guardedFactory.fastify = guardedFactory;
  guardedFactory.default = guardedFactory;

  const factoryUrl = pathToFileURL(factoryPath).href;
  const facadeUrl = new URL('./fastify-facade.mjs', import.meta.url).href;
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      if (specifier !== 'fastify') return resolved;
      if (resolved.url !== factoryUrl) {
        throw new Error('The Patchstack Fastify pilot supports one installed Fastify copy per app.');
      }
      return { url: facadeUrl, format: 'module', shortCircuit: true };
    },
  });
}

export let guardedFactory;
