import test from 'node:test';
import assert from 'node:assert/strict';

import testProfile from '../profiles/test-server.json' with { type: 'json' };
import { validateProfile } from '../src/profile.js';
import { startGatewayHarness } from './fixtures/harness.js';

const ACCESS_LIFETIME_MS = 2 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

async function setup(t, profile = testProfile) {
  const harness = await startGatewayHarness(profile);
  t.after(() => harness.close());
  return harness;
}

function cookieValue(response, name) {
  const entry = response.headers.getSetCookie().find((value) => value.startsWith(name + '='));

  assert.ok(entry, 'Expected Set-Cookie for ' + name);
  return entry.split(';', 1)[0];
}

async function signIn(harness, username = 'alice', password = 'fixture-password') {
  const response = await harness.request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });

  const body = await response.json();

  if (response.status !== 200) {
    return { response, body };
  }

  return {
    response,
    body,
    token: body.accessToken,
    session: cookieValue(response, 'session'),
    refresh: cookieValue(response, 'refresh'),
  };
}

function bearer(token) {
  return { Authorization: 'Bearer ' + token };
}

function cookieHeader(...cookies) {
  return { Cookie: cookies.join('; ') };
}

async function privateRequest(harness, token) {
  return harness.request('/api/private', { headers: bearer(token) });
}

test('test profile is valid and independent of the example application', () => {
  assert.equal(validateProfile(testProfile), testProfile);
  assert.equal(testProfile.id, 'fixture-app');
  assert.equal(testProfile.hostname, 'app.fixture.test');
  assert.equal(
    testProfile.routes.some((rule) => rule.prefix?.includes('/assets/')),
    true,
  );
});

test('real browser login HTML, JS, CSS, SVG and version are publicly accessible', async (t) => {
  const harness = await setup(t);

  const page = await harness.request('/login');
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(page.headers.get('Content-Type'), /text\/html/);
  assert.match(html, /<form.*action="\/auth\/login"/);
  assert.match(html, /\/assets\/app\.js/);
  assert.match(html, /\/assets\/app\.css/);

  const javascript = await harness.request('/assets/app.js?v=1');
  assert.equal(javascript.status, 200);
  assert.match(javascript.headers.get('Content-Type'), /javascript/);
  assert.match(await javascript.text(), /window\.fixtureLogin/);

  const css = await harness.request('/assets/app.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('Content-Type'), /text\/css/);
  assert.match(await css.text(), /font-family/);

  const icon = await harness.request('/assets/icon.svg');
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get('Content-Type'), /image\/svg\+xml/);
  assert.match(await icon.text(), /<svg/);

  const version = await harness.request('/api/version');
  assert.deepEqual(await version.json(), { version: 'fixture-1.0.0' });

  assert.equal(harness.fixture.state.validationRequests, 0);
  assert.equal(harness.storage.statistics.writes, 0);
});

test('private HTML and CSS-looking API paths never become public assets', async (t) => {
  const harness = await setup(t);
  const paths = [
    '/dashboard',
    '/api/private',
    '/api/private.css',
    '/missing.css',
    '/assets/%2Fapi%2Fprivate',
  ];

  for (const path of paths) {
    const response = await harness.request(path);
    assert.equal(response.status, 401, path);
    await response.text();
  }

  assert.equal(harness.fixture.state.protectedRequests, 0);

  const wrongMethod = await harness.request('/assets/app.css', { method: 'POST' });
  assert.equal(wrongMethod.status, 401);
  await wrongMethod.text();
});

test('failed login is forwarded to origin but issues no recognized credential', async (t) => {
  const harness = await setup(t);
  const result = await signIn(harness, 'alice', 'wrong-password');

  assert.equal(result.response.status, 401);
  assert.equal(result.body.error, 'Invalid credentials');
  assert.equal(harness.fixture.state.loginRequests, 1);
  assert.equal(harness.storage.statistics.writes, 0);
  assert.equal((await harness.request('/api/private')).status, 401);
});

