import { createHash } from 'node:crypto';

import type { WirePackage } from './normalize.js';

/**
 * Fingerprint of a manifest's package set, byte-for-byte identical to the
 * checksum Patchstack stores server-side (PulseController::storeManifest): the
 * first 12 hex chars of sha256 over the JSON of the packages sorted by
 * `[name, version]` with plain lexicographic (byte) ordering.
 *
 * This mirrors PHP's `usort(..., fn($a,$b) => [$a['name'],$a['version']] <=> ...)`
 * followed by `json_encode(..., JSON_UNESCAPED_SLASHES)`. Two deliberate details:
 *
 *  - The sort is lexicographic, NOT the semver-aware ordering `buildWirePayload`
 *    uses for display. The server re-sorts lexicographically before hashing, so
 *    the fingerprint must too (e.g. `1.10.0` sorts before `1.9.0`).
 *  - npm/composer package names and versions are ASCII, so JS `JSON.stringify`
 *    and PHP `json_encode` produce identical bytes (no unicode escaping, and
 *    neither escapes `/`, so scoped names like `@babel/core` match).
 *
 * Injected into built HTML by `mark-build` and reported by the disclosure widget
 * so Patchstack can compare the live build against the last reported manifest.
 */
export function computeManifestChecksum(packages: WirePackage[]): string {
  const canonical = packages
    .map((pkg) => ({ name: pkg.name, version: pkg.version }))
    .sort((a, b) => {
      if (a.name !== b.name) {
        return a.name < b.name ? -1 : 1;
      }
      if (a.version !== b.version) {
        return a.version < b.version ? -1 : 1;
      }
      return 0;
    });

  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 12);
}
