import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderDoctor, runDoctorChecks, type DoctorFinding } from '../src/doctor.js';
import { collectGuideState } from '../src/guide.js';
import { runProtect } from '../src/protect/install/index.js';
import type { ClaimPreview } from '../src/client.js';
import type { Config } from '../src/types.js';

const UUID = '556d8930-ae4d-4bf2-bee8-3bc53c096876';
const READER = `rr_${'a'.repeat(48)}-4242`;
const dirs: string[] = [];
afterEach(() => {
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  vi.restoreAllMocks();
});

function config(overrides: Partial<Config> = {}): Config {
  return {
    siteUuid: UUID,
    apiKey: null,
    pulseAuth: null,
    endpoint: 'https://api.patchstack.com/monitor/pulse/manifest',
    timeoutMs: 5_000,
    environment: 'production',
    widget: false,
    ...overrides,
  } as Config;
}

/** A plain Node server with the generic guard wired the way the guide says, rules file stamped as setup leaves it. */
function project(patchstack: Record<string, unknown> | null = { rules_reader: READER, build_id: 'b'.repeat(64) }): string {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const cwd = mkdtempSync(join(tmpdir(), 'ps-doctor-'));
  dirs.push(cwd);
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({
    name: 'doctor-fixture', type: 'module',
    scripts: { start: 'node server.js', postinstall: 'patchstack-connect scan' },
    dependencies: { '@patchstack/connect': '^0.5.68' },
  }));
  writeFileSync(join(cwd, '.patchstackrc.json'), JSON.stringify({ siteUuid: UUID, widget: false, claimed: true }));
  writeFileSync(join(cwd, 'server.js'), "import http from 'node:http';\nimport { patchstackMiddleware } from './patchstack/guard.js';\nconst handler = (req, res) => res.end('ok');\nhttp.createServer((req, res) => patchstackMiddleware(req, res, () => handler(req, res))).listen(3000);\n");
  runProtect(cwd);
  if (patchstack !== null) {
    const rules = JSON.parse(readFileSync(join(cwd, 'patchstack/rules.json'), 'utf8'));
    writeFileSync(join(cwd, 'patchstack/rules.json'), JSON.stringify({ ...rules, _patchstack: patchstack }));
  }
  return cwd;
}

/** Patchstack's token endpoint answering `status`, and a live app answering the page and the test attack. */
function network({ token = 200, page = 200, attack = 403 }: { token?: number | 'down'; page?: number; attack?: number } = {}) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/token')) {
      if (token === 'down') throw new Error('offline');
      return new Response('{}', { status: token });
    }
    if (url.includes('file=')) return new Response(attack === 403 ? '{"error":"This request has been blocked by Patchstack."}' : '<html></html>', { status: attack });
    return new Response(`<html><script src="https://cdn.patchstack.com/patchstack-widget.js" data-site-uuid="${UUID}"></script></html>`, { status: page });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const claimed = async (): Promise<ClaimPreview> => ({ state: 'claimed', summary: null });
async function doctor(cwd: string, options: { url?: string; claimPreview?: () => Promise<ClaimPreview>; net?: ReturnType<typeof network>; config?: Partial<Config> } = {}) {
  const net = options.net ?? network();
  const state = await collectGuideState(cwd);
  return runDoctorChecks(cwd, state, config(options.config), { url: options.url ?? null, fetchImpl: net.fetchImpl, claimPreview: options.claimPreview ?? claimed });
}
const problems = (findings: DoctorFinding[]) => findings.filter((f) => f.status === 'problem').map((f) => f.text);

