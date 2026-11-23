// Builds a throwaway fixture project for a field-test run. Importable
// (makeFixture) or standalone (`node fixture.mjs <dir> [template]`).
//
// Templates:
// - lovable-bun (default): Vite + React + lovable-tagger, bun.lock marker with
//   populated node_modules and NO package-lock.json — the shape of a
//   bun-managed vibe-platform export. Exercises the node_modules-walk path.
// - vite-npm: same app, plain npm project with package-lock.json.
// - express-npm: an HTTP server with a static HTML shell and an existing build command.
// - static-html: a folder of pages with no package manager or server.
// - cdn-script: a page that loads its JavaScript from a CDN <script>, with no package manager.
// - eleventy-npm: a static site generator; JavaScript runs only in the build, the output is HTML.
// - flask: a Python web app with server-side templates and no JavaScript project.
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const PACKAGE_JSON = {
  name: 'vite_react_shadcn_ts',
  private: true,
  version: '0.0.0',
  type: 'module',
  scripts: {
    dev: 'vite',
    build: 'vite build',
    'build:dev': 'vite build --mode development',
    preview: 'vite preview',
  },
  dependencies: {
    react: '^18.3.1',
    'react-dom': '^18.3.1',
  },
  devDependencies: {
    '@vitejs/plugin-react-swc': '^3.9.0',
    'lovable-tagger': '^1.1.7',
    typescript: '^5.5.3',
    vite: '^5.4.1',
  },
};

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>recipe-glow</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;

const MAIN_TSX = `import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")!).render(<App />);
`;

const APP_TSX = `const App = () => <h1>Recipe Glow</h1>;

export default App;
`;

const VITE_CONFIG = `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import { componentTagger } from "lovable-tagger";

export default defineConfig(({ mode }) => ({
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
}));
`;

/**
 * What each template stands for and how a run against it is scored.
 * - appClass: the app class in the field-test app matrix (README, "App classes").
 * - shell: the file a widget tag belongs in, relative to the fixture.
 * - notApplicable: checks that cannot apply to this kind of app, reported as n/a and left out of the total.
 * - installExpected: whether a correct run installs the package. When false, a round that never unpacked
 *   it is still conclusive.
 */
export const TEMPLATE_INFO = {
  'lovable-bun': { appClass: 'C', label: 'React/Vite SPA, bun-managed', shell: 'index.html', notApplicable: [], installExpected: true },
  'vite-npm': { appClass: 'C', label: 'React/Vite SPA, npm', shell: 'index.html', notApplicable: [], installExpected: true },
  'express-npm': { appClass: 'F', label: 'Express server', shell: 'index.html', notApplicable: [], installExpected: true },
  'static-html': { appClass: 'A', label: 'static HTML, no JavaScript project', shell: 'index.html', notApplicable: ['devScriptsPreserved'], installExpected: true },
  'cdn-script': { appClass: 'B', label: 'browser JavaScript from a CDN, no package manager', shell: 'index.html', notApplicable: ['devScriptsPreserved'], installExpected: true },
  'eleventy-npm': { appClass: 'D', label: 'Eleventy, JavaScript only at build time', shell: '_includes/base.njk', notApplicable: [], installExpected: true },
  flask: {
    appClass: 'H', label: 'Python Flask app, not JavaScript', shell: 'templates/index.html', installExpected: false,
    notApplicable: ['installed', 'provisioned', 'provisionedOnce', 'hooksWired', 'dependencyScanWired', 'devScriptsPreserved',
      'widgetInstalled', 'widgetTokenMatches', 'protectionVerified', 'claimUrlSurfaced', 'summaryPassedOn'],
  },
};

export const TEMPLATES = Object.keys(TEMPLATE_INFO);

