import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = path.join(root, 'claude-plugin');
const skills = readdirSync(path.join(pluginDir, 'skills'));
const skillText = (name: string) => readFileSync(path.join(pluginDir, 'skills', name, 'SKILL.md'), 'utf8');
const cli = readFileSync(path.join(root, 'src', 'cli.ts'), 'utf8');
const known = new Set([...cli.slice(cli.indexOf('const KNOWN_COMMANDS'), cli.indexOf(']);', cli.indexOf('const KNOWN_COMMANDS'))).matchAll(/'([a-z-]+)'/g)].map((match) => match[1]));

describe('the Claude Code plugin', () => {
  it('is the plugin the marketplace lists', () => {
    const marketplace = JSON.parse(readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
    const manifest = JSON.parse(readFileSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'));
    expect(marketplace.plugins).toEqual([expect.objectContaining({ name: manifest.name, source: './claude-plugin' })]);
  });

  it('holds skills only, so it runs nothing of its own', () => {
    expect(readdirSync(pluginDir).sort()).toEqual(['.claude-plugin', 'skills']);
    expect(skills.sort()).toEqual(['next', 'setup']);
  });

  it.each(skills)('%s names only commands the CLI has, and pre-approves only the CLI', (name) => {
    const text = skillText(name);
    const used = [...text.matchAll(/npx (?:--yes )?@patchstack\/connect ([a-z-]+)/g)].map((match) => match[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const command of used) expect(known, command).toContain(command);
    const allowed = text.slice(text.indexOf('allowed-tools:'), text.indexOf('---', 4)).split('\n').filter((line) => line.trim().startsWith('- '));
    expect(allowed.length).toBeGreaterThan(0);
    for (const line of allowed) expect(line).toMatch(/^\s+- Bash\(npx (?:--yes )?@patchstack\/connect \*\)$/);
  });

  it('tells Claude not to run the app, and to show the summary as written', () => {
    expect(skillText('setup')).toMatch(/Do not start, restart or stop the person's app/);
    expect(skillText('setup')).toContain('──── Summary ────');
  });
});
