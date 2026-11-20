import test from 'node:test';
import assert from 'node:assert/strict';

import exampleProfile from '../profiles/example.json' with { type: 'json' };
import { createGateway } from '../src/gateway.js';
import { extractCredential, fingerprintCredential } from '../src/credentials.js';
import { matchRoute, validateProfile } from '../src/profile.js';

const GATEWAY_HOST = 'https://chat.example.com';

function createEnvironment(overrides = {}) {
  const fingerprints = new Map();
  const controls = { loginAllowed: true, unknownAllowed: true, fingerprints };

  const environment = {
    ORIGIN_URL: 'https://origin.example.net/',
    ORIGIN_GATEWAY_SECRET: 'test-origin-secret-with-at-least-32-characters',
    HMAC_SECRET: 'test-fingerprint-secret-with-at-least-32-characters',
    RECOGNIZED: {
      async get(key) {
        return fingerprints.get(key) ?? null;
      },
      async put(key, value) {
        fingerprints.set(key, value);
      },
    },
    AUTH_FLOW_LIMITER: {
      async limit() {
        return { success: controls.loginAllowed };
      },
    },
    UNKNOWN_LIMITER: {
      async limit() {
        return { success: controls.unknownAllowed };
      },
    },
    ...overrides,
  };

  return { environment, controls };
}

function makeRequest(path, { method = 'GET', headers = {}, body } = {}) {
  return new Request(`${GATEWAY_HOST}${path}`, {
    method,
    headers: {
      'CF-Connecting-IP': '203.0.113.9',
      ...headers,
    },
    body,
  });
}

function createBackend() {
  const state = {
    validTokens: new Set(['good-token', 'another-token']),
    validations: 0,
    requests: [],
  };

  async function fetchUpstream(request, init) {
    const url = request instanceof Request ? new URL(request.url) : new URL(request);
    const headers = init?.headers ?? request.headers;
    const method = init?.method ?? request.method;

    state.requests.push({
      path: url.pathname,
      method,
      authorization: headers.get('Authorization'),
      cookie: headers.get('Cookie'),
    });

    if (url.pathname === '/api/auth/me' || url.pathname === '/api/auth/session') {
      state.validations += 1;

      const bearer = headers.get('Authorization');
      const bearerToken = bearer?.startsWith('Bearer ') ? bearer.slice(7) : null;
      const isValidBearer = bearerToken !== null && state.validTokens.has(bearerToken);
      const isValidCookie = headers.get('Cookie') === 'session=good-session';

      if (isValidBearer || isValidCookie) {
        return Response.json({ user: { id: 'alice' } });
      }

      return Response.json({ error: 'invalid session' }, { status: 401 });
    }

    return Response.json({ servedBy: 'backend' });
  }

  return { state, fetchUpstream };
}

function createTestGateway(options = {}) {
  const { environment, controls } = createEnvironment(options.environment);
  const backend = createBackend();
  const gateway = createGateway(options.profile ?? exampleProfile, {
    fetchUpstream: options.fetchUpstream ?? backend.fetchUpstream,
  });

  return { environment, controls, backend, gateway };
}

test('public routes match only explicitly permitted method and path', () => {
  assert.equal(matchRoute(exampleProfile, makeRequest('/login')).access, 'public');
  assert.equal(matchRoute(exampleProfile, makeRequest('/assets/app.js?v=1')).access, 'public');
  assert.equal(matchRoute(exampleProfile, makeRequest('/private.js')).access, 'protected');
  assert.equal(
    matchRoute(exampleProfile, makeRequest('/assets/private%2Ffile')).access,
    'protected',
  );
  assert.equal(matchRoute(exampleProfile, makeRequest('/api/auth/login')).access, 'protected');
  assert.equal(
    matchRoute(exampleProfile, makeRequest('/api/auth/login', { method: 'POST' })).access,
    'auth_flow',
  );
});

test('profiles reject broad public prefixes and unrecognized properties', () => {
  assert.throws(() =>
    validateProfile({
      ...exampleProfile,
      routes: [{ access: 'public', methods: ['GET'], prefix: ['/'] }],
    }),
  );

  assert.throws(() => validateProfile({ ...exampleProfile, unexpected: true }));
});

test('profiles reject rate limit configuration on public resources', () => {
  assert.throws(() =>
    validateProfile({
      ...exampleProfile,
      routes: [{ access: 'public', methods: ['GET'], exact: ['/'], rateLimit: true }],
    }),
  );
});

