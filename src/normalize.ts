import type { Manifest, PackageEntry } from './types.js';

export interface WirePackage {
  name: string;
  version: string;
  /**
   * Where this exact name+version is installed, repo-relative and sorted.
   *
   * The same package can be installed more than once at different versions — a workspace pinning an old
   * copy under `apps/api/node_modules`, a transitive dependency getting its own nested install. Without
   * the locations, `lodash@4.17.11` and `lodash@4.17.21` arrive as two bare pairs and nothing can say
   * WHICH one the app's own import resolves to. A consumer then has to treat every installed version as
   * if the code used it: it warns on a copy nothing reaches, or pins a rule to a route running the safe
   * one — a rule that never fires while reporting as protection.
   *
   * Node resolves an import by walking up from the importing file, so the map's import sites plus these
   * paths together answer the question. Neither half answers it alone.
   *
   * OPT-IN. Absent unless the caller asks for locations (`scan --install-paths`), and absent even then
   * when the scan source does not record them — see `installPathsComplete`, which is what separates
   * "not installed there" from "we were not told".
   *
   * Off by default because it changes what leaves the machine. The package's standing promise is that
   * `scan` sends names and versions and no paths of any kind; locations are a real widening of that, and
   * an upload that widens it should be an explicit choice rather than a consequence of upgrading.
   */
  paths?: string[];
}

export interface WirePayload {
  ecosystem: Manifest['ecosystem'];
  packages: WirePackage[];
  /**
   * Whether every entry's `paths` is the complete set of locations for it.
   *
   * False when locations were not requested at all, when the scan source cannot supply them (a yarn.lock
   * is flat — hoisting is decided at install time and the file does not record it; a v1 npm lockfile
   * describes the dependency graph, not the tree), or when only some entries had one. A consumer MUST NOT
   * read a missing or short `paths` as "installed nowhere else" while this is false; absence is then "not
   * recorded", which is not an answer.
   *
   * The default is therefore `false`, and that is the safe direction: the field withholds a negative
   * rather than granting one.
   */
  installPathsComplete: boolean;
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

export interface WireOptions {
  /**
   * Include each package's install location. Off by default — see `WirePackage.paths`: it widens what
   * `scan` transmits, so it is the caller's explicit choice, not a side effect of upgrading.
   */
  installPaths?: boolean;
}

export function buildWirePayload(manifest: Manifest, options: WireOptions = {}): NormalizeResult {
  const withPaths = options.installPaths === true;
  const seen = new Map<string, Set<string>>();
  const wirePackages: WirePackage[] = [];
  // One entry per name+version, as before — but the duplicate entries that used to be dropped outright
  // were the only record of the OTHER install locations, so their paths are collected onto the entry that
  // survives instead of discarded with them.
  const byIdentity = new Map<string, WirePackage>();
  let entriesWithoutPath = 0;

  for (const entry of manifest.packages) {
    const identity = `${entry.name}@${entry.version}`;
    const location = withPaths && entry.path !== undefined && entry.path !== '' ? entry.path : undefined;
    if (location === undefined) entriesWithoutPath++;

    const existing = byIdentity.get(identity);
    if (existing) {
      if (location !== undefined) addPath(existing, location);
      continue;
    }

    const versions = seen.get(entry.name);
    if (versions) {
      versions.add(entry.version);
    } else {
      seen.set(entry.name, new Set([entry.version]));
    }
    const wire: WirePackage = { name: entry.name, version: entry.version };
    if (location !== undefined) addPath(wire, location);
    byIdentity.set(identity, wire);
    wirePackages.push(wire);
  }

  // Sorted so the payload is byte-stable across runs: the scan order follows a lockfile's key order or a
  // filesystem walk, and an unstable list looks to the server like a changed app on every rebuild.
  for (const wire of wirePackages) wire.paths?.sort();

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
    payload: {
      ecosystem: manifest.ecosystem,
      packages: wirePackages,
      // Every entry had a location, so a missing path anywhere means the package is not installed there.
      // One entry without one forfeits that for the whole payload: a consumer reading a short `paths` has
      // no way to tell which entry was the incomplete one.
      //
      // No separate check for "locations were not requested": with them off every entry counts as without
      // one, so this is already false — which is the default, and the safe direction. An explicit
      // `withPaths &&` here was a guard no test could distinguish from its absence.
      installPathsComplete: entriesWithoutPath === 0 && manifest.packages.length > 0,
    },
    stats: {
      uniqueNames: seen.size,
      duplicateNames,
      totalEntries: manifest.packages.length,
    },
  };
}

function addPath(wire: WirePackage, installPath: string): void {
  if (wire.paths === undefined) wire.paths = [installPath];
  else if (!wire.paths.includes(installPath)) wire.paths.push(installPath);
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
    if (aPart === undefined) {
      return -1;
    }
    if (bPart === undefined) {
      return 1;
    }
    const aNum = /^\d+$/.test(aPart);
    const bNum = /^\d+$/.test(bPart);
    if (aNum && bNum) {
      const diff = Number(aPart) - Number(bPart);
      if (diff !== 0) {
        return diff < 0 ? -1 : 1;
      }
      continue;
    }
    if (aNum) {
      return -1;
    }
    if (bNum) {
      return 1;
    }
    if (aPart < bPart) {
      return -1;
    }
    if (aPart > bPart) {
      return 1;
    }
  }
  return 0;
}

export function findPackageInManifest(
  manifest: Manifest,
  name: string,
): PackageEntry[] {
  return manifest.packages.filter((p) => p.name === name);
}
