import { describe, it, expect } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

// File-upload content inspection: the engine exposes an upload's DATA
// (files.<name>.content / .type / .filename); WHAT is malicious is expressed entirely in rules.
// These tests show the rule-composed patterns (content signature + declared-type-vs-content
// mismatch) and that bare files.<name> still returns the filename for existing filename rules.

const B = '----PSXBOUNDARY';
function upload(field: string, filename: string, type: string, content: string) {
  const body =
    `--${B}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
    `Content-Type: ${type}\r\n\r\n${content}\r\n--${B}--\r\n`;
  return new Request('https://app.com/upload', {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${B}` },
    body,
  });
}
const mk = (rules: any[]) => createProtection({ mode: 'block', rules: { firewall: rules, whitelists: [], whitelist_keys: {} } as any });
const blocks = async (p: any, req: Request) => (await p.fetch(() => new Response('ok'))(req)).status === 403;

describe('files.<name>.content — signature inspection (pure rule)', () => {
  it('matches a webshell / ImageMagick-MSL signature in the file bytes', async () => {
    const p = await mk([
      { id: 's', rule_v2: [{ parameter: 'files.f.content', match: { type: 'regex', value: '/<\\?php|<\\?=|<(?:read|write|msl)[\\s>]/i' } }] },
    ]);
    expect(await blocks(p, upload('f', 'cat.png', 'image/png', '\x89PNG\r\n<?php system($_GET[0]); ?>'))).toBe(true);
    expect(await blocks(p, upload('f', 'x.jpg', 'image/jpeg', '<?xml version="1.0"?><image><read filename="/etc/passwd"/></image>'))).toBe(true);
    expect(await blocks(p, upload('f', 'cat.png', 'image/png', '\x89PNG a normal image'))).toBe(false);
  });
});

describe('type-vs-content mismatch — composed in a rule, not the engine', () => {
  // "declared image AND content head is markup" — two inclusive (AND) conditions on the exposed data.
  const mismatchRule = {
    id: 'm',
    rule_v2: [
      { parameter: 'rules', rules: [
        { parameter: 'files.f.type', mutations: [], match: { type: 'regex', value: '/^image\\//i' }, inclusive: true },
        { parameter: 'files.f.content', match: { type: 'regex', value: '/^\\s*<[a-z!?]/i' }, inclusive: true },
      ] },
    ],
  };

  it('flags a raster image that is really text/markup (svg-as-png, php-as-png)', async () => {
    const p = await mk([mismatchRule]);
    expect(await blocks(p, upload('f', 'cat.png', 'image/png', '<?php echo 1; ?>'))).toBe(true);
    expect(await blocks(p, upload('f', 'x.png', 'image/png', '<svg><script>alert(1)</script></svg>'))).toBe(true);
  });

  it('does NOT flag a real image (binary head, markup only in metadata) — no false positive', async () => {
    const p = await mk([mismatchRule]);
    // Genuine binary image head; <script> only later in an EXIF/XMP-like text field.
    expect(await blocks(p, upload('f', 'p.jpg', 'image/jpeg', '\xff\xd8\xff\xe1 EXIF <x:xmpmeta><dc:description><script>x</script></dc:description>'))).toBe(false);
    expect(await blocks(p, upload('f', 'ok.png', 'image/png', '\x89PNG normal image bytes'))).toBe(false);
  });
});

describe('backward compatibility', () => {
  it('bare files.<name> still matches the filename', async () => {
    const p = await mk([{ id: 'ext', rule_v2: [{ parameter: 'files.avatar', match: { type: 'contains', value: '.php' } }] }]);
    expect(await blocks(p, upload('avatar', 'shell.php', 'application/octet-stream', 'x'))).toBe(true);
    expect(await blocks(p, upload('avatar', 'ok.png', 'image/png', 'x'))).toBe(false);
  });
  it('exposes .type and .filename as sources', async () => {
    const p = await mk([{ id: 't', rule_v2: [{ parameter: 'files.doc.type', match: { type: 'contains', value: 'application/x-httpd-php' } }] }]);
    expect(await blocks(p, upload('doc', 'a.txt', 'application/x-httpd-php', 'x'))).toBe(true);
  });
});
