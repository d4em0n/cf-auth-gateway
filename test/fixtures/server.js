import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const ACCESS_LIFETIME_MS = 2 * 60 * 1000;
const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

const LOGIN_HTML = [
  '<!doctype html>',
  '<html lang="en"><head><title>Fixture Login</title>',
  '<link rel="stylesheet" href="/assets/app.css">',
  '<script src="/assets/app.js" defer></script></head>',
  '<body><h1>Sign in</h1><form action="/auth/login" method="post">',
  '<input name="username"><input name="password" type="password">',
  '<button type="submit">Log in</button></form></body></html>',
].join('\n');

const APP_JS = [
  'window.fixtureLogin = async function (username, password) {',
  "  const response = await fetch('/auth/login', {",
  "    method: 'POST',",
  "    headers: { 'Content-Type': 'application/json' },",
  '    body: JSON.stringify({ username, password }),',
  '  });',
  '  return response.json();',
  '};',
].join('\n');

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(JSON.stringify(value));
}

function sendText(response, contentType, value) {
  response.writeHead(200, { 'Content-Type': contentType });
  response.end(value);
}

async function readJson(request) {
  let body = '';

  for await (const chunk of request) {
    body += chunk.toString('utf8');

    if (body.length > 16_384) {
      throw new Error('Request body too large');
    }
  }

  return JSON.parse(body);
}

function parseCookies(header = '') {
  const cookies = new Map();

  for (const item of header.split(';')) {
    const separator = item.indexOf('=');

    if (separator >= 1) {
      cookies.set(item.slice(0, separator).trim(), item.slice(separator + 1).trim());
    }
  }

  return cookies;
}

function sessionCookie(name, value, path = '/') {
  return name + '=' + value + '; Path=' + path + '; HttpOnly; Secure; SameSite=Lax';
}

function issueToken(store, state, duration) {
  const token = randomUUID();
  store.set(token, { userId: 'alice', expiresAt: state.now + duration });
  return token;
}

function identityFor(store, token, state) {
  if (!token || state.userDisabled) {
    return null;
  }

  const entry = store.get(token);
  return entry && entry.expiresAt > state.now ? entry.userId : null;
}

function bearerToken(request) {
  const authorization = request.headers.authorization;
  return authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
}

function authenticatedUser(request, state) {
  if (request.headers.authorization) {
    return identityFor(state.accessTokens, bearerToken(request), state);
  }

  const cookies = parseCookies(request.headers.cookie);
  return identityFor(state.sessions, cookies.get('session'), state);
}