test('login sets both session and refresh cookies without gateway modifications', async (t) => {
  const harness = await setup(t);
  const login = await signIn(harness);

  assert.equal(login.response.status, 200);
  assert.equal(login.body.user.id, 'alice');
  assert.equal(typeof login.token, 'string');
  assert.match(login.session, /^session=/);
  assert.match(login.refresh, /^refresh=/);
  assert.equal(login.response.headers.getSetCookie().length, 2);
  assert.equal(harness.fixture.state.validationRequests, 0);
});

test('first valid bearer is verified once, then forwarded from recognition cache', async (t) => {
  const harness = await setup(t);
  const login = await signIn(harness);

  const first = await privateRequest(harness, login.token);
  assert.deepEqual(await first.json(), { secret: 'private-value', userId: 'alice' });

  const second = await privateRequest(harness, login.token);
  assert.equal(second.status, 200);
  await second.text();

  assert.equal(harness.fixture.state.validationRequests, 1);
  assert.equal(harness.fixture.state.protectedRequests, 2);
  assert.equal(harness.storage.statistics.writes, 1);

  for (const key of harness.storage.entries.keys()) {
    assert.equal(key.includes(login.token), false);
  }
});

test('unknown invalid bearer is denied before reaching protected application code', async (t) => {
  const harness = await setup(t);

  const first = await privateRequest(harness, 'invalid-token');
  const second = await privateRequest(harness, 'invalid-token');

  assert.equal(first.status, 401);
  assert.equal(second.status, 401);
  assert.equal(harness.fixture.state.validationRequests, 2);
  assert.equal(harness.fixture.state.protectedRequests, 0);
  assert.equal(harness.storage.statistics.writes, 0);
});

test('browser session cookie is recognized and unrelated cookies are ignored', async (t) => {
  const harness = await setup(t);
  const login = await signIn(harness);

  const headers = cookieHeader('theme=light', login.session, login.refresh);
  const dashboard = await harness.request('/dashboard', { headers });
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /Private dashboard/);

  const privateApi = await harness.request('/api/private', { headers });
  assert.equal(privateApi.status, 200);
  await privateApi.text();

  assert.equal(harness.fixture.state.validationRequests, 1);
  assert.equal(harness.fixture.state.protectedRequests, 2);
  assert.equal(harness.storage.statistics.writes, 1);
});

test('refresh works with only its refresh cookie and rotates tokens', async (t) => {
  const harness = await setup(t);
  const login = await signIn(harness);

  const refreshed = await harness.request('/auth/refresh', {
    method: 'POST',
    headers: cookieHeader(login.refresh),
  });
  assert.equal(refreshed.status, 200);

  const payload = await refreshed.json();
  const nextRefresh = cookieValue(refreshed, 'refresh');

  assert.notEqual(payload.accessToken, login.token);
  assert.notEqual(nextRefresh, login.refresh);
  assert.equal(harness.fixture.state.validationRequests, 0);

  const privateApi = await privateRequest(harness, payload.accessToken);
  assert.equal(privateApi.status, 200);
  await privateApi.text();
  assert.equal(harness.fixture.state.validationRequests, 1);

  const replay = await harness.request('/auth/refresh', {
    method: 'POST',
    headers: cookieHeader(login.refresh),
  });
  assert.equal(replay.status, 401);
  await replay.text();

  assert.equal(harness.fixture.state.refreshRequests, 2);
});

test('recognized expired bearer still reaches origin; refresh restores access', async (t) => {
  const harness = await setup(t);
  const login = await signIn(harness);

  assert.equal((await privateRequest(harness, login.token)).status, 200);
  harness.fixture.advanceTime(ACCESS_LIFETIME_MS + 1);

  const expired = await privateRequest(harness, login.token);
  assert.equal(expired.status, 401);
  assert.equal((await expired.json()).error, 'Authentication required');

  // The gateway does NOT revalidate a known token; the origin rejects it.
  assert.equal(harness.fixture.state.validationRequests, 1);
  assert.equal(harness.fixture.state.protectedRequests, 2);

  const refresh = await harness.request('/auth/refresh', {
    method: 'POST',
    headers: cookieHeader(login.refresh),
  });
  const replacement = await refresh.json();
  assert.equal(refresh.status, 200);

  const restored = await privateRequest(harness, replacement.accessToken);
  assert.equal(restored.status, 200);
  await restored.text();
  assert.equal(harness.fixture.state.validationRequests, 2);
  assert.equal(harness.storage.statistics.writes, 2);
});