test('public HTML and assets are accessible without authentication', async () => {
  const { gateway, environment, backend } = createTestGateway();
  const response = await gateway(makeRequest('/login'), environment);

  assert.equal(response.status, 200);
  assert.equal(backend.state.validations, 0);
});

test('missing credentials do not reach protected routes', async () => {
  const { gateway, environment, backend } = createTestGateway();
  const response = await gateway(makeRequest('/api/private'), environment);

  assert.equal(response.status, 401);
  assert.equal(backend.state.requests.length, 0);
});

test('first valid token is checked once then recognized', async () => {
  const { gateway, environment, backend } = createTestGateway();
  const request = makeRequest('/api/private', {
    headers: { Authorization: 'Bearer good-token' },
  });

  assert.equal((await gateway(request, environment)).status, 200);
  assert.equal(backend.state.validations, 1);

  backend.state.validTokens.clear();
  assert.equal((await gateway(request, environment)).status, 200);
  assert.equal(backend.state.validations, 1);
});

test('unrecognized invalid tokens are rejected before reaching protected routes', async () => {
  const { gateway, environment, backend } = createTestGateway();
  const response = await gateway(
    makeRequest('/api/private', {
      headers: { Authorization: 'Bearer invalid-token' },
    }),
    environment,
  );

  assert.equal(response.status, 401);
  assert.equal(backend.state.validations, 1);
  assert.equal(
    backend.state.requests.some(({ path }) => path === '/api/private'),
    false,
  );
});

test('named session cookie can authenticate without storing raw cookie value', async () => {
  const { gateway, environment, controls } = createTestGateway();
  const response = await gateway(
    makeRequest('/api/private', {
      headers: { Cookie: 'theme=dark; session=good-session' },
    }),
    environment,
  );

  assert.equal(response.status, 200);
  for (const key of controls.fingerprints.keys()) {
    assert.equal(key.includes('good-session'), false);
  }
});

test('bearer takes precedence over a refresh cookie by profile order', () => {
  const credential = extractCredential(
    makeRequest('/api/private', {
      headers: {
        Authorization: 'Bearer good-token',
        Cookie: 'session=good-session',
      },
    }),
    exampleProfile,
  );

  assert.equal(credential.scheme.id, 'bearer');
});

test('malformed Authorization headers never fall back to cookies', async () => {
  const { gateway, environment, backend } = createTestGateway();
  const response = await gateway(
    makeRequest('/api/private', {
      headers: {
        Authorization: 'Basic something',
        Cookie: 'session=good-session',
      },
    }),
    environment,
  );

  assert.equal(response.status, 401);
  assert.equal(backend.state.validations, 0);
});

test('duplicate authentication cookies are rejected', async () => {
  const { gateway, environment } = createTestGateway();
  const response = await gateway(
    makeRequest('/api/private', {
      headers: { Cookie: 'session=good-session; session=other' },
    }),
    environment,
  );

  assert.equal(response.status, 401);
});

test('HMAC fingerprints hide tokens and change with profile epoch', async () => {
  const credential = { scheme: exampleProfile.credentials[0], value: 'good-token' };
  const secret = 'test-fingerprint-secret-with-at-least-32-characters';
  const first = await fingerprintCredential(credential, exampleProfile, secret);
  const second = await fingerprintCredential(credential, { ...exampleProfile, epoch: 2 }, secret);

  assert.equal(first.includes('good-token'), false);
  assert.notEqual(first, second);
});

test('authentication route limiter prevents excessive login attempts', async () => {
  const { gateway, environment, controls, backend } = createTestGateway();
  controls.loginAllowed = false;

  const response = await gateway(makeRequest('/api/auth/login', { method: 'POST' }), environment);

  assert.equal(response.status, 429);
  assert.equal(backend.state.requests.length, 0);
});

test('unknown token rate limiter runs before origin validation', async () => {
  const { gateway, environment, controls, backend } = createTestGateway();
  controls.unknownAllowed = false;

  const response = await gateway(
    makeRequest('/api/private', {
      headers: { Authorization: 'Bearer good-token' },
    }),
    environment,
  );

  assert.equal(response.status, 429);
  assert.equal(backend.state.requests.length, 0);
});

test('missing rate limiter fails closed for unrecognized credentials', async () => {
  const { gateway, environment } = createTestGateway({
    environment: { UNKNOWN_LIMITER: undefined },
  });

  const response = await gateway(
    makeRequest('/api/private', {
      headers: { Authorization: 'Bearer good-token' },
    }),
    environment,
  );

  assert.equal(response.status, 503);
});

