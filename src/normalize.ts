import type { Manifest, PackageEntry } from './types.js';

export interface WirePackage {
  name: string;
  version: string;
}

export interface WirePayload {
  ecosystem: Manifest['ecosystem'];
  packages: WirePackage[];
}

export interface NormalizeStats {
  uniqueNames: number;
  duplicateNames: string[];
  totalEntries: number;
}

export interface NormalizeResult {
  payload: WirePayload;
  stats: NormalizeStats;
}

export function buildWirePayload(manifest: Manifest): NormalizeResult {
  const seen = new Map<string, Set<string>>();
  const wirePackages: WirePackage[] = [];

  for (const entry of manifest.packages) {
    const versions = seen.get(entry.name);
    if (versions) {
      if (versions.has(entry.version)) {
        continue;
      }
      versions.add(entry.version);
    } else {
      seen.set(entry.name, new Set([entry.version]));
    }
    wirePackages.push({ name: entry.name, version: entry.version });
  }

  wirePackages.sort((a, b) => {
    if (a.name === b.name) {
      return compareVersions(a.version, b.version);
    }
    return a.name < b.name ? -1 : 1;
  });

  const duplicateNames: string[] = [];
  for (const [name, versions] of seen) {
    if (versions.size > 1) {
      duplicateNames.push(name);
    }
  }

  return {
    payload: { ecosystem: manifest.ecosystem, packages: wirePackages },
    stats: {
      uniqueNames: seen.size,
      duplicateNames,
      totalEntries: manifest.packages.length,
    },
  };
}

export function compareVersions(a: string, b: string): number {
  if (a === b) {
    return 0;
  }

  const [aBase, aPre] = splitPrerelease(a);
  const [bBase, bPre] = splitPrerelease(b);

  const baseCmp = compareSegments(aBase.split('.'), bBase.split('.'));
  if (baseCmp !== 0) {
    return baseCmp;
  }

  if (aPre === null && bPre === null) {
    return 0;
  }
  if (aPre === null) {
    return 1;
  }
  if (bPre === null) {
    return -1;
  }
  return compareSegments(aPre.split('.'), bPre.split('.'));
}

function splitPrerelease(version: string): [string, string | null] {
  const cleaned = version.replace(/^[v=]+/, '').split('+')[0]!;
  const dashIndex = cleaned.indexOf('-');
  if (dashIndex === -1) {
    return [cleaned, null];
  }
  return [cleaned.slice(0, dashIndex), cleaned.slice(dashIndex + 1)];
}

function compareSegments(a: string[], b: string[]): number {
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    const aPart = a[i];
    const bPart = b[i];
    // A shorter segment list sorts before a longer one (e.g. `1.0` before `1.0.1`).
    if (aPart === undefined) {
      return -1;
    }
    if (bPart === undefined) {
      return 1;
    }
    const cmp = comparePartTokens(aPart, bPart);
    if (cmp !== 0) {
      return cmp;
    }
  }
  return 0;
}

/**
 * Compares two version tokens. Numeric tokens sort numerically and ahead of
 * non-numeric ones; otherwise tokens fall back to lexical comparison.
 */
function comparePartTokens(a: string, b: string): number {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) {
    const diff = Number(a) - Number(b);
    return diff === 0 ? 0 : diff < 0 ? -1 : 1;
  }
  if (aNum) {
    return -1;
  }
  if (bNum) {
    return 1;
  }
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

export function findPackageInManifest(
  manifest: Manifest,
  name: string,
): PackageEntry[] {
  return manifest.packages.filter((p) => p.name === name);
}