export async function startFixtureServer({ gatewaySecret }) {
  const state = {
    now: Date.now(),
    userDisabled: false,
    validationMode: 'normal',
    accessTokens: new Map(),
    refreshTokens: new Map(),
    sessions: new Map(),
    loginRequests: 0,
    refreshRequests: 0,
    validationRequests: 0,
    protectedRequests: 0,
    originRejections: 0,
    observedRequests: [],
  };

  const server = createServer(async (request, response) => {
    try {
      if (request.headers['x-cf-auth-gateway-secret'] !== gatewaySecret) {
        state.originRejections += 1;
        sendJson(response, 403, { error: 'Origin gateway credential required' });
        return;
      }

      const path = new URL(request.url, 'http://fixture.invalid').pathname;
      const method = request.method;

      state.observedRequests.push({
        method,
        path,
        authorization: request.headers.authorization ?? null,
        cookie: request.headers.cookie ?? null,
        gatewaySecret: request.headers['x-cf-auth-gateway-secret'],
      });

      if (method === 'GET' && (path === '/' || path === '/login')) {
        sendText(response, 'text/html; charset=utf-8', LOGIN_HTML);
        return;
      }

      if (method === 'GET' && path === '/assets/app.js') {
        sendText(response, 'text/javascript; charset=utf-8', APP_JS);
        return;
      }

      if (method === 'GET' && path === '/assets/app.css') {
        sendText(response, 'text/css; charset=utf-8', 'body { font-family: system-ui; }');
        return;
      }

      if (method === 'GET' && path === '/assets/icon.svg') {
        sendText(response, 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"/>');
        return;
      }

      if (method === 'GET' && path === '/api/version') {
        sendJson(response, 200, { version: 'fixture-1.0.0' });
        return;
      }

      if (method === 'POST' && path === '/auth/login') {
        state.loginRequests += 1;
        const credentials = await readJson(request);

        if (
          credentials.username !== 'alice' ||
          credentials.password !== 'fixture-password' ||
          state.userDisabled
        ) {
          sendJson(response, 401, { error: 'Invalid credentials' });
          return;
        }

        const accessToken = issueToken(state.accessTokens, state, ACCESS_LIFETIME_MS);
        const refreshToken = issueToken(state.refreshTokens, state, SESSION_LIFETIME_MS);
        const session = issueToken(state.sessions, state, SESSION_LIFETIME_MS);

        sendJson(response, 200, {
          user: { id: 'alice' },
          accessToken,
          expiresInSeconds: ACCESS_LIFETIME_MS / 1000,
        }, {
          'Set-Cookie': [
            sessionCookie('session', session),
            sessionCookie('refresh', refreshToken, '/auth/refresh'),
          ],
        });
        return;
      }

      if (method === 'POST' && path === '/auth/refresh') {
        state.refreshRequests += 1;
        const cookies = parseCookies(request.headers.cookie);
        const oldToken = cookies.get('refresh');
        const userId = identityFor(state.refreshTokens, oldToken, state);

        if (!userId) {
          sendJson(response, 401, { error: 'Invalid refresh token' });
          return;
        }

        state.refreshTokens.delete(oldToken);
        const refreshToken = issueToken(state.refreshTokens, state, SESSION_LIFETIME_MS);
        const accessToken = issueToken(state.accessTokens, state, ACCESS_LIFETIME_MS);

        sendJson(response, 200, { user: { id: userId }, accessToken }, {
          'Set-Cookie': sessionCookie('refresh', refreshToken, '/auth/refresh'),
        });
        return;
      }

      if (method === 'POST' && path === '/auth/logout') {
        const cookies = parseCookies(request.headers.cookie);
        state.sessions.delete(cookies.get('session'));
        state.refreshTokens.delete(cookies.get('refresh'));
        state.accessTokens.delete(bearerToken(request));

        response.writeHead(204, {
          'Set-Cookie': [
            sessionCookie('session', '') + '; Max-Age=0',
            sessionCookie('refresh', '', '/auth/refresh') + '; Max-Age=0',
          ],
        });
        response.end();
        return;
      }

      if (method === 'GET' && (path === '/auth/whoami' || path === '/auth/session')) {
        state.validationRequests += 1;

        if (state.validationMode === 'login-html') {
          sendText(response, 'text/html', LOGIN_HTML);
          return;
        }

        if (state.validationMode === 'redirect') {
          response.writeHead(302, { Location: '/login' });
          response.end();
          return;
        }

        if (state.validationMode === 'unavailable') {
          sendJson(response, 503, { error: 'Validator unavailable' });
          return;
        }

        const cookies = parseCookies(request.headers.cookie);
        const userId = path === '/auth/whoami'
          ? identityFor(state.accessTokens, bearerToken(request), state)
          : identityFor(state.sessions, cookies.get('session'), state);

        if (!userId) {
          sendJson(response, 401, { error: 'Invalid token or session' });
          return;
        }

        sendJson(response, 200, { user: { id: userId } });
        return;
      }

      const isProtected = [
        '/api/private',
        '/api/private.css',
        '/dashboard',
        '/api/echo',
        '/api/events',
      ].includes(path);

      if (isProtected) {
        state.protectedRequests += 1;
        const userId = authenticatedUser(request, state);

        if (!userId) {
          sendJson(response, 401, { error: 'Authentication required' });
          return;
        }

        if (method === 'GET' && path === '/api/private') {
          sendJson(response, 200, { secret: 'private-value', userId });
          return;
        }

        if (method === 'GET' && path === '/api/private.css') {
          sendText(response, 'text/css', '.secret { color: red; }');
          return;
        }

        if (method === 'GET' && path === '/dashboard') {
          sendText(response, 'text/html', '<h1>Private dashboard</h1>');
          return;
        }

        if (method === 'POST' && path === '/api/echo') {
          const body = await readJson(request);
          sendJson(response, 200, { userId, body });
          return;
        }

        if (method === 'GET' && path === '/api/events') {
          response.writeHead(200, { 'Content-Type': 'text/event-stream' });
          response.write('event: message\n');
          response.end('data: live\n\n');
          return;
        }
      }

      sendJson(response, 404, { error: 'Not found' });
    } catch {
      sendJson(response, 400, { error: 'Invalid fixture request' });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    state,
    baseUrl: 'http://127.0.0.1:' + server.address().port,
    advanceTime(milliseconds) {
      state.now += milliseconds;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}