test('a never-recognized token that expires is rejected before protected API', async (t) => {
  const harness = await setup(t);
  const login = await signIn(harness);

  harness.fixture.advanceTime(ACCESS_LIFETIME_MS + 1);

  const response = await privateRequest(harness, login.token);
  assert.equal(response.status, 401);
  await response.text();
  assert.equal(harness.fixture.state.validationRequests, 1);
  assert.equal(harness.fixture.state.protectedRequests, 0);
});

test('disabled user keeps historical recognition, but origin denies access', async (t) => {
  const harness = await setup(t);
  const login = await signIn(harness);

  assert.equal((await privateRequest(harness, login.token)).status, 200);
  harness.fixture.state.userDisabled = true;

  const denied = await privateRequest(harness, login.token);
  assert.equal(denied.status, 401);
  await denied.text();
  assert.equal(harness.fixture.state.validationRequests, 1);
  assert.equal(harness.fixture.state.protectedRequests, 2);
});

test('logout revokes both recognized cookie and bearer at the origin', async (t) => {
  const harness = await setup(t);
  const login = await signIn(harness);

  const bearerResponse = await privateRequest(harness, login.token);
  const cookieResponse = await harness.request('/api/private', {
    headers: cookieHeader(login.session),
  });
  assert.equal(bearerResponse.status, 200);
  assert.equal(cookieResponse.status, 200);
  await bearerResponse.text();
  await cookieResponse.text();

  const logout = await harness.request('/auth/logout', {
    method: 'POST',
    headers: { ...bearer(login.token), ...cookieHeader(login.session, login.refresh) },
  });
  assert.equal(logout.status, 204);
  assert.equal(logout.headers.getSetCookie().length, 2);
  assert.equal(
    logout.headers.getSetCookie().every((line) => line.includes('Max-Age=0')),
    true,
  );

  const bearerAfterLogout = await privateRequest(harness, login.token);
  const cookieAfterLogout = await harness.request('/api/private', {
    headers: cookieHeader(login.session),
  });
  assert.equal(bearerAfterLogout.status, 401);
  assert.equal(cookieAfterLogout.status, 401);
  await bearerAfterLogout.text();
  await cookieAfterLogout.text();

  assert.equal(harness.fixture.state.validationRequests, 2);
  assert.equal(harness.fixture.state.protectedRequests, 4);
});

test('recognition expiration forces a new validation instead of permanent access', async (t) => {
  const harness = await setup(t, { ...testProfile, retentionDays: 1 });
  const login = await signIn(harness);

  assert.equal((await privateRequest(harness, login.token)).status, 200);
  harness.fixture.advanceTime(DAY_MS + 1);

  const response = await privateRequest(harness, login.token);
  assert.equal(response.status, 401);
  await response.text();

  assert.equal(harness.fixture.state.validationRequests, 2);
  assert.equal(harness.fixture.state.protectedRequests, 1);
  assert.equal(harness.storage.statistics.writes, 1);
});

test('validator HTTP 200 login HTML does not count as authentication', async (t) => {
  const harness = await setup(t);
  const login = await signIn(harness);
  harness.fixture.state.validationMode = 'login-html';

  const response = await privateRequest(harness, login.token);
  assert.equal(response.status, 401);
  await response.text();

  assert.equal(harness.fixture.state.protectedRequests, 0);
  assert.equal(harness.storage.statistics.writes, 0);
});

test('validator redirects are not followed to a public login page', async (t) => {
  const harness = await setup(t);
  const login = await signIn(harness);
  harness.fixture.state.validationMode = 'redirect';

  const response = await privateRequest(harness, login.token);
  assert.equal(response.status, 401);
  await response.text();

  assert.equal(harness.fixture.state.validationRequests, 1);
  assert.equal(harness.fixture.state.protectedRequests, 0);
  assert.equal(
    harness.fixture.state.observedRequests.some((request) => request.path === '/login'),
    false,
  );
});

