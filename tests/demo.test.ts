import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertDemoDependency,
  assertPersistedSiteUuid,
  DemoError,
  NODE_SERIALIZE_DEMO,
  renderDemoTestCommands,
  resolveDemoScenario,
  waitForDemoRule,
} from '../src/demo.js';

const UUID = '550e8400-e29b-41d4-a716-446655440000';

describe('demo scenarios', () => {
  it('resolves the supported node-serialize scenario', () => {
    expect(resolveDemoScenario('node-serialize')).toBe(NODE_SERIALIZE_DEMO);
  });

  it('rejects missing and unknown scenarios with the available name', () => {
    expect(() => resolveDemoScenario(undefined)).toThrow(/node-serialize/);
    expect(() => resolveDemoScenario('other')).toThrow(/node-serialize/);
  });
});

describe('assertPersistedSiteUuid', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'patchstack-demo-site-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('accepts the Host-created UUID in .patchstackrc.json', async () => {
    await writeFile(path.join(cwd, '.patchstackrc.json'), JSON.stringify({ siteUuid: UUID }));
    await expect(assertPersistedSiteUuid(cwd, UUID)).resolves.toBeUndefined();
  });

  it('rejects missing and overridden site configuration', async () => {
    await expect(assertPersistedSiteUuid(cwd, UUID)).rejects.toThrow(
      /Connect Patchstack in Bolt first/,
    );
    await writeFile(
      path.join(cwd, '.patchstackrc.json'),
      JSON.stringify({ siteUuid: '11111111-1111-1111-1111-111111111111' }),
    );
    await expect(assertPersistedSiteUuid(cwd, UUID)).rejects.toThrow(/does not match/);
  });
});

describe('assertDemoDependency', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'patchstack-demo-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  async function writeProject(version?: string) {
    const dependencies = version ? { 'node-serialize': version } : { express: '4.21.2' };
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ dependencies }));
    const packages: Record<string, object> = { '': { dependencies } };
    if (version) packages['node_modules/node-serialize'] = { version };
    else packages['node_modules/express'] = { version: '4.21.2' };
    await writeFile(
      path.join(cwd, 'package-lock.json'),
      JSON.stringify({ name: 'demo', lockfileVersion: 3, packages }),
    );
  }

  it('accepts the exact vulnerable version in the lockfile', async () => {
    await writeProject('0.0.4');
    await expect(assertDemoDependency(cwd, NODE_SERIALIZE_DEMO)).resolves.toBeUndefined();
  });

  it('does not install the package and prints the explicit prerequisite', async () => {
    await writeProject();
    await expect(assertDemoDependency(cwd, NODE_SERIALIZE_DEMO)).rejects.toThrow(
      /npm install --save-exact node-serialize@0\.0\.4/,
    );
  });

  it('rejects a different installed version', async () => {
    await writeProject('0.0.3');
    await expect(assertDemoDependency(cwd, NODE_SERIALIZE_DEMO)).rejects.toThrow(/Found: 0\.0\.3/);
  });
});

describe('waitForDemoRule', () => {
  it('polls until production rule 18843 is served', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ firewall: [] })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ firewall: [{ id: 18843, title: 'Block node-serialize Vulnerability' }] })),
      );
    let now = 0;

    const rule = await waitForDemoRule(
      'https://api.patchstack.com/monitor/pulse/manifest',
      UUID,
      NODE_SERIALIZE_DEMO,
      {
        timeoutMs: 5_000,
        pollIntervalMs: 100,
        fetchFn,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    );

    expect(rule.id).toBe(18843);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      `https://api.patchstack.com/monitor/pulse/rules/${UUID}`,
    );
  });

  it('times out with the last observed rule state', async () => {
    const fetchFn = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ firewall: [{ id: 999 }] })),
    );
    let now = 0;

    await expect(
      waitForDemoRule('https://api.patchstack.com/monitor/pulse/manifest', UUID, NODE_SERIALIZE_DEMO, {
        timeoutMs: 200,
        pollIntervalMs: 100,
        fetchFn,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      }),
    ).rejects.toEqual(expect.objectContaining<Partial<DemoError>>({
      name: 'DemoError',
      message: expect.stringContaining('1 firewall rule(s) returned without rule 18843'),
    }));
  });
});

describe('renderDemoTestCommands', () => {
  it('prints a configurable endpoint and shell-safe base64 bodies', () => {
    const output = renderDemoTestCommands(
      "http://localhost:4000/api/tasks?name=it's",
      NODE_SERIALIZE_DEMO,
    );
    expect(output).toContain("'http://localhost:4000/api/tasks?name=it'\\''s'");
    expect(output).toContain('expect HTTP 403 and rule 18843');
    expect(output).toContain('expect HTTP 201');

    const encodedBodies = [...output.matchAll(/Buffer\.from\('([^']+)'/g)].map((match) => match[1]!);
    expect(encodedBodies.map((body) => JSON.parse(Buffer.from(body, 'base64').toString('utf8')))).toEqual([
      NODE_SERIALIZE_DEMO.maliciousBody,
      NODE_SERIALIZE_DEMO.benignBody,
    ]);
  });
});
