// The identity used to bind a mapped set of coordinates to the guard that ships with it.
//
// A build-scoped rule addresses a coordinate — a route and a field name — read out of one particular
// build's source. It is only true of that source: rename the field two deploys later and the rule
// addresses something that no longer exists while still reporting as protection. So such a rule may
// only enforce for the guard carrying the map its coordinate came from. The map command derives that
// identity from the policy content it uploads and writes the same value into the bundle the guard imports.
//
// And it does not decide whether two identities match. Presenting an identity is not corroboration:
// the client presents which map it carries, and only the platform can say whether the coordinates it
// holds belong to that map. A guard that treated its own claim as an answer would enforce a stale
// coordinate against source that has changed.
//
// Edge-safe: no `node:` import, static or otherwise, because the protection runtime is bundled for
// runtimes that have no filesystem.

/** The published build-id shape: SHA-256 over the policy-relevant map document. */
const BUILD_ID = /^[0-9a-f]{64}$/i;

/**
 * The canonical form of a build identity, or null when the value is not one.
 *
 * Lowercase hex of a fixed length, for three reasons that all bite: two ends have to compare equal byte
 * for byte, the value is carried in an HTTP header — where a control character makes `Headers` throw
 * and a line break is worse than that — and a cache key built from it must not vary by case.
 *
 * Short values are refused rather than padded: two ends have to compare the complete value.
 */
export function canonicalBuildId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();

  return BUILD_ID.test(trimmed) ? trimmed.toLowerCase() : null;
}

/**
 * The reserved namespace a build stamp lives under, inside the guard's own rules file.
 *
 * Namespaced and versionable on purpose. The file is the app's, its other keys are the rule bundle the
 * engine reads, and anything this package puts there has to be obviously ours and obviously not a rule.
 * A nested object rather than a flat key so a later field can join it without a second reserved name.
 */
export const BUILD_STAMP_KEY = '_patchstack';

/**
 * The identity stamped into a rule bundle, or null when there is none to read.
 *
 * Validated here rather than trusted, and read BEFORE the bundle is normalised — normalising keeps only
 * the keys the engine reads and drops everything else, this one included. A malformed stamp reads as
 * absent, which holds build-scoped rules in dry-run rather than comparing a value nothing could match.
 */
export function readBuildStamp(bundle: unknown): string | null {
  if (bundle === null || typeof bundle !== 'object') return null;
  const namespace = (bundle as Record<string, unknown>)[BUILD_STAMP_KEY];
  if (namespace === null || typeof namespace !== 'object') return null;

  return canonicalBuildId((namespace as Record<string, unknown>).build_id);
}

/** Whether a stamp namespace carries a `build_id` at all, however malformed its value. */
export function hasRawBuildStamp(bundle: unknown): boolean {
  if (bundle === null || typeof bundle !== 'object') return false;
  const namespace = (bundle as Record<string, unknown>)[BUILD_STAMP_KEY];
  if (namespace === null || typeof namespace !== 'object') return false;

  return 'build_id' in (namespace as Record<string, unknown>);
}