test('unavailable validation endpoint fails closed without remembering credential', async (t) => {
  const harness = await setup(t);
  const login = await signIn(harness);
  harness.fixture.state.validationMode = 'unavailable';

  const response = await privateRequest(harness, login.token);
  assert.equal(response.status, 503);
  await response.text();

  assert.equal(harness.fixture.state.validationRequests, 1);
  assert.equal(harness.fixture.state.protectedRequests, 0);
  assert.equal(harness.storage.statistics.writes, 0);
});

test('login and unknown-token rate limiting do not affect recognized tokens', async (t) => {
  const harness = await setup(t);
  harness.controls.loginAllowed = false;

  const blockedLogin = await harness.request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'fixture-password' }),
  });
  assert.equal(blockedLogin.status, 429);
  await blockedLogin.text();
  assert.equal(harness.fixture.state.loginRequests, 0);

  harness.controls.loginAllowed = true;
  const login = await signIn(harness);
  harness.controls.unknownAllowed = false;

  const blockedUnknown = await privateRequest(harness, login.token);
  assert.equal(blockedUnknown.status, 429);
  await blockedUnknown.text();
  assert.equal(harness.fixture.state.validationRequests, 0);

  harness.controls.unknownAllowed = true;
  const accepted = await privateRequest(harness, login.token);
  assert.equal(accepted.status, 200);
  await accepted.text();

  harness.controls.unknownAllowed = false;
  const known = await privateRequest(harness, login.token);
  assert.equal(known.status, 200);
  await known.text();
  assert.equal(harness.fixture.state.validationRequests, 1);
  assert.equal(harness.controls.unknownChecks, 2);
});

test('protected POST body and server-sent events pass through unchanged', async (t) => {
  const harness = await setup(t);
  const login = await signIn(harness);

  const echo = await harness.request('/api/echo', {
    method: 'POST',
    headers: {
      ...bearer(login.token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message: 'hello', items: [1, 2, 3] }),
  });
  assert.equal(echo.status, 200);
  assert.deepEqual(await echo.json(), {
    userId: 'alice',
    body: { message: 'hello', items: [1, 2, 3] },
  });

  const events = await harness.request('/api/events', { headers: bearer(login.token) });
  assert.equal(events.status, 200);
  assert.match(events.headers.get('Content-Type'), /text\/event-stream/);
  assert.equal(await events.text(), 'event: message\ndata: live\n\n');
  assert.equal(harness.fixture.state.validationRequests, 1);
});

test('direct origin bypass is blocked, and client-supplied gateway secret is replaced', async (t) => {
  const harness = await setup(t);

  const direct = await fetch(harness.fixture.baseUrl + '/login');
  assert.equal(direct.status, 403);
  await direct.text();

  const viaGateway = await harness.request('/login', {
    headers: { 'X-CF-Auth-Gateway-Secret': 'forged' },
  });
  assert.equal(viaGateway.status, 200);
  await viaGateway.text();

  assert.equal(harness.fixture.state.originRejections, 1);
  assert.equal(
    harness.fixture.state.observedRequests[0].gatewaySecret,
    harness.environment.ORIGIN_GATEWAY_SECRET,
  );
});

test('an invalid bearer cannot fall back to a valid browser session cookie', async (t) => {
  const harness = await setup(t);
  const login = await signIn(harness);

  const response = await harness.request('/api/private', {
    headers: {
      ...bearer('invalid-bearer'),
      ...cookieHeader(login.session),
    },
  });

  assert.equal(response.status, 401);
  await response.text();
  assert.equal(harness.fixture.state.protectedRequests, 0);
});

test('unlisted OPTIONS preflight stays protected without an explicit route', async (t) => {
  const harness = await setup(t);

  const response = await harness.request('/api/private', {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://untrusted.example',
      'Access-Control-Request-Method': 'GET',
    },
  });

  assert.equal(response.status, 401);
  await response.text();
  assert.equal(harness.fixture.state.protectedRequests, 0);
});
