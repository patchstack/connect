// What a vulnerability means for this project: whether it reaches the live app, whether the project's
// own code uses the package, how urgent it is here, and the simplest command that fixes it. Everything
// is worked out from files in the project, so the advice fits it without sending anything anywhere.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { SKIPPED_DIRS, type PackageManager } from './guide.js';

/** One known vulnerability in one installed package, as Patchstack reports it. */
export interface Finding {
  name: string;
  /** The installed version the vulnerability affects. */
  version: string;
  severity: 'high' | 'medium' | 'low' | 'unknown';
  title?: string | null;
  /** The kind of vulnerability, such as "Cross Site Scripting (XSS)". */
  type?: string | null;
  cve?: string | null;
  /** The first version that fixes it for the installed version; null when no fix is out. */
  fixedIn?: string | null;
  /** Attackers are known to be using it. */
  exploited?: boolean;
  url?: string | null;
}

/** What the project's own files say about a package. */
export interface ProjectFacts {
  packageManager: PackageManager;
  /** Packages named in package.json, with whether they are only for development. */
  declared: Map<string, { dev: boolean }>;
  /** From the lockfile: `name@version` that is only installed for development. */
  devOnly: Set<string>;
  /** From the lockfile: the declared packages that bring each package in. */
  broughtInBy: Map<string, string[]>;
  /** Source files, relative to the project, that import each package. */
  importedFrom: Map<string, string[]>;
  /** The project has a server of its own. */
  hasServer: boolean;
}

export type Verdict = 'now' | 'soon' | 'low';

export interface Assessment {
  finding: Finding;
  verdict: Verdict;
  /** One plain sentence saying what an attacker could do. */
  whatItIs: string;
  /** Why the verdict is what it is for this project, one fact each. */
  reasons: string[];
  /** The command that fixes it, when a fixed version is out. */
  fix: string | null;
  /** A small update is safe to take; a major one may need code changes. */
  fixSize: 'small' | 'major' | null;
  /** A second step for when the first does not reach the fixed version. */
  fallback: string | null;
}

/**
 * Kinds of vulnerability in plain words, matched against the reported type or title. `serverOnly` marks
 * attacks that need code running on a server, which an app without one cannot be hit by through this
 * package.
 */
const KINDS: ReadonlyArray<{ match: RegExp; plain: string; serverOnly?: boolean }> = [
  { match: /cross[- ]site scripting|\bxss\b/i, plain: 'Someone could run their own code in your visitors\' browsers.' },
  { match: /prototype pollution/i, plain: 'Crafted input could change how your app\'s objects behave, which can lead to crashes or worse.' },
  { match: /server[- ]side request forgery|\bssrf\b/i, plain: 'Someone could make your server send requests to places it should not reach.', serverOnly: true },
  { match: /sql injection|\bsqli\b/i, plain: 'Someone could read or change your database through crafted input.', serverOnly: true },
  { match: /command injection|code injection|remote code execution|\brce\b/i, plain: 'Someone could run their own commands on the machine your app runs on.', serverOnly: true },
  { match: /path traversal|directory traversal/i, plain: 'Someone could read files on your server that should stay private.', serverOnly: true },
  { match: /redos|regular expression denial/i, plain: 'Crafted input could make your app freeze while it processes a pattern.' },
  { match: /denial of service|\bdos\b|resource exhaustion|uncontrolled resource/i, plain: 'Crafted input could make your app slow down or stop responding.' },
  { match: /open redirect/i, plain: 'Links to your site could send visitors on to a site an attacker chose.' },
  { match: /cross[- ]site request forgery|\bcsrf\b/i, plain: 'Another site could make your logged-in users take actions without meaning to.' },
  { match: /information (disclosure|exposure)|sensitive (data|information)/i, plain: 'Information that should stay private could be exposed.' },
  { match: /auth(entication|orization)? bypass|improper (access|authori[sz]ation)/i, plain: 'Someone could get past a login or permission check.' },
  { match: /http (request|response) smuggling|header injection|crlf/i, plain: 'Crafted requests could slip past your app\'s checks on what comes in.', serverOnly: true },
];

const SEVERITY_SCORE = { high: 3, medium: 2, low: 1, unknown: 2 } as const;

