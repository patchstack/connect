import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildInputMap } from '../../src/map/index.js';
import { componentScript } from '../../src/map/sources.js';

/**
 * Single-file components import packages like any other module, and some of that code runs on the
 * server. The import inventory must see those imports, or report that it could not; an inventory that
 * never looked at them cannot claim to be complete.
 */
async function mapOf(files: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ps-components-'));
  try {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { 'sample-lib': '1', 'other-lib': '1' } }));
    for (const [file, source] of Object.entries(files)) {
      mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
      writeFileSync(path.join(dir, file), source);
    }
    const { map } = await buildInputMap(dir, {});

    return map!;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const packages = (map: any): string[] => map.imports.map((i: any) => i.package).sort();
const site = (map: any, pkg: string) => map.imports.find((i: any) => i.package === pkg)?.sites?.[0];

describe('single-file components in the import inventory', () => {
  it.each([
    ['src/components/Panel.vue', '<template><div /></template>\n<script setup lang="ts">\nimport { format } from \'sample-lib\';\n</script>\n'],
    ['src/components/Panel.svelte', '<script context="module">\nimport { format } from \'sample-lib\';\n</script>\n<div />\n'],
    ['src/pages/panel.astro', "---\nimport { format } from 'sample-lib';\nconst value = format(Astro.url);\n---\n<div>{value}</div>\n"],
  ])('records the imports of %s and stays complete', async (file, source) => {
    const map = await mapOf({ [file]: source });

    expect(packages(map)).toEqual(['sample-lib']);
    expect(map.coverage.importsComplete).toBe(true);
  });

  it('reads every script block of a component', async () => {
    const map = await mapOf({
      'src/App.vue': "<script>\nimport a from 'sample-lib';\n</script>\n<script setup>\nimport b from 'other-lib';\n</script>\n",
    });

    expect(packages(map)).toEqual(['other-lib', 'sample-lib']);
  });

  it('reports lines in the component file', async () => {
    const map = await mapOf({ 'src/App.vue': "<template>\n  <div />\n</template>\n<script>\nimport a from 'sample-lib';\n</script>\n" });

    expect(site(map, 'sample-lib')).toMatchObject({ file: path.join('src', 'App.vue'), line: 5 });
  });

  it('does not read imports written outside a script block', async () => {
    const map = await mapOf({ 'src/App.vue': "<template>\n  <p>import x from 'sample-lib'</p>\n</template>\n<script>\nexport default {};\n</script>\n" });

    expect(packages(map)).toEqual([]);
  });

  it('marks the inventory incomplete when a component script cannot be delimited', async () => {
    const map = await mapOf({ 'src/App.vue': "<script>\nimport a from 'sample-lib';\n" });

    expect(map.coverage.importsComplete).toBe(false);
    expect(map.coverage.importCoverageGaps.unscannableFiles).toBe(1);
  });

  it('marks the inventory incomplete for unterminated Astro frontmatter', async () => {
    const map = await mapOf({ 'src/pages/x.astro': "---\nimport a from 'sample-lib';\n<div />\n" });

    expect(map.coverage.importsComplete).toBe(false);
  });

  it('counts a computed import in a component script against completeness', async () => {
    const map = await mapOf({ 'src/App.svelte': '<script>\nconst mod = await import(name);\n</script>\n' });

    expect(map.coverage.importCoverageGaps.unresolvableImports).toBe(1);
    expect(map.coverage.importsComplete).toBe(false);
  });

  it('notes that components are scanned for imports only', async () => {
    const map = await mapOf({ 'src/App.vue': "<script>\nimport a from 'sample-lib';\n</script>\n" });

    expect(map.coverage.notes.join(' ')).toMatch(/1 single-file component\(s\).*imports only/);
  });

  it('treats a skipped directory holding only components as holding source', async () => {
    const map = await mapOf({ 'vendor/widgets/Panel.vue': "<script>\nimport a from 'sample-lib';\n</script>\n" });

    expect(map.coverage.importsComplete).toBe(false);
    expect(map.coverage.importCoverageGaps.skippedDirsWithSource).toEqual(['vendor']);
  });
});

describe('component script extraction', () => {
  it('keeps offsets aligned with the original file', () => {
    const text = '<template>x</template>\n<script>\nimport a from "sample-lib";\n</script>\n';
    const script = componentScript(text, 'App.vue')!;

    expect(script).toHaveLength(text.length);
    expect(script.indexOf('import a')).toBe(text.indexOf('import a'));
    expect(script).not.toContain('template');
  });

  it('keeps empty Astro frontmatter readable', () => {
    expect(componentScript('---\n---\n<div />\n', 'x.astro')).not.toBeNull();
  });
});
