import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { read, log, templatesDir } from './util.js';
import { writeProjectFileSync } from '../../safe-file.js';

// Fingerprints of public generated helpers. Only the baked site identity is excluded.
const PREVIOUS: Record<string, string> = {
  'generic-guard.ts': '2c6bb8324b909e646049c36725704b474a8bfb1b6849c392eb3462eed83727e9',
  'generic-guard.js': '42357bcf0cb0541e584821d03e06ced28f98d4ef91a76a50e39008ef18c63709',
  'generic-guard.cjs': '8de21893474a3139eff9e8fc48a0c13e976e64421281db9e8e93b0c0549361b8',
  'express-guard.ts': '6c30cc82b7cbd3fee62d423fcb20b27eba1d6cc1ed054efcf9d64eb360bc7b17',
  'express-guard.js': 'bce7c76a061297621791d4ebf838449e3880d05f333588fed7bf88431d1e712e',
  'express-guard.cjs': '3a6430f00fc159c28a897e700cc492c306f39b556f0f4cb4b1e718993b6c40b4',
  'fastify-plugin.ts': '5d606cb8f8f2e6fe35b9d377c5568c5a2090a81af9f0acb219ebc15a713792e9',
  'fastify-plugin.js': '03327d437513571d53554ca34c84ba170ebeebb5e89c2602ae340fb82178ab48',
  'fastify-plugin.cjs': 'b3754bf023ebb5f2a22e0a95cfe74bb783034ec3db9ce61a3e7202237e09e1dd',
  'guard.ts': '270e29769f5a7b3ab70ee39970be5a4e150e1b3949877687dca1ed83596afae7',
  'sveltekit-hooks.ts': '0a68389ac9018dc0ab5805356ad78301f039cb4c701bf642e7f986cc959da990',
  'astro-middleware.ts': 'f217e302fb7019de451c7538e9266a5ce38aa6a6651072b6291d4593b31f60ce',
  'nuxt-middleware.ts': 'e377c48cc8c08d20c61c6119bb5f4c8991f0eed3ebd31310b8a0fc6eb5505e4e',
  'next-middleware.ts': '65c163cdb2ddda4fe53c1a3cd20aa6ab63ad7595a66985d9141d595374ecfab3',
  'next-guard.ts': 'e37c4d67619df9d850a7d94b567bd76841b6ac8e774a5b442689482f5374c451',
};
const identity = /const PS_SITE_UUID = "([^"]*)";/;
const normalized = (source: string) => source.replace(identity, 'const PS_SITE_UUID = "__PATCHSTACK_SITE_UUID__";');

/** Install a missing helper or upgrade a known unmodified one, retaining its baked site UUID. */
export function installTemplate(cwd: string, file: string, template: string): boolean {
  const next = read(join(templatesDir(), template));
  const target = join(cwd, file);
  if (!existsSync(target)) {
    writeProjectFileSync(cwd, target, next);
    return true;
  }
  const previous = read(target);
  if (normalized(previous) === normalized(next)) return false;
  if (createHash('sha256').update(normalized(previous)).digest('hex') !== PREVIOUS[template]) {
    log(`${file} is customized or unrecognized — preserved; review its request/response wiring and rule-refresh settings manually.`);
    return false;
  }
  const site = identity.exec(previous)?.[1];
  writeProjectFileSync(cwd, target, site ? next.replace(identity, () => `const PS_SITE_UUID = ${JSON.stringify(site)};`) : next);
  log(`updated unchanged generated helper ${file}`);
  return true;
}
