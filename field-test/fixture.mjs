// Builds a throwaway fixture project for a field-test run. Importable
// (makeFixture) or standalone (`node fixture.mjs <dir> [template]`).
//
// Templates:
// - lovable-bun (default): Vite + React + lovable-tagger, bun.lock marker with
//   populated node_modules and NO package-lock.json — the shape of a
//   bun-managed vibe-platform export. Exercises the node_modules-walk path.
// - vite-npm: same app, plain npm project with package-lock.json.
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

export const TEMPLATES = ['lovable-bun', 'vite-npm'];

export function makeFixture(dir, template = 'lovable-bun') {
  if (!TEMPLATES.includes(template)) {
    throw new Error(`Unknown template "${template}". Known: ${TEMPLATES.join(', ')}`);
  }

  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, 'src'), { recursive: true });

  const pkg = structuredClone(PACKAGE_JSON);
  if (template === 'vite-npm') {
    delete pkg.devDependencies['lovable-tagger'];
  }
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
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
    console.error('Usage: node fixture.mjs <dir> [lovable-bun|vite-npm]');
    process.exit(1);
  }
  makeFixture(path.resolve(dir), template ?? 'lovable-bun');
  console.log(`fixture ready at ${path.resolve(dir)}`);
}
