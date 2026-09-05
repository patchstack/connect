import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  detectSiteName,
  nameFromHtmlTitle,
  nameFromPackageName,
  normaliseSiteName,
} from '../src/site-name.js';
import { resolveConfig, writeConfigFile } from '../src/config.js';

const VALID_UUID = '11111111-2222-4333-8444-555555555555';

describe('normaliseSiteName', () => {
  it('collapses whitespace and trims', () => {
    expect(normaliseSiteName('  ToDo \n  Application ')).toBe('ToDo Application');
  });

  it('is null for nothing', () => {
    expect(normaliseSiteName('')).toBeNull();
    expect(normaliseSiteName('   ')).toBeNull();
    expect(normaliseSiteName(undefined)).toBeNull();
  });

  it('caps at what the server stores', () => {
    expect(normaliseSiteName('x'.repeat(300))).toHaveLength(191);
  });
});

describe('nameFromHtmlTitle', () => {
  it('reads the static title and decodes entities', () => {
    const html = '<!doctype html><html><head><title>Arch &amp; Studio &#8211; Design</title></head></html>';
    expect(nameFromHtmlTitle(html)).toBe('Arch & Studio – Design');
  });

  it('ignores attributes on the tag and whitespace inside it', () => {
    expect(nameFromHtmlTitle('<title data-x="1">\n  My App\n</title>')).toBe('My App');
  });

  it('is null when the shell has no title, or an empty one', () => {
    expect(nameFromHtmlTitle('<html><head></head></html>')).toBeNull();
    expect(nameFromHtmlTitle('<title></title>')).toBeNull();
    expect(nameFromHtmlTitle('<title>   </title>')).toBeNull();
  });

  it('treats a template title as no title', () => {
    expect(nameFromHtmlTitle('<title>Vite + React + TS</title>')).toBeNull();
    expect(nameFromHtmlTitle('<title>Create Next App</title>')).toBeNull();
    expect(nameFromHtmlTitle('<title>DOCUMENT</title>')).toBeNull();
  });
});

describe('nameFromHtmlTitle: numeric entities it cannot represent', () => {
  it('leaves a code point outside Unicode as the text it was, instead of throwing', () => {
    // `<title>` is arbitrary text out of a file this package did not write, and `String.fromCodePoint`
    // throws on anything that is not a scalar value. resolveConfig is shared, so a throw here would take
    // down whichever command happened to resolve the config.
    for (const entity of ['&#9999999999;', '&#x110000;', '&#xFFFFFFFF;', '&#55296;', '&#xD800;']) {
      expect(nameFromHtmlTitle(`<title>Shop ${entity}</title>`)).toBe(`Shop ${entity}`);
    }
  });

  it('still decodes the ones that are characters', () => {
    expect(nameFromHtmlTitle('<title>Caf&#233; &#x1F600; &amp; Bar</title>')).toBe('Café 😀 & Bar');
  });
});

describe('nameFromPackageName', () => {
  it('humanises a package name', () => {
    expect(nameFromPackageName('my-todo-app')).toBe('My Todo App');
    expect(nameFromPackageName('recipe_box.v2')).toBe('Recipe Box V2');
  });

  it('drops the scope and keeps acronyms', () => {
    expect(nameFromPackageName('@acme/crm-dashboard')).toBe('Crm Dashboard');
    expect(nameFromPackageName('API-gateway')).toBe('API Gateway');
  });

  it('treats a template name as no name', () => {
    expect(nameFromPackageName('vite_react_shadcn_ts')).toBeNull();
    expect(nameFromPackageName('vite-react-typescript-starter')).toBeNull();
    expect(nameFromPackageName('my-app')).toBeNull();
    expect(nameFromPackageName('@scope/my-app')).toBeNull();
  });

  it('is null for anything that is not a usable string', () => {
    expect(nameFromPackageName(undefined)).toBeNull();
    expect(nameFromPackageName(42)).toBeNull();
    expect(nameFromPackageName('')).toBeNull();
    expect(nameFromPackageName('@scope/')).toBeNull();
  });
});

describe('detectSiteName', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'patchstack-connect-name-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('prefers the HTML shell over the package manifest', async () => {
    await writeFile(path.join(cwd, 'index.html'), '<title>ToDo Application</title>');
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'todo-app' }));

    expect(await detectSiteName(cwd)).toEqual({ name: 'ToDo Application', source: 'index.html' });
  });

  it('reads public/index.html when the root has no shell', async () => {
    await mkdir(path.join(cwd, 'public'));
    await writeFile(path.join(cwd, 'public', 'index.html'), '<title>Recipe Box</title>');

    expect(await detectSiteName(cwd)).toEqual({ name: 'Recipe Box', source: 'index.html' });
  });

  it('falls back to the package name when the shell title is a template default', async () => {
    await writeFile(path.join(cwd, 'index.html'), '<title>Vite + React + TS</title>');
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'recipe-box' }));

    expect(await detectSiteName(cwd)).toEqual({ name: 'Recipe Box', source: 'package.json' });
  });

  it('reports nothing for an unnamed template', async () => {
    await writeFile(path.join(cwd, 'index.html'), '<title></title>');
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'vite_react_shadcn_ts' }));

    expect(await detectSiteName(cwd)).toBeNull();
  });

  it('reports nothing for an empty directory or a broken package.json', async () => {
    expect(await detectSiteName(cwd)).toBeNull();

    await writeFile(path.join(cwd, 'package.json'), '{not json');
    expect(await detectSiteName(cwd)).toBeNull();
  });
});

describe('resolveConfig site name', () => {
  const originalEnv = { ...process.env };
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'patchstack-connect-name-cfg-'));
    delete process.env.PATCHSTACK_SITE_NAME;
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await rm(cwd, { recursive: true, force: true });
  });

  it('is null when the project states no name', async () => {
    await writeConfigFile(cwd, { siteUuid: VALID_UUID });
    expect((await resolveConfig({ cwd, detectSiteIdentity: true })).siteName).toBeNull();
  });

  it('reads an explicit name from the committed config over the project files', async () => {
    await writeConfigFile(cwd, { siteUuid: VALID_UUID, name: '  Owner Chosen ' });
    await writeFile(path.join(cwd, 'index.html'), '<title>Shell Title</title>');

    expect((await resolveConfig({ cwd, detectSiteIdentity: true })).siteName).toBe('Owner Chosen');
  });

  it('lets the environment variable override the committed config', async () => {
    await writeConfigFile(cwd, { siteUuid: VALID_UUID, name: 'From File' });
    process.env.PATCHSTACK_SITE_NAME = 'From Env';

    expect((await resolveConfig({ cwd, detectSiteIdentity: true })).siteName).toBe('From Env');
  });

  it('detects the name from the project files when nothing is configured', async () => {
    await writeConfigFile(cwd, { siteUuid: VALID_UUID });
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'recipe-box' }));

    expect((await resolveConfig({ cwd, detectSiteIdentity: true })).siteName).toBe('Recipe Box');
  });
});