describe('doctor', () => {
  it('finds no problem in a project set up the way setup leaves it', async () => {
    const findings = await doctor(project());
    expect(problems(findings)).toEqual([]);
    expect(findings.map((f) => f.text)).toContain('The read-only rules credential works: the published app can fetch rule updates and report attacks');
    expect(renderDoctor(findings).join('\n')).toContain('No problems found.');
  });

  it('says what to run when the project is not on Patchstack', async () => {
    const cwd = project();
    rmSync(join(cwd, '.patchstackrc.json'));
    expect(await doctor(cwd, { config: { siteUuid: null } as never })).toEqual([
      { status: 'problem', text: 'This project is not on Patchstack yet', fix: ['Run: npx @patchstack/connect setup'] },
    ]);
  });

  it('flags a site with no owner as report-only, with the link to connect it', async () => {
    const cwd = project();
    writeFileSync(join(cwd, '.patchstackrc.json'), JSON.stringify({ siteUuid: UUID, widget: false }));
    const findings = await doctor(cwd, { claimPreview: async () => ({ state: 'unclaimed', summary: null }) });
    const finding = findings.find((f) => f.text.startsWith('Not connected'));
    expect(finding?.status).toBe('problem');
    expect(finding?.fix?.[0]).toContain(`claim?site=${UUID}`);
    expect(findings.filter((f) => /connected/i.test(f.text))).toHaveLength(1);
  });

  it('flags a rules file without the read-only credential, and one Patchstack refuses', async () => {
    expect(problems(await doctor(project({ build_id: 'b'.repeat(64) })))).toEqual([
      "The guard's rules file has no read-only rules credential, so the published app cannot fetch rule updates or report attacks without the site key",
    ]);
    expect(problems(await doctor(project(), { net: network({ token: 401 }) }))).toEqual([
      'Patchstack refused the read-only rules credential (the site key was replaced, or the site was removed)',
    ]);
    const offline = await doctor(project(), { net: network({ token: 'down' }) });
    expect(problems(offline)).toEqual([]);
    expect(offline.find((f) => f.status === 'unknown')?.text).toBe('Could not reach Patchstack to check the read-only rules credential');
  });

  it('flags a map that is not linked to the guard', async () => {
    expect(problems(await doctor(project({ rules_reader: READER })))).toEqual([
      "The app's map is not linked to the guard, so rules written for this app's own inputs can only report, not block",
    ]);
  });

  it('flags a guard that is not wired', async () => {
    const cwd = project();
    writeFileSync(join(cwd, 'server.js'), "import http from 'node:http';\nhttp.createServer((req, res) => res.end('ok')).listen(3000);\n");
    expect(problems(await doctor(cwd))).toEqual(['Blocking attacks needs a server']);
  });

  describe('with --url', () => {
    it('passes a live app that carries the widget and blocks the test attack', async () => {
      const cwd = project();
      writeFileSync(join(cwd, '.patchstackrc.json'), JSON.stringify({ siteUuid: UUID, widget: true, claimed: true }));
      const findings = await doctor(cwd, { url: 'https://app.example' });
      expect(findings.filter((f) => f.text.startsWith('The live app')).map((f) => [f.status, f.text])).toEqual([
        ['ok', 'The live app carries the Patchstack widget for this site'],
        ['ok', "The live app's guard blocked a test attack"],
      ]);
    });

    it('flags a live app that lets the test attack through', async () => {
      const findings = await doctor(project(), { url: 'https://app.example', net: network({ attack: 200 }) });
      expect(problems(findings)).toEqual(['The live app let a test attack through (it answered 200 to ?file=../../../../etc/passwd)']);
    });

    it('sends no test attack to a page that does not load', async () => {
      const net = network({ page: 404 });
      const findings = await doctor(project(), { url: 'https://app.example', net });
      expect(findings.find((f) => f.text.startsWith('The live app'))?.status).toBe('unknown');
      expect(net.calls.some((url) => url.includes('file='))).toBe(false);
    });
  });

  it('ends by telling whoever runs it to fix each problem and run it again', () => {
    const lines = renderDoctor([{ status: 'problem', text: 'x', fix: ['Run: a', 'Then: b'] }], { url: 'https://app.example' }).join('\n');
    expect(lines).toContain('  ✗ x\n      Fix: Run: a\n           Then: b');
    expect(lines).toContain('1 problem to fix in the project. Fix each ✗ above as its Fix line says, then run npx @patchstack/connect doctor again until none is left.');
  });

  it('keeps the owner\'s steps apart from what the project needs, so an assistant does not wait on them', () => {
    const lines = renderDoctor([{ status: 'problem', text: 'Not connected', fix: ['Open the link'], owner: true }]).join('\n');
    expect(lines).toContain('✗ Not connected (for the app owner)');
    expect(lines).not.toContain('to fix in the project');
    expect(lines).toContain('1 step for the app owner');
  });
});
