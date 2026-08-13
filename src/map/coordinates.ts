import type { InputField, InputSource } from './types.js';

/**
 * Map an input to the EXACT rule-engine parameter that addresses it, or null with a reason. Verified
 * against the resolver in engine/request.js — a coordinate that the resolver cannot resolve would compile
 * into a rule that silently never matches, which is worse than emitting nothing:
 *   - body / json / form / multipart / server-fn args → `post.<dotted path>` (createServerFnGuard feeds
 *     server-function arguments through as the JSON body, so `post.<field>` resolves them)
 *   - query        → `get.<name>`
 *   - header       → `server.HTTP_<UPPER_SNAKE>`   (resolver lowercases and maps `_` → `-`)
 *   - cookie       → `cookie.<name>`
 *   - file         → `files.<field>`                (`.content` / `.type` / `.filename` are separate)
 *   - route-param  → NONE. The resolver exposes get/post/request/cookie/server/files — NOT `req.params`.
 *   - array path   → NONE. `#getNestedValue` walks own properties, so `tags[].label` needs an
 *                    `array_key_value` rule, not a dotted parameter.
 */
export function runtimeCoordinate(source: InputSource | undefined, path: string): { runtimeParameter: string | null; runtimeParameterReason?: string } {
  if (/\[\d*\]/.test(path)) {
    return { runtimeParameter: null, runtimeParameterReason: 'array traversal: needs an array_key_value rule, not a dotted parameter' };
  }
  switch (source) {
    case 'json-body':
    case 'form-body':
    case 'multipart':
    case 'body':
    case 'server-fn-data':
      return { runtimeParameter: `post.${path}` };
    case 'query':
      return { runtimeParameter: `get.${path}` };
    case 'cookie':
      return { runtimeParameter: `cookie.${path}` };
    case 'file':
      return { runtimeParameter: `files.${path}` };
    case 'header':
      return { runtimeParameter: `server.HTTP_${path.toUpperCase().replace(/-/g, '_')}` };
    case 'route-param':
      return { runtimeParameter: null, runtimeParameterReason: 'route parameters are not exposed by the runtime resolver' };
    default:
      return { runtimeParameter: null, runtimeParameterReason: 'input source could not be determined' };
  }
}

/**
 * The rule-engine NAMESPACE an input lands in (`post`, `get`, `cookie`, `files`, `server`), or null when
 * it has no address. Derived from `runtimeCoordinate` on purpose: comparing raw source labels would call
 * `json-body` and an Express `req.body` read different places when both resolve to `post.*`, and would
 * miss that `post.id` and `get.id` are genuinely different places.
 */
export function namespaceOf(source: InputSource | undefined, path: string): string | null {
  const { runtimeParameter } = runtimeCoordinate(source, path);
  if (!runtimeParameter) return null;
  const dot = runtimeParameter.indexOf('.');
  return dot === -1 ? runtimeParameter : runtimeParameter.slice(0, dot);
}

/** Attach `source` + the runtime coordinate to every extracted input. */
export function withCoordinates(fields: InputField[], source: InputSource): InputField[] {
  return fields.map((f) => ({ ...f, source: f.source ?? source, ...runtimeCoordinate(f.source ?? source, f.name) }));
}
