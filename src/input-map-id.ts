import { createHash } from 'node:crypto';

/** A value outside the input-map identity's cross-language form. */
export class NonCanonicalInputMap extends Error {}

/** A string in the single spelling shared by the map producer and consumer. */
function canonicalString(value: string): string {
  let out = '"';
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (character === '"') out += '\\"';
    else if (character === '\\') out += '\\\\';
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += character;
  }

  return `${out}"`;
}

/**
 * Canonical JSON used by the input-map identity.
 *
 * Objects sort keys as text; arrays retain order; strings escape only quote, backslash and control
 * characters; numbers are safe integers written in decimal. The bound avoids language-specific float
 * and large-integer spellings. Empty objects stay distinct from empty arrays.
 */
function canonicalText(value: unknown): string {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'string') return canonicalString(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new NonCanonicalInputMap('the input map contains a number outside the safe-integer form');
    }

    return String(value === 0 ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalText).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();

    return `{${keys.map((key) => `${canonicalString(key)}:${canonicalText(record[key])}`).join(',')}}`;
  }

  throw new NonCanonicalInputMap(`the input map contains a value with no JSON form (${typeof value})`);
}

/**
 * Identity of the policy-relevant input-map document uploaded by this build.
 *
 * Version 1 is SHA-256 over `patchstack-input-map-v1\0` followed by the canonical JSON form above.
 * The prefix keeps this digest from standing for another document type. Timing and memory observations
 * describe the analyser run, not the coordinates; excluding them keeps identical policy maps identical
 * across builds. Every other field remains in the material.
 */
export function inputMapBuildId(map: unknown): string {
  let material = map;
  if (map !== null && typeof map === 'object' && !Array.isArray(map)) {
    const record = map as Record<string, unknown>;
    const { build_id: _buildId, ...mapDocument } = record;
    const coverage = record.coverage;
    if (coverage !== null && typeof coverage === 'object' && !Array.isArray(coverage)) {
      const { analysisMs: _analysisMs, rssBytes: _rssBytes, peakRssBytes: _peakRssBytes, ...stableCoverage } =
        coverage as Record<string, unknown>;
      material = { ...mapDocument, coverage: stableCoverage };
    } else material = mapDocument;
  }

  return createHash('sha256')
    .update('patchstack-input-map-v1\0', 'utf8')
    .update(canonicalText(material), 'utf8')
    .digest('hex');
}
