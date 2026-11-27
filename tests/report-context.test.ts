import { describe, expect, it } from 'vitest';

import { buildManifestBody } from '../src/client.js';
import { codingAgent, connectHeaders, reportTrigger } from '../src/report-context.js';
import type { Config } from '../src/types.js';

const config = {
  siteUuid: '550e8400-e29b-41d4-a716-446655440000',
  endpoint: 'https://example.com/monitor/pulse/manifest',
  timeoutMs: 30_000,
  environment: 'local',
} as unknown as Config;

const payload = { packages: [{ name: 'lodash', version: '4.17.21' }] } as Parameters<typeof buildManifestBody>[1];

describe('reportTrigger', () => {
  it.each(['preinstall', 'install', 'postinstall', 'prepare'])('reads %s as an install', (event) => {
    expect(reportTrigger({ npm_lifecycle_event: event })).toBe('install');
  });

  it.each(['prebuild', 'build', 'postbuild'])('reads %s as a build', (event) => {
    expect(reportTrigger({ npm_lifecycle_event: event })).toBe('build');
  });

  it('reads a direct run or any other script as other', () => {
    expect(reportTrigger({})).toBe('other');
    expect(reportTrigger({ npm_lifecycle_event: 'npx' })).toBe('other');
    expect(reportTrigger({ npm_lifecycle_event: 'dev' })).toBe('other');
  });
});

describe('buildManifestBody report context', () => {
  it('names the trigger', () => {
    expect(buildManifestBody(config, payload, { npm_lifecycle_event: 'postinstall' }).trigger).toBe('install');
    expect(buildManifestBody(config, payload, { npm_lifecycle_event: 'build' }).trigger).toBe('build');
  });

  it('always sends a trigger, even when nothing names one', () => {
    expect(buildManifestBody(config, payload, {}).trigger).toBe('other');
  });
});

describe('codingAgent', () => {
  it('names the agent from the variable it sets on the commands it runs', () => {
    expect(codingAgent({ CLAUDECODE: '1' })).toBe('claude');
    expect(codingAgent({ CODEX_THREAD_ID: 'thread' })).toBe('codex');
    expect(codingAgent({ CODEX_CI: '1' })).toBe('codex');
    expect(codingAgent({ CURSOR_AGENT: '1' })).toBe('cursor');
    expect(codingAgent({ GEMINI_CLI: '1' })).toBe('gemini');
  });

  it('reads Amp as Amp although it also sets the Claude Code marker', () => {
    expect(codingAgent({ AGENT: 'amp', CLAUDECODE: '1' })).toBe('amp');
  });

  it('reads Codex inside a Claude Code terminal as Codex, the agent that ran the command', () => {
    expect(codingAgent({ CLAUDECODE: '1', CODEX_CI: '1' })).toBe('codex');
  });

  it('names no agent for a person in a plain terminal or a switched-off marker', () => {
    expect(codingAgent({})).toBeNull();
    expect(codingAgent({ CLAUDECODE: '0', CURSOR_AGENT: '' })).toBeNull();
    expect(codingAgent({ CURSOR_TRACE_ID: 'trace' })).toBeNull();
  });

  it('sends the agent name, and only when one is recognised', () => {
    expect(connectHeaders({ CLAUDECODE: '1' })['X-Patchstack-Agent']).toBe('claude');
    expect(connectHeaders({})).not.toHaveProperty('X-Patchstack-Agent');
  });
});