const NON_NODE_TEMPLATES = {
  'static-html': {
    'index.html': '<!doctype html>\n<html><head><title>Todo</title><link rel="stylesheet" href="style.css"></head><body><h1>Todo</h1><ul id="list"></ul></body></html>\n',
    'about.html': '<!doctype html>\n<html><head><title>About</title></head><body><h1>About</h1></body></html>\n',
    'style.css': 'body { font-family: sans-serif; }\n',
  },
  'cdn-script': {
    'index.html': '<!doctype html>\n<html><head><title>Todo</title></head><body><h1>Todo</h1><button id="add">Add</button>\n<script src="https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js"></script>\n<script src="app.js"></script></body></html>\n',
    'app.js': "document.getElementById('add').addEventListener('click', () => confetti());\n",
  },
  flask: {
    'app.py': 'from flask import Flask, render_template\n\napp = Flask(__name__)\n\n\n@app.route("/")\ndef index():\n    return render_template("index.html")\n',
    'requirements.txt': 'flask\n',
    'templates/index.html': '<!doctype html>\n<html><head><title>Todo</title></head><body><h1>Todo</h1></body></html>\n',
  },
};

export function makeFixture(dir, template = 'lovable-bun') {
  if (!TEMPLATES.includes(template)) {
    throw new Error(`Unknown template "${template}". Known: ${TEMPLATES.join(', ')}`);
  }

  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  if (NON_NODE_TEMPLATES[template]) {
    for (const [file, text] of Object.entries(NON_NODE_TEMPLATES[template])) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), text);
    }
    return dir;
  }

  if (template === 'eleventy-npm') {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'field-test-blog', private: true, version: '0.0.0',
      scripts: { build: 'eleventy', dev: 'eleventy --serve' },
      devDependencies: { '@11ty/eleventy': '^3.0.0' },
    }, null, 2) + '\n');
    mkdirSync(path.join(dir, '_includes'));
    writeFileSync(path.join(dir, '_includes', 'base.njk'), '<!doctype html>\n<html><head><title>{{ title }}</title></head><body>\n{{ content | safe }}\n</body></html>\n');
    writeFileSync(path.join(dir, 'index.md'), '---\nlayout: base.njk\ntitle: Recipe Glow\n---\n# Recipe Glow\n');
    execSync('npm install --no-audit --no-fund', { cwd: dir, stdio: 'pipe' });
    return dir;
  }

  mkdirSync(path.join(dir, 'src'), { recursive: true });

  const pkg = template === 'express-npm' ? {
    name: 'field-test-server', private: true, version: '0.0.0', type: 'module', main: 'server.js',
    scripts: { start: 'node server.js', dev: 'node --watch server.js', build: 'node --check server.js' },
    dependencies: { express: '^4.21.2' },
  } : structuredClone(PACKAGE_JSON);
  if (template === 'vite-npm') {
    delete pkg.devDependencies['lovable-tagger'];
  }
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  if (template === 'express-npm') {
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><title>Recipe Glow</title></head><body><h1>Recipe Glow</h1></body></html>\n');
    writeFileSync(path.join(dir, 'server.js'), `import express from 'express';

const app = express();
app.use(express.json());
app.get('/', (_request, response) => response.sendFile('index.html', { root: process.cwd() }));
app.get('/api/health', (_request, response) => response.json({ ok: true }));
app.listen(process.env.PORT || 3000);
`);
  } else {
    writeFileSync(path.join(dir, 'index.html'), INDEX_HTML);
    writeFileSync(path.join(dir, 'src', 'main.tsx'), MAIN_TSX);
    writeFileSync(path.join(dir, 'src', 'App.tsx'), APP_TSX);
    writeFileSync(
      path.join(dir, 'vite.config.ts'),
      template === 'lovable-bun'
        ? VITE_CONFIG
        : VITE_CONFIG.replace(/import { componentTagger }.*\n/, '').replace(
            /, mode === "development" && componentTagger\(\)/,
            '',
          ),
    );
  }

  execSync('npm install --no-audit --no-fund', { cwd: dir, stdio: 'pipe' });

  if (template === 'lovable-bun') {
    rmSync(path.join(dir, 'package-lock.json'), { force: true });
    writeFileSync(path.join(dir, 'bun.lock'), '');
  }

  return dir;
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (invokedDirectly) {
  const [dir, template] = process.argv.slice(2);
  if (!dir) {
    console.error(`Usage: node fixture.mjs <dir> [${TEMPLATES.join('|')}]`);
    process.exit(1);
  }
  makeFixture(path.resolve(dir), template ?? 'lovable-bun');
  console.log(`fixture ready at ${path.resolve(dir)}`);
}
