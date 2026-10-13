// The four-step progress checklist `guide`, `setup` and `scan` all end on. The step labels match the
// Patchstack dashboard word for word, so a person moving between the two sees one list.

import type { Environment, EnvironmentSource } from './types.js';

export type ProgressStep = 'installed' | 'connected' | 'synced' | 'deployed';

export type Progress = Record<ProgressStep, boolean>;

export const PROGRESS_STEPS: ReadonlyArray<{ step: ProgressStep; label: string }> = [
  { step: 'installed', label: 'Install the Patchstack connector' },
  { step: 'connected', label: 'Connect project to Patchstack account' },
  { step: 'synced', label: 'Sync and monitor your project' },
  { step: 'deployed', label: 'Deploy project to protect live app' },
];

export interface NextStepContext {
  /** Install command for this project's package manager. */
  installCommand: string;
  siteUuid: string | null;
  claimUrl: string | null;
  /** Where a scan from here reports from. Names the sync step and decides what the deploy step says. */
  environment?: Environment | null;
  environmentSource?: EnvironmentSource | null;
}

/** The sync step names the environment the scan came from, as the dashboard does. */
export function stepLabel(step: ProgressStep, environment?: Environment | null): string {
  if (step === 'synced' && environment) return `Sync and monitor in ${environment} environment`;
  return PROGRESS_STEPS.find((entry) => entry.step === step)!.label;
}

/**
 * A production scan is a build, not a deploy: a hosted builder such as Lovable builds without
 * publishing, and a platform can build a release it never serves. Only the dashboard sees the live
 * site, so the CLI reports what it sent and leaves the tick to Patchstack.
 */
export function deployNote(context: NextStepContext): string | null {
  if (context.environment !== 'production') return null;
  return context.environmentSource === 'builder'
    ? 'Reported as a publish. Patchstack ticks this once it sees the live site.'
    : 'Built for production. Patchstack ticks this once it sees the live site.';
}

export interface RenderProgressOptions {
  useColor: boolean;
  /** Says the next step in place of its usual title, for a report that has a better reason to give. */
  nextTitle?: string;
  /** Plain-word labels that say what is done and what to do, for the concise report. */
  plain?: boolean;
}

/**
 * The concise report's labels: a done step says what is true, a step not done says what to do. These
 * differ from the dashboard's wording, so they are used only where that report is printed.
 */
export function plainStepLabel(step: ProgressStep, done: boolean, environment?: Environment | null): string {
  switch (step) {
    case 'installed':
      return done ? 'Patchstack installed' : 'Install Patchstack';
    case 'connected':
      return done ? 'Connected to your Patchstack account' : 'Connect your Patchstack account';
    case 'synced': {
      if (!done) return 'Check your packages';
      const where = environment === 'production' ? 'in your live build' : environment === 'sandbox' ? 'in your preview' : 'on this computer';
      return `Packages checked ${where}`;
    }
    case 'deployed':
      return done ? 'Live app protected' : 'Deploy to protect your live app';
  }
}

/**
 * The concise report's lines for a step: the same as `nextStepLines`, except that going live points at
 * `go-live`, which gives the steps for this project's host instead of a general description of them.
 */
export function plainNextStepLines(step: ProgressStep, context: NextStepContext): string[] {
  const goLive = 'Run: npx @patchstack/connect go-live';
  if (step === 'deployed' && context.environment !== 'production') {
    return [goLive, 'It shows how to add your key to your host and deploy.'];
  }
  if (step === 'connected' && context.siteUuid !== null && context.environment !== 'production') {
    return [nextStepLines(step, context)[0]!, `Already connected? ${goLive}`];
  }
  return nextStepLines(step, context);
}

/** The concise report's next-step titles. */
export function plainNextStepTitle(step: ProgressStep, context: NextStepContext): string {
  switch (step) {
    case 'installed':
      return 'install Patchstack';
    case 'connected':
      return 'connect your Patchstack account';
    case 'synced':
      return 'check your packages';
    case 'deployed':
      return context.environment === 'production' ? 'open your live app once' : 'deploy to protect your live app';
  }
}

