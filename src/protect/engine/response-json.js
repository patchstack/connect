export const MAX_RULE_RESPONSE_BYTES = 5 * 1024 * 1024;

/** Parse a JSON response without allowing an endpoint to make the runtime buffer an unbounded body. */
export async function readBoundedJson(response, maxBytes = MAX_RULE_RESPONSE_BYTES) {
  const stated = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(stated) && stated > maxBytes) {
    throw new Error(`rule response exceeds ${maxBytes} bytes`);
  }

  const stream = response.body;
  if (!stream || typeof stream.getReader !== 'function') {
    if (typeof response.text === 'function') {
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > maxBytes) {
        throw new Error(`rule response exceeds ${maxBytes} bytes`);
      }
      return JSON.parse(text);
    }
    throw new Error('rule response body cannot be read with a size bound');
  }

  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new Error(`rule response exceeds ${maxBytes} bytes`);
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
  return JSON.parse(new TextDecoder().decode(bytes));
}
