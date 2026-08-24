/**
 * What a hand-written lockfile scanner could not read.
 *
 * These scanners walk their formats by hand rather than take a YAML dependency, so they meet entries they
 * were not written for: a protocol nobody has seen here, a block shaped differently by a newer release of
 * the package manager. Skipping such an entry is the right thing to do with it — inventing a name and a
 * version would put something in a vulnerability inventory that no advisory can match. Skipping it in
 * SILENCE is not: the result then reads as the project's whole dependency set, and a package that was
 * dropped is indistinguishable from a package that is not installed.
 *
 * Filled in by the parser when the caller passes one, and reported alongside the manifest.
 */
export interface ParseReport {
  /** Entries seen and not turned into a package. */
  unreadable: number;
  /** A few of them, verbatim, so the reader can tell what the scanner does not handle. */
  samples: string[];
}

const MAX_SAMPLES = 3;

export function newReport(): ParseReport {
  return { unreadable: 0, samples: [] };
}

export function recordUnreadable(report: ParseReport | undefined, sample: string): void {
  if (!report) return;
  report.unreadable++;
  if (report.samples.length < MAX_SAMPLES) report.samples.push(sample);
}

/** The warning for a source that dropped entries, or null when it read everything. */
export function unreadableWarning(filename: string, report: ParseReport): string | null {
  if (report.unreadable === 0) return null;

  const shown = report.samples.join(', ');

  return (
    `${filename}: ${report.unreadable} entr${report.unreadable === 1 ? 'y was' : 'ies were'} not in a form this ` +
    `scanner reads (${shown}${report.unreadable > report.samples.length ? ', …' : ''}), so ${report.unreadable === 1 ? 'it is' : 'they are'} ` +
    'absent from this manifest. Anything installed only through those entries is not being checked.'
  );
}
