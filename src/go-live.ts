// `go-live`: how to deploy, for the host this project uses, and how to put the project's API key on a host
// that takes one.
//
// The key is optional everywhere. A published app carries a read-only credential in its guard's rules file,
// which is enough to fetch protection rules. A hosted builder publishes without the key, so its steps never
// mention one: the person there has never been shown a key and has nothing to paste.
//
// The key is never printed. Every command reads it from the git-ignored credential file at the moment it
// runs, and a host that is set up in its dashboard is told where the value is, so the key does not pass
// through the terminal, a log or an assistant's reply.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { painter } from './art.js';
import { detectHostedBuilder } from './environment.js';
import { detectHostingPlatform } from './hosting.js';
import type { EnvLike } from './stack.js';

export type Host =
  | 'vercel'
  | 'netlify'
  | 'cloudflare-pages'
  | 'cloudflare-workers'
  | 'render'
  | 'railway'
  | 'fly'
  | 'heroku'
  | 'amplify'
  | 'replit'
  | 'bolt'
  | 'lovable';

export const HOST_NAMES: Record<Host, string> = {
  vercel: 'Vercel',
  netlify: 'Netlify',
  'cloudflare-pages': 'Cloudflare Pages',
  'cloudflare-workers': 'Cloudflare Workers',
  render: 'Render',
  railway: 'Railway',
  fly: 'Fly.io',
  heroku: 'Heroku',
  amplify: 'AWS Amplify',
  replit: 'Replit',
  bolt: 'Bolt',
  lovable: 'Lovable',
};

/** The words `--host` accepts for each host, so a person can type the name they know it by. */
const HOST_ALIASES: Record<string, Host> = {
  vercel: 'vercel',
  netlify: 'netlify',
  cloudflare: 'cloudflare-pages',
  'cloudflare-pages': 'cloudflare-pages',
  'cloudflare pages': 'cloudflare-pages',
  pages: 'cloudflare-pages',
  'cloudflare-workers': 'cloudflare-workers',
  'cloudflare workers': 'cloudflare-workers',
  workers: 'cloudflare-workers',
  render: 'render',
  railway: 'railway',
  fly: 'fly',
  'fly.io': 'fly',
  heroku: 'heroku',
  amplify: 'amplify',
  aws: 'amplify',
  'aws amplify': 'amplify',
  replit: 'replit',
  bolt: 'bolt',
  'bolt.new': 'bolt',
  lovable: 'lovable',
};

export function parseHost(name: string): Host | null {
  return HOST_ALIASES[name.trim().toLowerCase()] ?? null;
}

/** The value a command substitutes for the key: read from the credential file as the command runs. */
const KEY_FROM_FILE = `"$(node -p "require('./.patchstackrc.local.json').apiKey")"`;
const KEY_PIPE = `node -p "require('./.patchstackrc.local.json').apiKey" |`;

/**
 * The host this project deploys to, from the files a host's own tooling writes into a project, then the
 * hosted builder that generated it, then the environment of a build already running on a host. Null when
 * nothing says.
 */
export function detectHost(cwd: string, env: EnvLike = process.env): Host | null {
  const has = (file: string): boolean => existsSync(path.join(cwd, file));

  if (has('vercel.json') || has('.vercel')) return 'vercel';
  if (has('netlify.toml') || has('.netlify')) return 'netlify';
  for (const file of ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc']) {
    if (has(file)) {
      // Pages projects name their build output in the wrangler file; a Worker does not.
      const text = readFileSync(path.join(cwd, file), 'utf8');
      return text.includes('pages_build_output_dir') ? 'cloudflare-pages' : 'cloudflare-workers';
    }
  }
  if (has('fly.toml')) return 'fly';
  if (has('render.yaml')) return 'render';
  if (has('railway.json') || has('railway.toml')) return 'railway';
  if (has('amplify.yml')) return 'amplify';
  if (has('Procfile')) return 'heroku';
  if (has('.replit')) return 'replit';
  if (has('.bolt')) return 'bolt';

  const builder = detectHostedBuilder(cwd);
  if (builder === 'lovable') return 'lovable';
  if (builder === 'replit') return 'replit';

  const running = detectHostingPlatform(env).platform;
  switch (running) {
    case 'vercel':
    case 'netlify':
    case 'render':
    case 'railway':
    case 'fly':
    case 'heroku':
    case 'replit':
      return running;
    case 'cloudflare':
      return 'cloudflare-pages';
    case 'aws':
      return 'amplify';
    default:
      return null;
  }
}

interface HostGuide {
  /** One command that adds the key, or dashboard steps when the host has no command for it. */
  addKey: { command: string } | { steps: string };
  deploy: string;
}

const DASHBOARD_VALUE = 'Use the apiKey value from .patchstackrc.local.json.';

/**
 * Hosted builders, which publish the app themselves and without the project's key. Each has the one
 * button its owner presses.
 */
const BUILDER_PUBLISH: Record<'lovable' | 'replit' | 'bolt', string> = {
  lovable: 'Click Publish in Lovable',
  replit: 'Click Deploy (or Redeploy) in Replit',
  bolt: 'Click Publish in Bolt',
};