test('missing private origin verification secret fails closed for public pages', async () => {
  const { gateway, environment } = createTestGateway({
    environment: { ORIGIN_GATEWAY_SECRET: undefined },
  });

  assert.equal((await gateway(makeRequest('/login'), environment)).status, 503);
});

test('KV outage causes fresh origin validation, not an authentication bypass', async () => {
  const { gateway, environment, backend } = createTestGateway({
    environment: {
      RECOGNIZED: {
        async get() {
          throw new Error('Simulated KV outage');
        },
        async put() {
          throw new Error('Simulated KV outage');
        },
      },
    },
  });

  const response = await gateway(
    makeRequest('/api/private', {
      headers: { Authorization: 'Bearer good-token' },
    }),
    environment,
  );

  assert.equal(response.status, 200);
  assert.equal(backend.state.validations, 1);
});

test('validator does not follow redirects to a login page', async () => {
  const { gateway, environment } = createTestGateway({
    fetchUpstream: async (request, init) => {
      if (init) {
        return new Response(null, {
          status: 302,
          headers: { Location: '/login' },
        });
      }

      throw new Error('Protected upstream request should never run');
    },
  });

  const response = await gateway(
    makeRequest('/api/private', {
      headers: { Authorization: 'Bearer good-token' },
    }),
    environment,
  );

  assert.equal(response.status, 401);
});

test('validator does not accept HTTP 200 HTML login pages', async () => {
  const { gateway, environment } = createTestGateway({
    fetchUpstream: async () =>
      new Response('<html>Login</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
  });

  const response = await gateway(
    makeRequest('/api/private', {
      headers: { Authorization: 'Bearer good-token' },
    }),
    environment,
  );

  assert.equal(response.status, 401);
});

test('validator rejects responses larger than its size limit', async () => {
  const { gateway, environment } = createTestGateway({
    fetchUpstream: async () => Response.json({ user: { id: 'a'.repeat(20_000) } }),
  });

  const response = await gateway(
    makeRequest('/api/private', {
      headers: { Authorization: 'Bearer good-token' },
    }),
    environment,
  );

  assert.equal(response.status, 401);
});

test('POST body and cookies pass through login unchanged', async () => {
  const { environment } = createTestGateway();
  const upstream = { body: null, cookie: null, secret: null };

  const gateway = createGateway(exampleProfile, {
    fetchUpstream: async (request) => {
      upstream.body = await request.text();
      upstream.cookie = request.headers.get('Cookie');
      upstream.secret = request.headers.get('X-CF-Auth-Gateway-Secret');
      return Response.json({ login: 'ok' });
    },
  });

  const response = await gateway(
    makeRequest('/api/auth/login', {
      method: 'POST',
      headers: {
        Cookie: 'csrf=token',
        'X-CF-Auth-Gateway-Secret': 'forged-client-value',
      },
      body: 'username=alice',
    }),
    environment,
  );

  assert.equal(response.status, 200);
  assert.equal(upstream.body, 'username=alice');
  assert.equal(upstream.cookie, 'csrf=token');
  assert.equal(upstream.secret, environment.ORIGIN_GATEWAY_SECRET);
});

test('WebSocket proxy returns the actual upstream 101 response', async () => {
  const { environment, controls } = createTestGateway();
  const upgradedResponse = { status: 101, webSocket: { connected: true } };

  const gateway = createGateway(exampleProfile, {
    fetchUpstream: async (_request, init) => {
      if (init) {
        return Response.json({ user: { id: 'alice' } });
      }

      return upgradedResponse;
    },
  });

  const response = await gateway(
    makeRequest('/api/socket', {
      headers: {
        Upgrade: 'websocket',
        Authorization: 'Bearer good-token',
      },
    }),
    environment,
  );

  assert.equal(response, upgradedResponse);
  assert.equal(controls.fingerprints.size, 1);
});

test('WebSocket upgrades are never public just because assets are public', async () => {
  const { gateway, environment, backend } = createTestGateway();

  const response = await gateway(
    makeRequest('/assets/app.js', {
      headers: { Upgrade: 'websocket' },
    }),
    environment,
  );

  assert.equal(response.status, 401);
  assert.equal(backend.state.requests.length, 0);
});

test('unexpected upgrade protocols are blocked', async () => {
  const { gateway, environment } = createTestGateway();
  const response = await gateway(
    makeRequest('/login', {
      headers: { Upgrade: 'h2c' },
    }),
    environment,
  );

  assert.equal(response.status, 400);
});

test('hostname must match the selected application profile', async () => {
  const { gateway, environment } = createTestGateway();
  const response = await gateway(new Request('https://another.example.com/login'), environment);

  assert.equal(response.status, 421);
});