const ANSI = {
  reset: '\u001B[0m',
  bold: '\u001B[1m',
  dim: '\u001B[2m',
  green: '\u001B[32m',
  yellow: '\u001B[33m',
  cyan: '\u001B[36m',
};

export function nextProgressStep(progress: Progress): ProgressStep | null {
  return PROGRESS_STEPS.find(({ step }) => !progress[step])?.step ?? null;
}

/** The next step as an action, for the `Next:` line. */
export function nextStepTitle(step: ProgressStep, context: NextStepContext): string {
  switch (step) {
    case 'installed':
      return 'install the Patchstack connector';
    case 'connected':
      return 'connect this project to your Patchstack account';
    case 'synced':
      return 'sync this project with Patchstack';
    case 'deployed':
      return context.environment === 'production'
        ? 'open your live app so Patchstack can see it'
        : 'deploy your project to protect the live app';
  }
}

/** What to do for one step: the command or link first, one line each. */
export function nextStepLines(
  step: ProgressStep,
  context: NextStepContext,
): string[] {
  switch (step) {
    case 'installed':
      return [`Run: ${context.installCommand}`, 'Then run: npx @patchstack/connect setup'];
    case 'connected':
      if (context.siteUuid === null) {
        return [
          'Run: npx @patchstack/connect setup',
          'It adds this project to Patchstack and prints the link to connect it.',
          'Cannot run commands here? See "When your tool will not run this CLI" in AGENT-INSTALL.md.',
        ];
      }
      return [
        context.claimUrl !== null ? `Open ${context.claimUrl}` : 'Run: npx @patchstack/connect claim',
        // A production run is the deploy itself, so there is nothing further to point at.
        ...(context.environment === 'production'
          ? []
          : ['Already connected? Then commit, set PATCHSTACK_API_KEY on your host, and deploy.']),
      ];
    case 'synced':
      return ['Run: npx @patchstack/connect scan'];
    case 'deployed':
      if (context.environment === 'production') {
        return ['Open the live site once so Patchstack can see it.', 'Not published yet? Publish or deploy it now.'];
      }
      return [
        'Commit your changes. Never commit .patchstackrc.local.json.',
        'Set PATCHSTACK_API_KEY (from .patchstackrc.local.json) on your hosting platform.',
        'Deploy or publish. The live site keeps its old version until you do.',
      ];
  }
}

export function renderProgress(
  progress: Progress,
  context: NextStepContext,
  options: RenderProgressOptions,
): string[] {
  return [...renderChecklist(progress, context, options), '', ...renderNextStep(progress, context, options)];
}

/** The four steps, ✔ or ✘ each. */
export function renderChecklist(progress: Progress, context: NextStepContext, options: RenderProgressOptions): string[] {
  const paint = (code: string, text: string): string =>
    options.useColor ? `${code}${text}${ANSI.reset}` : text;
  const lines: string[] = [];
  for (const { step } of PROGRESS_STEPS) {
    const label = options.plain === true ? plainStepLabel(step, progress[step], context.environment) : stepLabel(step, context.environment);
    lines.push(progress[step] ? ` ${paint(ANSI.green, '✔')} ${label}` : ` ${paint(ANSI.yellow, '✘')} ${label}`);
    const note =
      step === 'deployed' && !progress.deployed
        ? options.plain === true && context.environment === 'production'
          ? 'Ticks once Patchstack sees your live app.'
          : deployNote(context)
        : null;
    if (note !== null) lines.push(`     ${paint(ANSI.dim, note)}`);
  }
  return lines;
}

/** The one next step: its title, then the command or link. */
export function renderNextStep(progress: Progress, context: NextStepContext, options: RenderProgressOptions): string[] {
  const paint = (code: string, text: string): string =>
    options.useColor ? `${code}${text}${ANSI.reset}` : text;
  const next = nextProgressStep(progress);
  if (next === null) return [paint(ANSI.bold, 'All done.')];
  return [
    `${paint(ANSI.cyan, '➜')} ${paint(ANSI.bold, `Next: ${options.nextTitle ?? nextStepTitle(next, context)}`)}`,
    ...nextStepLines(next, context).map((line) => `  ${line}`),
  ];
}
