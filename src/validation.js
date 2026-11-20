/** Validate previously unseen credentials against an application-owned endpoint. */

const MAX_VALIDATION_BODY_BYTES = 16_384;

function createValidationHeaders(credential, environment) {
  const headers = new Headers({ Accept: 'application/json' });

  if (credential.scheme.type === 'bearer') {
    headers.set('Authorization', `Bearer ${credential.value}`);
  } else {
    headers.set('Cookie', `${credential.scheme.name}=${credential.value}`);
  }

  headers.set('X-CF-Auth-Gateway-Secret', environment.ORIGIN_GATEWAY_SECRET);
  return headers;
}

function readIdentity(payload, dottedPath) {
  let current = payload;

  for (const segment of dottedPath.split('.')) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, segment)) {
      return null;
    }

    current = current[segment];
  }

  return typeof current === 'string' && current.trim().length > 0
    ? current
    : null;
}

async function readBoundedJson(response) {
  const declaredLength = response.headers.get('Content-Length');

  if (declaredLength !== null && Number(declaredLength) > MAX_VALIDATION_BODY_BYTES) {
    return null;
  }

  if (!response.body) {
    return null;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    totalBytes += value.byteLength;
    if (totalBytes > MAX_VALIDATION_BODY_BYTES) {
      await reader.cancel();
      return null;
    }

    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/**
 * Return 'valid', 'invalid', or 'unavailable'.
 * - Redirects never count as authentication.
 * - Validation responses must contain the configured nonempty identity field.
 * - Callers never supply the URL or redirect target.
 */
export async function validateCredential(
  credential,
  profile,
  environment,
  origin,
  fetchUpstream,
) {
  const contract = credential.scheme.validation;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), profile.validationTimeoutMs);

  try {
    const response = await fetchUpstream(new URL(contract.path, origin).toString(), {
      method: contract.method,
      headers: createValidationHeaders(credential, environment),
      redirect: 'manual',
      signal: controller.signal,
    });

    if (
      response.status === 401 ||
      response.status === 403 ||
      (response.status >= 300 && response.status < 400)
    ) {
      return 'invalid';
    }

    if (response.status !== 200) {
      return 'unavailable';
    }

    const contentType = response.headers.get('Content-Type') ?? '';
    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
      return 'invalid';
    }

    const payload = await readBoundedJson(response);
    return readIdentity(payload, contract.jsonPath) === null ? 'invalid' : 'valid';
  } catch {
    return 'unavailable';
  } finally {
    clearTimeout(timeout);
  }
}
