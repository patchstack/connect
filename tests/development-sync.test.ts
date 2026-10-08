import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { sourceSnapshot, startDevelopmentSync, type SyncAttempt } from '../src/development-sync.js';
import { wireDevelopmentScript } from '../src/setup.js';
import { createProtection, createServerFnGuard } from '../src/protect/runtime.js';

const directories: string[] = [];
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'ps-dev-sync-')); directories.push(dir); return dir; };
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); directories.splice(0).forEach(dir => rmSync(dir, {recursive:true,force:true})); });

it('debounces edits, serializes work, and does not acknowledge superseded results', async () => {
  vi.useFakeTimers();
  let source = 'one';
  let release!: (value: {ok:boolean;buildId:string}) => void;
  const sync = vi.fn((_attempt: SyncAttempt) => new Promise<{ok:boolean;buildId:string}>(resolve => { release = resolve; }));
  const coordinator = startDevelopmentSync('.', {snapshot:()=>source,sync,pollMs:10,debounceMs:20,minIntervalMs:100});
  await vi.advanceTimersByTimeAsync(10); source = 'two';
  await vi.advanceTimersByTimeAsync(20); expect(sync).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10); expect(sync).toHaveBeenCalledTimes(1);
  source = 'three';
  await vi.advanceTimersByTimeAsync(40); expect(sync).toHaveBeenCalledTimes(1);
  expect(sync.mock.calls[0]![0]?.current()).toBe(false);
  release({ok:true,buildId:'old'});
  await vi.advanceTimersByTimeAsync(100); expect(sync).toHaveBeenCalledTimes(2);
  expect(sync.mock.calls[1]![0]?.previousBuildId).toBeUndefined();
  coordinator.stop(); release({ok:true,buildId:'new'});
  await vi.advanceTimersByTimeAsync(1000); expect(sync).toHaveBeenCalledTimes(2);
});

it('retries offline work at a bounded rate and skips unchanged successful snapshots', async () => {
  vi.useFakeTimers();
  const sync = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ok:true,buildId:'a'.repeat(64)});
  const log = vi.fn();
  const coordinator = startDevelopmentSync('.', {snapshot:()=> 'stable',sync,log,pollMs:10,debounceMs:0,minIntervalMs:100});
  await vi.advanceTimersByTimeAsync(90); expect(sync).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(20); expect(sync).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(500); expect(sync).toHaveBeenCalledTimes(2);
  coordinator.stop(); expect(log).toHaveBeenCalledTimes(1);
});

it('ignores dependency trees, outputs, hidden files and symlinks but tracks source/config changes', () => {
  const cwd = root();
  writeFileSync(join(cwd,'server.ts'),'initial');
  const initial = sourceSnapshot(cwd);
  for (const name of ['node_modules','dist','.next','.patchstack']) {
    mkdirSync(join(cwd,name)); writeFileSync(join(cwd,name,'generated.ts'),'ignore');
  }
  writeFileSync(join(cwd,'.env'),'SYNTHETIC=not-read');
  writeFileSync(join(cwd,'patchstack.rules.json'),'{}');
  symlinkSync(root(),join(cwd,'linked'),'dir');
  expect(sourceSnapshot(cwd)).toBe(initial);
  writeFileSync(join(cwd,'server.ts'),'changed source');
  const changed = sourceSnapshot(cwd); expect(changed).not.toBe(initial);
  writeFileSync(join(cwd,'package-lock.json'),'{}');
  expect(sourceSnapshot(cwd)).not.toBe(changed);
});

it.each(['vite --host 0.0.0.0','next dev --port 3000','tsx watch src/server.ts','node --watch server.mjs','astro dev','nuxt dev','nodemon server.js'])('wires the explicitly opted-in single command: %s', dev => {
  const cwd = root();
  writeFileSync(join(cwd,'package.json'),JSON.stringify({scripts:{dev,build:'existing build'}}));
  expect(wireDevelopmentScript(cwd)).toEqual({wired:true,changed:true});
  expect(JSON.parse(readFileSync(join(cwd,'package.json'),'utf8')).scripts).toEqual({dev:`patchstack-connect dev -- ${dev}`,build:'existing build'});
  expect(wireDevelopmentScript(cwd)).toEqual({wired:true,changed:false});
});

it.each(['vite && publish','PORT=3000 next dev','concurrently vite server','vite "quoted argument"','vite; other','vite $(other)','vite > output','vite\nother'])('preserves opaque shell scripts: %s', dev => {
  const cwd = root(); const file = join(cwd,'package.json'); const original = JSON.stringify({scripts:{dev}});
  writeFileSync(file,original);
  expect(wireDevelopmentScript(cwd)).toEqual({wired:false,changed:false});
  expect(readFileSync(file,'utf8')).toBe(original);
});

it('holds only mapped enforcement during HMR, without letting a refresh promote it', async () => {
  vi.stubEnv('PATCHSTACK_DEV_SYNC','1');
  const build = 'a'.repeat(64);
  const rules = [
    {id:'mapped',build_scope:build,rule_v2:[{parameter:'post.mapped',match:{type:'contains',value:'synthetic'}}]},
    {id:'broad',rule_v2:[{parameter:'post.broad',match:{type:'contains',value:'synthetic'}}]},
  ];
  const protection = await createProtection({mode:'block',buildId:build,rules:{firewall:rules},cache:false,onError:()=>{}});
  try {
    const guard = createServerFnGuard({protection});
    expect(await guard({mapped:'synthetic'})).toBeNull();
    expect(await guard({broad:'synthetic'})).not.toBeNull();
    vi.stubEnv('PATCHSTACK_DEV_SYNC','');
    expect(await guard({mapped:'synthetic'})).not.toBeNull();
  } finally { await protection.stop(); }
});
