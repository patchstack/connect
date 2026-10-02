import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { wireBuildScripts } from '../src/setup.js';
import { isPreBundleBuildHook } from '../src/build-hook.js';
import type { PackageManager } from '../src/guide.js';

const manager = (process.env.PATCHSTACK_TEST_MANAGER ?? 'npm') as PackageManager;
if (!['npm','yarn','pnpm','bun'].includes(manager)) throw new Error('Unknown test package manager');
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, {recursive:true,force:true})));

describe('setup hooks under the real package manager', () => {
  it('executes scan, map, build and mark in order on every build', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ps-build-hooks-'));
    dirs.push(cwd);
    const cli = '#!/usr/bin/env node\n' +
      'require("node:fs").appendFileSync("events.jsonl", JSON.stringify(process.argv.slice(2)) + "\\n");\n' +
      'require("node:fs").appendFileSync("lifecycle.jsonl", JSON.stringify({npm_lifecycle_event:process.env.npm_lifecycle_event,npm_lifecycle_script:process.env.npm_lifecycle_script,npm_package_json:process.env.npm_package_json}) + "\\n");\n';
    mkdirSync(join(cwd,'fake-cli'));
    writeFileSync(join(cwd,'fake-cli/package.json'), JSON.stringify({name:'synthetic-connect-cli',version:'1.0.0',bin:{'patchstack-connect':'cli.cjs'}}));
    writeFileSync(join(cwd,'fake-cli/cli.cjs'),cli,{mode:0o755});
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({name:'synthetic-build',private:true,dependencies:{'synthetic-connect-cli':'file:./fake-cli'},scripts:{build:'node build.cjs'}}));
    if (manager === 'yarn') {
      writeFileSync(join(cwd,'yarn.lock'),'');
      writeFileSync(join(cwd,'.yarnrc.yml'),'nodeLinker: node-modules\n');
      const version = spawnSync(manager,['--version'],{encoding:'utf8'}).stdout?.trim() ?? '';
      if (!version.startsWith('1.')) {
        // This new local-only fixture needs its initial lockfile, including on CI.
        const installed = spawnSync(manager,['install','--mode=skip-build'],{cwd,encoding:'utf8',env:{
          ...process.env,CI:'true',YARN_ENABLE_NETWORK:'0',YARN_ENABLE_IMMUTABLE_INSTALLS:'false',
        }});
        expect(installed.status).toBe(0);
      }
    }
    const bin = join(cwd,'node_modules/.bin');
    mkdirSync(bin,{recursive:true});
    if (!existsSync(join(bin,'patchstack-connect'))) {
      writeFileSync(join(bin,'patchstack-connect'),cli,{mode:0o755});
      writeFileSync(join(bin,'patchstack-connect.cmd'), '@node "%~dp0patchstack-connect" %*\r\n');
    }
    writeFileSync(join(cwd,'build.cjs'), 'require("node:fs").appendFileSync("events.jsonl", "[\\"build\\"]\\n"); if(process.env.SYNTHETIC_BUILD_FAIL) process.exit(2);');
    wireBuildScripts(cwd,manager);
    expect(wireBuildScripts(cwd,manager).changed).toBe(false);
    const build = (fail = false) => spawnSync(manager,['run','build'],{
      cwd,encoding:'utf8',shell:process.platform === 'win32',env:{...process.env,SYNTHETIC_BUILD_FAIL:fail ? '1' : ''},
    });
    expect(build().status).toBe(0);
    expect(build().status).toBe(0);
    const events = () => readFileSync(join(cwd,'events.jsonl'),'utf8').trim().split('\n').map(line => JSON.parse(line));
    const sequence = [['scan'],['map','--upload'],['build'],['mark-build']];
    expect(events()).toEqual([...sequence,...sequence]);
    const lifecycle = readFileSync(join(cwd,'lifecycle.jsonl'),'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(lifecycle.filter((_, index) => index % 3 !== 2).map(env => isPreBundleBuildHook(env,cwd))).toEqual([true,true,true,true]);
    expect(build(true).status).not.toBe(0);
    expect(events()).toEqual([...sequence,...sequence,...sequence.slice(0,3)]);
  }, 30_000);
});