export function assessFinding(finding: Finding, facts: ProjectFacts): Assessment {
  const label = `${finding.type ?? ''} ${finding.title ?? ''}`;
  const kind = KINDS.find((entry) => entry.match.test(label));
  const whatItIs = kind?.plain ?? (finding.title ? `${finding.title}.` : 'A known security problem in this version.');

  const key = `${finding.name}@${finding.version}`;
  const declared = facts.declared.get(finding.name);
  const parents = facts.broughtInBy.get(finding.name) ?? [];
  const importers = facts.importedFrom.get(finding.name) ?? [];
  const devOnly = facts.devOnly.has(key) || (declared?.dev === true && !facts.devOnly.size);

  const reasons: string[] = [];
  let verdict: Verdict;
  if (devOnly) {
    reasons.push('Only used while building your app, never in the live app.');
    verdict = 'low';
  } else {
    let score: number = SEVERITY_SCORE[finding.severity];
    if (finding.exploited === true) {
      score += 1;
      reasons.push('Attackers are already using this one.');
    }
    if (importers.length > 0) {
      reasons.push(`Your code uses it: ${listFiles(importers)}.`);
    } else if (declared === undefined) {
      // Said, not scored: a package the code never imports still runs when the one that brings it in does.
      reasons.push(parents.length > 0 ? `Your code does not use it directly. It comes in with ${parents.join(', ')}.` : 'Your code does not use it directly.');
    }
    if (kind?.serverOnly === true && !facts.hasServer) {
      score -= 1;
      reasons.push('This attack needs a server, and your app runs in the browser.');
    } else {
      reasons.push(facts.hasServer ? 'It is part of your live app.' : 'It is part of your live app, in your visitors\' browsers.');
    }
    verdict = score >= 3 ? 'now' : score === 2 ? 'soon' : 'low';
  }

  const fixed = finding.fixedIn ?? null;
  if (fixed === null) {
    reasons.push('No fixed version is out yet.');
    return { finding, verdict, whatItIs, reasons, fix: null, fixSize: null, fallback: null };
  }
  const fixSize = majorOf(fixed) > majorOf(finding.version) ? 'major' : 'small';
  if (declared !== undefined) {
    return { finding, verdict, whatItIs, reasons, fix: addCommand(facts.packageManager, `${finding.name}@${fixed}`, declared.dev), fixSize, fallback: null };
  }
  return {
    finding,
    verdict,
    whatItIs,
    reasons,
    fix: updateCommand(facts.packageManager, finding.name),
    fixSize,
    fallback: parents.length > 0 ? `If ${finding.name} stays below ${fixed}, update ${parents.join(' or ')}.` : null,
  };
}

const VERDICT_ORDER: Record<Verdict, number> = { now: 0, soon: 1, low: 2 };

/** Every finding assessed, the most urgent first. */
export function assessFindings(findings: Finding[], facts: ProjectFacts): Assessment[] {
  return findings
    .map((finding) => assessFinding(finding, facts))
    .sort(
      (a, b) =>
        VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] ||
        SEVERITY_SCORE[b.finding.severity] - SEVERITY_SCORE[a.finding.severity] ||
        a.finding.name.localeCompare(b.finding.name),
    );
}

const VERDICT_LABEL: Record<Verdict, string> = { now: '🔴 FIX NOW', soon: '🟡 FIX SOON', low: '🟢 LOW RISK FOR YOU' };

/** The assessments as the person reads them: a headline, then each finding with what to do. */
export function renderAssessments(assessments: Assessment[]): string[] {
  if (assessments.length === 0) return ['✔ No known vulnerabilities in your packages.'];
  const urgent = assessments.filter((entry) => entry.verdict === 'now').length;
  const count = `${assessments.length} ${assessments.length === 1 ? 'vulnerability' : 'vulnerabilities'}`;
  const lines = [`⚠ ${count}.${urgent > 0 ? ` ${urgent} ${urgent === 1 ? 'needs' : 'need'} fixing now.` : ' None needs fixing right now.'}`, ''];
  for (const entry of assessments) {
    const { finding } = entry;
    lines.push(`${VERDICT_LABEL[entry.verdict]} · ${finding.name} ${finding.version}`);
    lines.push(`   What it is: ${entry.whatItIs}${finding.cve ? ` (${finding.cve})` : ''}`);
    lines.push('   Why it matters for you:', ...entry.reasons.map((reason) => `     • ${reason}`));
    if (entry.fix !== null) {
      lines.push(`   Fix: ${entry.fix}   (${entry.fixSize === 'major' ? 'major update, may need code changes' : 'small update'})`);
      if (entry.fallback !== null) lines.push(`        ${entry.fallback}`);
    }
    if (finding.url) lines.push(`   More: ${finding.url}`);
    lines.push('');
  }
  lines.pop();
  return lines;
}

function listFiles(files: string[]): string {
  const shown = files.slice(0, 3).join(', ');
  return files.length > 3 ? `${shown} and ${files.length - 3} more` : shown;
}

