import { PatchstackError, type Config } from './types.js';
import { isSafeOrigin } from './protect/safe-origin.js';

/** Require an endpoint that was selected explicitly and can carry network traffic safely. */
export function assertConnectableEndpoint(config: Config, target = config.endpoint): void {
  if (config.endpointTrusted === false) {
    throw new PatchstackError(
      'The custom endpoint in .patchstackrc.json must be confirmed with --endpoint or PATCHSTACK_ENDPOINT before it can be used.',
      'CONFIG_INVALID',
    );
  }
  if (safeRemoteUrl(config.endpoint) === null) {
    throw new PatchstackError(
      'Patchstack endpoints must use HTTPS, except for localhost development endpoints.',
      'CONFIG_INVALID',
    );
  }

  let endpointOrigin: string;
  let targetOrigin: string;
  try {
    endpointOrigin = new URL(config.endpoint).origin;
    targetOrigin = new URL(target).origin;
  } catch (cause) {
    throw new PatchstackError('The configured Patchstack endpoint is not a valid URL.', 'CONFIG_INVALID', cause);
  }
  if (safeRemoteUrl(target) === null || targetOrigin !== endpointOrigin) {
    throw new PatchstackError(
      'A Patchstack request resolved outside the configured endpoint origin.',
      'CONFIG_INVALID',
    );
  }
}

/** Whether a URL can be shown or persisted as a remote link. */
export function safeRemoteUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) return null;
  try {
    const parsed = new URL(value);
    if (!isSafeOrigin(parsed.toString()) || parsed.username !== '' || parsed.password !== '') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/** Keep remote display fields single-line and free of terminal control characters. */
export function safeDisplayString(value: unknown, maxLength = 512): string | null {
  if (typeof value !== 'string') return null;
  const clean = value
    .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length === 0) return null;
  return clean.slice(0, maxLength);
}

export function isCanonicalUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

export function isCredential(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) return false;
  }
  const separator = value.lastIndexOf('-');
  return separator > 0 && separator < value.length - 1 && /^\d+$/.test(value.slice(separator + 1));
}

export function isHeaderValue(value: unknown, maxLength = 8_192): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}
