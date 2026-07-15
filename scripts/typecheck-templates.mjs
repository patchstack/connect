// Typecheck the scaffolded `src/protect/templates/*.ts` the way a target app's `tsc` would.
//
// WHY: templates are deliberately excluded from connect's own tsconfig (they import framework +
// JSON files that only exist AFTER scaffolding), so a template type bug ships silently — a broken
// install has slipped out this way before (a `string`-typed `mode`, a non-generic `screenResponse`
// return that a strict app's tsc then rejected). This assembles each template in a scratch dir with
// the pieces it expects — the REAL `@patchstack/connect/protect` declarations, a stub rules JSON,
// and loose shims for the framework type-only imports — then runs `tsc --noEmit`. It catches
// template-vs-protect-API drift (that class of bug). Framework types are shimmed, not installed, so
// it does NOT verify a handler matches its framework's exact hook signature — a possible follow-up.

import { mkdirSync, rmSync, copyFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const TEMPLATES = join(ROOT, 'src/protect/templates');
const OUT = join(ROOT, '.template-typecheck');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// Copy every .ts template into the scratch dir.
const templates = readdirSync(TEMPLATES).filter((f) => f.endsWith('.ts'));
for (const f of templates) copyFileSync(join(TEMPLATES, f), join(OUT, f));

// The JSON the templates import: the real starter rules (register-into-app templates import
// ./rules.json) + a stub for the seam templates' co-located ./patchstack.rules.json.
copyFileSync(join(TEMPLATES, 'rules.json'), join(OUT, 'rules.json'));
writeFileSync(join(OUT, 'patchstack.rules.json'), '[]\n');

// The real hand-authored declarations for @patchstack/connect/protect — this is what we check against.
copyFileSync(join(ROOT, 'src/protect/protect.d.ts'), join(OUT, 'protect-types.d.ts'));

// Loose shims for the framework type-only imports (we don't install the frameworks). Signatures
// mirror the real hooks closely enough to catch obvious wiring mistakes without full fidelity.
writeFileSync(
  join(OUT, 'shims.d.ts'),
  `declare module "astro" {
  export type MiddlewareHandler = (
    context: { request: Request },
    next: () => Promise<Response>,
  ) => Promise<Response> | Response;
}
declare module "@sveltejs/kit" {
  export type Handle = (input: {
    event: { request: Request };
    resolve: (event: unknown) => Promise<Response>;
  }) => Promise<Response> | Response;
}
`,
);

writeFileSync(
  join(OUT, 'tsconfig.json'),
  JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        lib: ['ES2022', 'DOM'],
        types: ['node'],
        strict: true,
        noUncheckedIndexedAccess: true,
        esModuleInterop: true,
        skipLibCheck: true,
        resolveJsonModule: true,
        isolatedModules: true,
        noEmit: true,
        baseUrl: '.',
        paths: { '@patchstack/connect/protect': ['./protect-types'] },
      },
      include: ['*.ts'],
    },
    null,
    2,
  ),
);

const tsc = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
try {
  execFileSync(tsc, ['--noEmit', '-p', join(OUT, 'tsconfig.json')], { stdio: 'inherit' });
  console.log(`template typecheck: OK (${templates.length} templates)`);
  rmSync(OUT, { recursive: true, force: true });
} catch {
  console.error(`\ntemplate typecheck FAILED — a scaffolded template would not compile in a user's app.`);
  console.error(`(scratch dir left at ${OUT} for inspection)`);
  process.exit(1);
}
