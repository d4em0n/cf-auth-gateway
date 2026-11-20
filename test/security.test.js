import test from 'node:test';
import assert from 'node:assert/strict';
import profile from '../profiles/test-server.json' with { type: 'json' };
import librechat from '../profiles/librechat-v0.8.9.json' with { type: 'json' };
import { createGateway } from '../src/gateway.js';
import { extractCredential, fingerprintCredential } from '../src/credentials.js';
import { matchRoute } from '../src/profile.js';
import { checkRateLimit } from '../src/rate-limit.js';
import { validateCredential } from '../src/validation.js';
import { resolveOrigin } from '../src/origin.js';

const environment = {
  ORIGIN_URL: 'https://origin.fixture.test',
  ORIGIN_GATEWAY_SECRET: 'security-test-origin-secret-at-least-32-characters',
  HMAC_SECRET: 'security-test-hmac-secret-at-least-32-characters',
};
const request = (path, init) => new Request('https://app.fixture.test' + path, init);

for (const path of [
  '/assetsx/app.js',
  '/assets//app.js',
  '/assets/%2fapi/user',
  '/assets/%5capi/user',
  '/assets/%252e%252e/api/user',
  '/api/user.css',
  '/api/auth/login/',
  '/API/auth/login',
]) {
  test('nonpublic path stays protected: ' + path, () => {
    assert.equal(matchRoute(profile, request(path)).access, 'protected');
  });
}

test('URL normalization classifies and forwards the same effective dot-segment path', () => {
  const normalized = request('/assets/%2e%2e/api/private');
  assert.equal(new URL(normalized.url).pathname, '/api/private');
  assert.equal(matchRoute(profile, normalized).access, 'protected');
});

test('method overrides cannot turn an allowed GET into another upstream method', async () => {
  let reached = false;
  const gateway = createGateway(profile, {
    fetchUpstream: async () => {
      reached = true;
      return new Response();
    },
  });
  for (const headers of [{ 'X-HTTP-Method-Override': 'DELETE' }, { 'X-Method-Override': 'POST' }]) {
    assert.equal((await gateway(request('/login', { headers }), environment)).status, 400);
  }
  assert.equal((await gateway(request('/login?_method=DELETE'), environment)).status, 400);
  assert.equal(reached, false);
});

test('oversized bearer, duplicate header and malformed cookie never qualify', () => {
  for (const headers of [
    { Authorization: 'Bearer ' + 'x'.repeat(8193) },
    { Authorization: 'Bearer one, Bearer two' },
    { Cookie: 'session="quoted"' },
    { Cookie: 'session=one, session=two' },
    { Cookie: 'session=has space' },
  ]) {
    assert.ok(extractCredential(request('/api/private', { headers }), profile)?.error);
  }
});

test('HMAC key, app, epoch and scheme rotations all separate registry entries', async () => {
  const credential = { scheme: profile.credentials[0], value: 'same-token' };
  const baseline = await fingerprintCredential(credential, profile, environment.HMAC_SECRET);
  const changes = [
    [credential, { ...profile, id: 'other-app' }, environment.HMAC_SECRET],
    [credential, { ...profile, epoch: 2 }, environment.HMAC_SECRET],
    [{ ...credential, scheme: profile.credentials[1] }, profile, environment.HMAC_SECRET],
    [credential, profile, 'rotated-secret-at-least-32-characters'],
  ];
  for (const args of changes) assert.notEqual(await fingerprintCredential(...args), baseline);
});

test('invalid limiter response is an outage, not a quota decision', async () => {
  const req = request('/auth/login', { headers: { 'CF-Connecting-IP': '192.0.2.1' } });
  const env = { AUTH_FLOW_LIMITER: { limit: async () => ({ success: 'yes' }) } };
  assert.equal(await checkRateLimit(req, env, profile, 'AUTH_FLOW_LIMITER'), 'unavailable');
});

test('validator timeout is unavailable and cannot forward a protected request', async () => {
  const credential = { scheme: profile.credentials[0], value: 'unknown' };
  const result = await validateCredential(
    credential,
    { ...profile, validationTimeoutMs: 100 },
    environment,
    new URL(environment.ORIGIN_URL),
    (_url, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
  );
  assert.equal(result, 'unavailable');
});

test('upstream connection failure is distinct from internal gateway failure', async () => {
  const gateway = createGateway(profile, {
    fetchUpstream: async () => {
      throw new Error('offline');
    },
  });
  assert.equal((await gateway(request('/login'), environment)).status, 502);
  assert.equal((await gateway(request('/login'), {})).status, 503);
});

test('origin config rejects loops, plaintext, credentials, paths and fragments', () => {
  for (const origin of [
    'https://app.fixture.test',
    'http://origin.test',
    'https://user:pass@origin.test',
    'https://origin.test/path',
    'https://origin.test/?target=evil',
    'https://origin.test/#fragment',
  ]) {
    assert.throws(() => resolveOrigin({ ...environment, ORIGIN_URL: origin }, profile));
  }
});

test('LibreChat refresh cookies and Agent API keys are not session JWT validators', () => {
  const req = new Request('https://chat.example.com/api/convos', {
    headers: { Cookie: 'refreshToken=refresh; token_provider=librechat' },
  });
  assert.equal(extractCredential(req, librechat), null);
  assert.deepEqual(
    librechat.credentials.map((scheme) => scheme.validation.path),
    ['/api/user'],
  );
  assert.equal(
    matchRoute(librechat, new Request('https://chat.example.com/api/agents/v1/chat/completions'))
      .access,
    'protected',
  );
  assert.equal(
    matchRoute(librechat, new Request('https://chat.example.com/images/private.png')).access,
    'protected',
  );
});

test('concurrent first-use requests share one validation without a persistent allow cache', async () => {
  const fingerprints = new Map();
  let validations = 0;
  let checks = 0;
  let protectedCalls = 0;
  const env = {
    ...environment,
    RECOGNIZED: {
      get: async (key) => fingerprints.get(key) ?? null,
      put: async (key) => fingerprints.set(key, '1'),
    },
    UNKNOWN_LIMITER: {
      limit: async () => {
        checks++;
        return { success: true };
      },
    },
  };
  const gateway = createGateway(profile, {
    fetchUpstream: async (input, init) => {
      if (init) {
        validations++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return Response.json({ user: { id: 'alice' } });
      }
      protectedCalls++;
      return new Response('protected');
    },
  });
  const run = () =>
    gateway(
      request('/api/private', {
        headers: {
          Authorization: 'Bearer parallel',
          'CF-Connecting-IP': '192.0.2.5',
        },
      }),
      env,
    );
  const responses = await Promise.all(Array.from({ length: 12 }, run));
  assert.ok(responses.every((response) => response.status === 200));
  assert.equal(validations, 1);
  assert.equal(checks, 1);
  assert.equal(protectedCalls, 12);
  fingerprints.clear();
  await run();
  assert.equal(validations, 2);
});

test('plaintext ingress cannot receive login tokens or reach any origin route', async () => {
  let forwarded = false;
  const gateway = createGateway(profile, {
    fetchUpstream: async () => {
      forwarded = true;
      return new Response();
    },
  });
  for (const path of ['/login', '/auth/login', '/api/private']) {
    const response = await gateway(
      new Request('http://app.fixture.test' + path, {
        method: path === '/auth/login' ? 'POST' : 'GET',
      }),
      environment,
    );
    assert.equal(response.status, 400);
    assert.equal(await response.text(), 'HTTPS required');
  }
  assert.equal(forwarded, false);
});
