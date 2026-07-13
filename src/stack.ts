import type { WirePackage } from './normalize.js';

/**
 * A best-effort description of the stack a build was produced with, derived
 * entirely from the lockfile (ground truth) plus the build-time environment.
 *
 * The disclosure widget reads this from `window.__PATCHSTACK_STACK__` (injected
 * by `mark-build`) and reports it to Patchstack, so we learn how the sites we
 * protect are actually built and hosted — across every "vibe" platform — without
 * shipping a runtime probe onto the host server. Every field is a coarse label
 * or a bare key *name*: no versions beyond the framework, and never an env value.
 */
export interface StackDescriptor {
  /** App / meta-framework, e.g. "next", "nuxt", "tanstack-start", "remix". */
  framework: string | null;
  /** UI runtime, e.g. "react", "vue", "svelte", "solid". */
  ui: string | null;
  /** Build tool / bundler, e.g. "vite", "webpack", "rspack". */
  bundler: string | null;
  /** Deployment-runtime hint from deps, e.g. "cloudflare-workers", "vercel". */
  runtime: string | null;
  /** The vibe/builder platform that generated the project, e.g. "lovable". */
  builder: string | null;
  /** Package ecosystem the manifest came from. */
  ecosystem: 'npm';
  /** Hosting-related build-environment variable NAMES (never their values). */
  hostingEnvKeys: string[];
}

type Category = 'framework' | 'ui' | 'bundler' | 'runtime' | 'builder';

interface StackRule {
  category: Category;
  /** Exact package name that signals this label. */
  pkg: string;
  label: string;
}

/**
 * Package → stack-label registry. First match per category wins, so order
 * within a category is priority order (most specific first). Add a row to teach
 * the connector a new framework, bundler, or vibe platform.
 */
const STACK_RULES: readonly StackRule[] = [
  // Meta-frameworks (most specific first).
  { category: 'framework', pkg: '@tanstack/react-start', label: 'tanstack-start' },
  { category: 'framework', pkg: '@tanstack/start', label: 'tanstack-start' },
  { category: 'framework', pkg: 'next', label: 'next' },
  { category: 'framework', pkg: 'nuxt', label: 'nuxt' },
  { category: 'framework', pkg: '@remix-run/react', label: 'remix' },
  { category: 'framework', pkg: '@remix-run/node', label: 'remix' },
  { category: 'framework', pkg: 'react-router', label: 'react-router' },
  { category: 'framework', pkg: 'astro', label: 'astro' },
  { category: 'framework', pkg: '@sveltejs/kit', label: 'sveltekit' },
  { category: 'framework', pkg: '@builder.io/qwik-city', label: 'qwik-city' },
  { category: 'framework', pkg: 'gatsby', label: 'gatsby' },
  { category: 'framework', pkg: 'express', label: 'express' },
  { category: 'framework', pkg: 'fastify', label: 'fastify' },

  // UI runtimes.
  { category: 'ui', pkg: '@angular/core', label: 'angular' },
  { category: 'ui', pkg: 'react-dom', label: 'react' },
  { category: 'ui', pkg: 'react', label: 'react' },
  { category: 'ui', pkg: 'vue', label: 'vue' },
  { category: 'ui', pkg: 'svelte', label: 'svelte' },
  { category: 'ui', pkg: 'solid-js', label: 'solid' },
  { category: 'ui', pkg: 'preact', label: 'preact' },

  // Bundlers / build tools.
  { category: 'bundler', pkg: 'vite', label: 'vite' },
  { category: 'bundler', pkg: '@rspack/core', label: 'rspack' },
  { category: 'bundler', pkg: 'webpack', label: 'webpack' },
  { category: 'bundler', pkg: 'parcel', label: 'parcel' },
  { category: 'bundler', pkg: 'rollup', label: 'rollup' },
  { category: 'bundler', pkg: 'esbuild', label: 'esbuild' },

  // Deployment-runtime hints from build deps.
  { category: 'runtime', pkg: 'wrangler', label: 'cloudflare-workers' },
  { category: 'runtime', pkg: '@cloudflare/workers-types', label: 'cloudflare-workers' },
  { category: 'runtime', pkg: '@cloudflare/vite-plugin', label: 'cloudflare-workers' },
  { category: 'runtime', pkg: '@vercel/node', label: 'vercel' },
  { category: 'runtime', pkg: '@netlify/functions', label: 'netlify' },
  { category: 'runtime', pkg: '@netlify/blobs', label: 'netlify' },

  // Vibe / builder platforms — the "learn from each platform" signal.
  { category: 'builder', pkg: 'lovable-tagger', label: 'lovable' },
  { category: 'builder', pkg: '@replit/vite-plugin-runtime-error-modal', label: 'replit' },
  { category: 'builder', pkg: '@replit/vite-plugin-cartographer', label: 'replit' },
];

/** Build-environment variable-name patterns that fingerprint a host, from server-insight. */
const HOSTING_ENV_PATTERNS: readonly RegExp[] = [
  /^CF_/,
  /^CLOUDFLARE_/,
  /^VERCEL/,
  /^NETLIFY/,
  /^AWS_(LAMBDA|REGION|EXECUTION)/,
  /^FLY_/,
  /^RENDER/,
  /^RAILWAY_/,
  /^DENO_/,
  /^EDGE_RUNTIME/,
  /^DYNO$/,
  /^K_SERVICE$/,
  /^GAE_/,
  /^FUNCTION_/,
];

/**
 * Return the sorted NAMES of hosting-related environment variables present in
 * `env`. Only names are surfaced — never values — so a build fingerprint can
 * distinguish "deployed on Cloudflare" from "deployed on Vercel" without ever
 * disclosing a secret.
 */
export function collectHostingEnvKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env)
    .filter((key) => HOSTING_ENV_PATTERNS.some((pattern) => pattern.test(key)))
    .sort();
}

/**
 * Derive a {@link StackDescriptor} from the wire packages and the build
 * environment. Never throws: an unrecognised stack just yields nulls.
 */
export function detectStack(
  packages: readonly WirePackage[],
  env: NodeJS.ProcessEnv = process.env,
): StackDescriptor {
  const present = new Set(packages.map((pkg) => pkg.name));

  const firstMatch = (category: Category): string | null => {
    for (const rule of STACK_RULES) {
      if (rule.category === category && present.has(rule.pkg)) {
        return rule.label;
      }
    }
    return null;
  };

  return {
    framework: firstMatch('framework'),
    ui: firstMatch('ui'),
    bundler: firstMatch('bundler'),
    runtime: firstMatch('runtime'),
    builder: firstMatch('builder'),
    ecosystem: 'npm',
    hostingEnvKeys: collectHostingEnvKeys(env),
  };
}

/** True when the descriptor carries no useful signal (nothing worth injecting). */
export function isEmptyStack(stack: StackDescriptor): boolean {
  return (
    stack.framework === null &&
    stack.ui === null &&
    stack.bundler === null &&
    stack.runtime === null &&
    stack.builder === null &&
    stack.hostingEnvKeys.length === 0
  );
}
