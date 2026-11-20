/**
 * Extract only authentication material explicitly described by the app profile.
 * Raw tokens and session cookies are never stored in KV.
 */
const MAX_CREDENTIAL_LENGTH = 8192;
const BEARER_PATTERN = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i;

function extractBearer(request, scheme) {
  const authorization = request.headers.get('Authorization');

  if (authorization === null) {
    return null;
  }

  const match = BEARER_PATTERN.exec(authorization);

  if (!match || match[1].length > MAX_CREDENTIAL_LENGTH) {
    return { error: 'Malformed bearer token' };
  }

  return { scheme, value: match[1] };
}

function extractCookie(request, scheme) {
  const cookieHeader = request.headers.get('Cookie');

  if (!cookieHeader) {
    return null;
  }

  const matches = cookieHeader
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith(`${scheme.name}=`));

  if (matches.length === 0) {
    return null;
  }

  if (matches.length > 1) {
    return { error: 'Duplicate authentication cookie' };
  }

  const value = matches[0].slice(scheme.name.length + 1);

  if (
    !value ||
    value.length > MAX_CREDENTIAL_LENGTH ||
    /[^\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]/.test(value)
  ) {
    return { error: 'Malformed authentication cookie' };
  }

  return { scheme, value };
}

/**
 * Schemes are ordered by precedence. A bearer access token may coexist with
 * a refresh cookie without forcing the gateway to inspect the refresh token.
 */
export function extractCredential(request, profile) {
  const authorization = request.headers.get('Authorization');

  // Never silently fall back to cookies when Authorization is malformed.
  if (authorization !== null && !BEARER_PATTERN.test(authorization)) {
    return { error: 'Unsupported Authorization header' };
  }

  for (const scheme of profile.credentials) {
    const credential =
      scheme.type === 'bearer' ? extractBearer(request, scheme) : extractCookie(request, scheme);

    if (credential !== null) {
      return credential;
    }
  }

  return null;
}

/** Fingerprints are keyed and scoped to the application and profile epoch. */
export async function fingerprintCredential(credential, profile, secret) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('HMAC_SECRET must contain at least 32 characters');
  }

  const encoder = new TextEncoder();
  const signingKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const message = [profile.id, profile.epoch, credential.scheme.id, credential.value].join('\0');

  const signature = await crypto.subtle.sign('HMAC', signingKey, encoder.encode(message));

  const hexDigest = Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

  return `recognized:v1:${profile.id}:${profile.epoch}:${credential.scheme.id}:${hexDigest}`;
}
