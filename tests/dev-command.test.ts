import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({spawn:vi.fn(), stop:vi.fn(), start:vi.fn()}));
vi.mock('node:child_process', () => ({spawn:mocks.spawn}));
vi.mock('../src/development-sync.js', () => ({startDevelopmentSync:mocks.start}));
import { runDevelopment } from '../src/dev-command.js';

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

it('passes literal arguments, scopes dev mode to the child, forwards signals and returns its exit code', async () => {
  vi.spyOn(console,'error').mockImplementation(()=>{});
  const child = Object.assign(new EventEmitter(), {kill:vi.fn()});
  mocks.spawn.mockReturnValue(child); mocks.start.mockReturnValue({stop:mocks.stop});
  const before = process.listenerCount('SIGTERM');
  const envBefore = process.env.PATCHSTACK_DEV_SYNC;
  const result = runDevelopment(['vite','--host','--help','literal;not-a-shell'],'.');
  expect(mocks.spawn).toHaveBeenCalledWith('vite',['--host','--help','literal;not-a-shell'],expect.objectContaining({shell:false,env:expect.objectContaining({PATCHSTACK_DEV_SYNC:'1'})}));
  expect(process.env.PATCHSTACK_DEV_SYNC).toBe(envBefore);
  process.emit('SIGTERM'); expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  child.emit('exit',42,null);
  expect(await result).toBe(42);
  expect(mocks.stop).toHaveBeenCalledOnce();
  expect(process.listenerCount('SIGTERM')).toBe(before);
});

it('cleans up a command that cannot start', async () => {
  vi.spyOn(console,'error').mockImplementation(()=>{});
  const child = Object.assign(new EventEmitter(), {kill:vi.fn()});
  mocks.spawn.mockReturnValue(child); mocks.start.mockReturnValue({stop:mocks.stop});
  const result = runDevelopment(['missing-command'],'.');
  child.emit('error',new Error('not found'));
  expect(await result).toBe(1); expect(mocks.stop).toHaveBeenCalledOnce();
});

it('does not start a watcher or process without an explicit command', async () => {
  vi.spyOn(console,'error').mockImplementation(()=>{});
  expect(await runDevelopment([])).toBe(1);
  expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.spawn).not.toHaveBeenCalled();
});