function majorOf(version: string): number {
  const match = /^\D*(\d+)/.exec(version);
  return match ? Number(match[1]) : 0;
}

function addCommand(pm: PackageManager, spec: string, dev: boolean): string {
  const flag = dev ? ' -D' : '';
  return pm === 'npm' ? `npm install${flag} ${spec}` : `${pm} add${flag} ${spec}`;
}

function updateCommand(pm: PackageManager, name: string): string {
  return pm === 'yarn' ? `yarn up ${name}` : `${pm} update ${name}`;
}

const SCAN_MAX_FILES = 4000;
const SCAN_MAX_DEPTH = 6;
const SCAN_MAX_BYTES = 512 * 1024;
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.vue', '.svelte', '.astro', '.html', '.htm']);

/**
 * Read what the project's own files say about the packages in `names`: which are declared, which are
 * only for development, what brings each in, and which source files import them. The source walk is
 * bounded like the widget search, so a large project stays quick.
 */
export function collectProjectFacts(cwd: string, names: string[], options: { packageManager: PackageManager; hasServer: boolean }): ProjectFacts {
  const declared = new Map<string, { dev: boolean }>();
  const pkg = readJson(path.join(cwd, 'package.json'));
  for (const [field, dev] of [['dependencies', false], ['optionalDependencies', false], ['devDependencies', true]] as const) {
    for (const name of Object.keys((pkg?.[field] as Record<string, string> | undefined) ?? {})) {
      if (!declared.has(name)) declared.set(name, { dev });
    }
  }

  const devOnly = new Set<string>();
  const broughtInBy = new Map<string, string[]>();
  const lock = readJson(path.join(cwd, 'package-lock.json'));
  const entries = (lock?.packages as Record<string, { version?: string; dev?: boolean; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }> | undefined) ?? {};
  const wanted = new Set(names);
  // Who requires whom, by name: enough to say which declared package a deep dependency comes in with.
  const requiredBy = new Map<string, Set<string>>();
  for (const [location, entry] of Object.entries(entries)) {
    const name = nameFromLocation(location);
    if (name === null) continue;
    if (entry.dev === true && entry.version !== undefined) devOnly.add(`${name}@${entry.version}`);
    for (const child of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies })) {
      if (!requiredBy.has(child)) requiredBy.set(child, new Set());
      requiredBy.get(child)!.add(name);
    }
  }
  for (const name of wanted) {
    if (declared.has(name)) continue;
    const roots = new Set<string>();
    const seen = new Set<string>([name]);
    const queue = [name];
    while (queue.length > 0 && roots.size < 3) {
      for (const parent of requiredBy.get(queue.shift()!) ?? []) {
        if (seen.has(parent)) continue;
        seen.add(parent);
        if (declared.has(parent)) roots.add(parent);
        else queue.push(parent);
      }
    }
    if (roots.size > 0) broughtInBy.set(name, [...roots].sort());
  }

  return {
    packageManager: options.packageManager,
    declared,
    devOnly,
    broughtInBy,
    importedFrom: findImports(cwd, names),
    hasServer: options.hasServer,
  };
}

/** `node_modules/a/node_modules/@s/b` → `@s/b`; the root entry has no name. */
function nameFromLocation(location: string): string | null {
  const index = location.lastIndexOf('node_modules/');
  return index === -1 ? null : location.slice(index + 'node_modules/'.length);
}

function findImports(cwd: string, names: string[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  if (names.length === 0) return found;
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // `from 'x'`, `import 'x'`, `require('x')`, `import('x')`, and deep imports such as `x/sub`.
  const pattern = new RegExp(`(?:from|import|require\\s*\\()\\s*\\(?\\s*['"](${escaped.join('|')})(?:/[^'"]*)?['"]`, 'g');
  let budget = SCAN_MAX_FILES;

  const walk = (dir: string, depth: number): void => {
    if (depth > SCAN_MAX_DEPTH || budget <= 0) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (budget <= 0) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      budget -= 1;
      try {
        if (statSync(full).size > SCAN_MAX_BYTES) continue;
        const content = readFileSync(full, 'utf8');
        const file = path.relative(cwd, full).split(path.sep).join('/');
        for (const match of content.matchAll(pattern)) {
          const files = found.get(match[1]!) ?? [];
          if (!files.includes(file)) files.push(file);
          found.set(match[1]!, files);
        }
      } catch {
        // unreadable file — skip
      }
    }
  };

  walk(cwd, 0);
  for (const files of found.values()) files.sort();
  return found;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
