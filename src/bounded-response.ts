export const MAX_CONTROL_RESPONSE_BYTES = 256 * 1024;

/** Read a Fetch response without buffering more than the caller's stated limit. */
export async function readBoundedText(
  response: Response,
  maxBytes = MAX_CONTROL_RESPONSE_BYTES,
): Promise<string> {
  const stated = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(stated) && stated > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw new Error(`response exceeds ${maxBytes} bytes`);
  }

  const stream = response.body;
  if (stream === null || typeof stream.getReader !== 'function') {
    if (stated === 0) return '';
    throw new Error('response body cannot be read with a size bound');
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new Error(`response exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function readBoundedJson(
  response: Response,
  maxBytes = MAX_CONTROL_RESPONSE_BYTES,
): Promise<unknown> {
  const text = await readBoundedText(response, maxBytes);
  return JSON.parse(text);
}
