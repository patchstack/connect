// The four-step progress checklist `guide`, `setup` and `scan` all end on. The step labels match the
// Patchstack dashboard word for word, so a person moving between the two sees one list.

export type ProgressStep = 'installed' | 'connected' | 'synced' | 'deployed';

export type Progress = Record<ProgressStep, boolean>;

export const PROGRESS_STEPS: ReadonlyArray<{ step: ProgressStep; label: string }> = [
  { step: 'installed', label: 'Install the Patchstack connector' },
  { step: 'connected', label: 'Connect project to Patchstack account' },
  { step: 'synced', label: 'Sync and monitor in local environment' },
  { step: 'deployed', label: 'Deploy project to protect live app' },
];

export interface NextStepContext {
  /** Install command for this project's package manager. */
  installCommand: string;
  siteUuid: string | null;
  claimUrl: string | null;
  /** The widget tag is on the page, so its connect panel is one way to connect. */
  widgetInPlace: boolean;
}

export interface RenderProgressOptions {
  useColor: boolean;
  /** Short lines printed under a step, for the parts of it that are still missing. */
  details?: Partial<Record<ProgressStep, string[]>>;
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

/** What to do for one step: the command or link first, one line each. */
export function nextStepLines(
  step: ProgressStep,
  context: NextStepContext,
  progress?: Progress,
): string[] {
  switch (step) {
    case 'installed':
      return [`Run: ${context.installCommand}`, 'Then run: npx @patchstack/connect setup'];
    case 'connected':
      if (context.siteUuid === null) {
        return [
          'Run: npx @patchstack/connect setup',
          'It creates the site and prints the link to connect it.',
          'If your tool will not run it, give the command to the user (see "When your tool will not run this CLI" in AGENT-INSTALL.md).',
        ];
      }
      return [
        ...(context.claimUrl !== null ? [`Open: ${context.claimUrl}`] : []),
        `${context.claimUrl !== null ? 'Or run' : 'Run'}: npx @patchstack/connect claim`,
        ...(context.widgetInPlace ? ['Or sign in on the Patchstack widget in the preview.'] : []),
        // A run that is itself the deploy has nothing further to point at.
        ...(progress?.deployed === true
          ? []
          : ['Already connected? Then commit, set PATCHSTACK_API_KEY on your host, and deploy.']),
      ];
    case 'synced':
      return ['Run: npx @patchstack/connect scan'];
    case 'deployed':
      return [
        'Commit your changes. Never commit .patchstackrc.local.json.',
        'Set PATCHSTACK_API_KEY (from .patchstackrc.local.json) on your hosting platform.',
        'Deploy or publish. The live site keeps its old build until you do.',
      ];
  }
}

export function renderProgress(
  progress: Progress,
  context: NextStepContext,
  options: RenderProgressOptions,
): string[] {
  const paint = (code: string, text: string): string =>
    options.useColor ? `${code}${text}${ANSI.reset}` : text;
  const lines: string[] = [];

  for (const { step, label } of PROGRESS_STEPS) {
    lines.push(progress[step] ? ` ${paint(ANSI.green, '✔')} ${label}` : ` ${paint(ANSI.yellow, '✘')} ${label}`);
    for (const detail of options.details?.[step] ?? []) {
      lines.push(`     ${paint(ANSI.dim, detail)}`);
    }
  }

  const next = nextProgressStep(progress);
  lines.push('');
  if (next === null) {
    lines.push(paint(ANSI.bold, 'All done.'));
    return lines;
  }
  const label = PROGRESS_STEPS.find(({ step }) => step === next)!.label;
  lines.push(`${paint(ANSI.cyan, '➜')} ${paint(ANSI.bold, `Next: ${label}`)}`);
  for (const line of nextStepLines(next, context, progress)) {
    lines.push(`  ${line}`);
  }
  return lines;
}
