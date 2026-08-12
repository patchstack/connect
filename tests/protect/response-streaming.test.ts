import { describe, expect, it } from 'vitest';
import { createProtection } from '../../src/protect/runtime.js';

// Response screening buffers the whole body, which would withhold a live stream (SSE / LLM tokens)
// until it ends — breaking incremental streaming. `text/event-stream` responses must pass through
// unbuffered.

describe('response phase — live streams pass through unbuffered', () => {
  it('returns an SSE response immediately without consuming the (never-ending) stream', async () => {
    const p: any = await createProtection({ mode: 'block' }); // default response rules active

    // A stream that emits one event and never closes — modelling a long-lived token stream.
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: hello\n\n'));
        // deliberately never call controller.close()
      },
    });
    const sse = new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });

    // If screening tried to buffer this, it would await `done` forever and this would time out.
    const out: any = await Promise.race([
      p.screenResponse(sse),
      new Promise((r) => setTimeout(() => r('TIMEOUT'), 500)),
    ]);

    expect(out).not.toBe('TIMEOUT'); // returned promptly
    expect(out).toBe(sse); // the ORIGINAL response, untouched (not rebuilt/screened)
  });

  it('still screens a normal (non-stream) text response', async () => {
    const rule = {
      phase: 'response',
      category: 'x',
      action: 'redact',
      rule_v2: [{ parameter: 'response.body', match: { type: 'regex', value: '/topsecret/' } }],
    };
    const p: any = await createProtection({
      rules: { firewall: [], whitelists: [], whitelist_keys: {} },
      responseRules: [rule],
      mode: 'block',
    });
    const out = await p.screenResponse(
      new Response('a topsecret b', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    expect(/topsecret/.test(await out.text())).toBe(false); // non-stream text is still screened
  });
});
