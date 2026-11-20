const BODY_TIMEOUT_MS = 5000;

// Only flat objects are supported. Inspect structure before JSON.parse so nested
// input and duplicate decoded keys cannot acquire parser-dependent meanings.
function parseFlatJson(text) {
  const keys = new Set();
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      const start = index;
      index += 1;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === '\\') index += 1;
        index += 1;
      }
      let next = index + 1;
      while (/[\t\r\n ]/.test(text[next] ?? '') && next < text.length) next += 1;
      if (text[next] === ':') {
        const key = JSON.parse(text.slice(start, index + 1));
        if (keys.has(key) || ['__proto__', 'constructor', 'prototype'].includes(key))
          throw new Error('Ambiguous JSON key');
        keys.add(key);
      }
    } else if (character === '{') {
      depth += 1;
      if (depth > 1) throw new Error('Nested JSON is unsupported');
    } else if (character === '}') {
      depth -= 1;
    } else if (character === '[') {
      throw new Error('JSON arrays are unsupported');
    }
  }
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected JSON object');
  return value;
}

function validJson(value, schema) {
  if ((schema.required ?? []).some((name) => !Object.hasOwn(value, name))) return false;
  for (const [name, field] of Object.entries(value)) {
    if (typeof field === 'number' && !Number.isFinite(field)) return false;
    const property = Object.hasOwn(schema.properties, name) ? schema.properties[name] : undefined;
    if (!property) {
      if (schema.additionalProperties === false) return false;
      continue;
    }
    let matchesType;
    if (property.type === 'null') {
      matchesType = field === null;
    } else if (property.type === 'integer') {
      matchesType = Number.isSafeInteger(field);
    } else {
      matchesType = field !== null && typeof field === property.type;
    }
    if (!matchesType) return false;
    if (property.maxLength !== undefined && field.length > property.maxLength) return false;
  }
  return true;
}

function failure(status, message) {
  return { status, message };
}

/** Read only contracted public bodies, with bounded memory and read time. */
export async function enforceRequestContract(request, contract) {
  if ((contract.denyHeaders ?? []).some((name) => request.headers.has(name))) {
    return failure(400, 'Forbidden request header');
  }
  if (contract.contentTypes) {
    const type = request.headers.get('Content-Type') ?? '';
    const match = /^([^;\s]+)(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.exec(type);
    if (!match || !contract.contentTypes.includes(match[1].toLowerCase())) {
      return failure(415, 'Unsupported Content-Type');
    }
  }
  if (contract.maxBodyBytes === undefined) return { request };
  const encoding = request.headers.get('Content-Encoding');
  if (encoding && encoding.trim().toLowerCase() !== 'identity') {
    return failure(415, 'Unsupported Content-Encoding');
  }
  const reader = request.body?.getReader();
  const bytes = new Uint8Array(contract.maxBodyBytes);
  let length = 0;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Body timeout')), BODY_TIMEOUT_MS);
  });
  try {
    if (reader) {
      while (true) {
        const { done, value } = await Promise.race([reader.read(), timeout]);
        if (done) break;
        if (length + value.byteLength > contract.maxBodyBytes) {
          void reader.cancel().catch(() => {});
          return failure(413, 'Request body too large');
        }
        bytes.set(value, length);
        length += value.byteLength;
      }
    }
  } catch {
    if (reader) void reader.cancel().catch(() => {});
    return failure(408, 'Request body unavailable or timed out');
  } finally {
    clearTimeout(timer);
  }
  const body = bytes.subarray(0, length);
  if (contract.json) {
    try {
      // Fatal decoding rejects invalid UTF-8; a BOM is not JSON whitespace.
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
      if (!validJson(parseFlatJson(text), contract.json))
        return failure(400, 'Invalid JSON fields');
    } catch {
      return failure(400, 'Invalid JSON body');
    }
  }
  // Reconstruct from the validated bytes, without a tee or JSON serialization.
  const init = { body: request.method === 'GET' || request.method === 'HEAD' ? null : body };
  return { request: new Request(request, init) };
}