/**
 * Whether this host's steps read the key from the credential file. Only then does the file have to exist:
 * a builder's workspace may not keep it, and its steps never use it.
 */
export function stepsReadKeyFile(host: Host | null): boolean {
  return host !== null && !(host in BUILDER_PUBLISH);
}

const GUIDES: Record<Exclude<Host, keyof typeof BUILDER_PUBLISH>, HostGuide> = {
  vercel: {
    addKey: { command: `${KEY_PIPE} npx vercel env add PATCHSTACK_API_KEY production --sensitive` },
    deploy: 'Push to your production branch, or run: npx vercel --prod',
  },
  netlify: {
    addKey: { command: `npx netlify env:set PATCHSTACK_API_KEY ${KEY_FROM_FILE} --context production --secret` },
    deploy: 'Push to your production branch, or run: npx netlify deploy --prod',
  },
  'cloudflare-pages': {
    addKey: { command: `${KEY_PIPE} npx wrangler pages secret put PATCHSTACK_API_KEY` },
    deploy: 'Push to your production branch',
  },
  'cloudflare-workers': {
    addKey: { command: `${KEY_PIPE} npx wrangler secret put PATCHSTACK_API_KEY` },
    deploy: 'Run: npx wrangler deploy',
  },
  render: {
    addKey: { steps: 'In the Render dashboard, open your service → Environment, and add PATCHSTACK_API_KEY.' },
    deploy: 'Push to your production branch',
  },
  railway: {
    addKey: { steps: 'In Railway, open your service → Variables, and add PATCHSTACK_API_KEY.' },
    deploy: 'Push to your production branch',
  },
  fly: {
    addKey: { command: `fly secrets set PATCHSTACK_API_KEY=${KEY_FROM_FILE}` },
    deploy: 'Run: fly deploy',
  },
  heroku: {
    addKey: { command: `heroku config:set PATCHSTACK_API_KEY=${KEY_FROM_FILE}` },
    deploy: 'Push to your Heroku remote: git push heroku main',
  },
  amplify: {
    addKey: { steps: 'In the Amplify console, open your app → Environment variables, and add PATCHSTACK_API_KEY.' },
    deploy: 'Push to your production branch',
  },
};

export interface GoLiveOptions {
  useColor: boolean;
}

/** One `--host` command per host, padded to line up. Cloudflare Workers is reached as `--host workers`. */
function hostMenu(): Array<{ command: string; name: string }> {
  const entries = (Object.keys(HOST_NAMES) as Host[])
    .filter((host) => host !== 'cloudflare-workers')
    .map((host) => ({ flag: host === 'cloudflare-pages' ? 'cloudflare' : host, name: HOST_NAMES[host] }));
  const width = Math.max(...entries.map(({ flag }) => flag.length));
  return entries.map(({ flag, name }) => ({ command: `npx @patchstack/connect go-live --host ${flag.padEnd(width)}`, name }));
}

/** The steps for one host, or the list of hosts to choose from when none was found. */
export function renderGoLive(host: Host | null, options: GoLiveOptions): string[] {
  const paint = painter(options.useColor);

  if (host === null) {
    return [
      paint('bold', 'Where is your app hosted?'),
      '',
      ...hostMenu().map(({ command, name }) => `  ${paint('cyan', command)}  ${paint('dim', name)}`),
      '',
      paint('dim', 'Somewhere else? Deploy as you normally do. No key is needed.'),
      paint('dim', 'On a host you manage yourself, adding PATCHSTACK_API_KEY to its environment variables is optional.'),
    ];
  }

  const name = HOST_NAMES[host];
  const lines: string[] = [paint('bold', `Go live on ${name}`), ''];

  if (host in BUILDER_PUBLISH) {
    lines.push(
      ` ${paint('cyan', '1.')} ${paint('bold', BUILDER_PUBLISH[host as keyof typeof BUILDER_PUBLISH])}`,
      `    ${paint('dim', `There is no key to add. ${name} publishes without one, and your app already carries what it needs to get protection rules.`)}`,
      `    ${paint('dim', `Changed your packages since? Run npx @patchstack/connect scan in ${name} first.`)}`,
    );
    return lines;
  }

  const guide = GUIDES[host as keyof typeof GUIDES];
  lines.push(` ${paint('cyan', '1.')} ${paint('bold', `Add your Patchstack key to ${name}`)}`);
  lines.push(`    ${paint('dim', 'Optional. Your live app gets protection rules without it; with the key, what it reports is verified.')}`);
  if ('command' in guide.addKey) {
    lines.push(`    ${paint('cyan', guide.addKey.command)}`);
  } else {
    lines.push(`    ${guide.addKey.steps}`, `    ${paint('dim', DASHBOARD_VALUE)}`);
  }
  lines.push(
    '',
    ` ${paint('cyan', '2.')} ${paint('bold', 'Commit your changes')}`,
    `    ${paint('dim', 'Never commit .patchstackrc.local.json. It holds the key.')}`,
    '',
    ` ${paint('cyan', '3.')} ${paint('bold', 'Deploy')}`,
    `    ${guide.deploy}`,
  );
  return lines;
}
