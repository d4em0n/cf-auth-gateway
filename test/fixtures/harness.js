import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { createGateway } from '../../src/gateway.js';
import { startFixtureServer } from './server.js';

const GATEWAY_SECRET = 'fixture-gateway-secret-with-at-least-32-chars';
const FINGERPRINT_SECRET = 'fixture-fingerprint-secret-with-at-least-32-chars';
const TEST_UPSTREAM_HOST = 'origin.fixture.test';

function createMemoryStorage(fixture) {
  const entries = new Map();
  const statistics = { reads: 0, writes: 0 };

  const binding = {
    async get(key) {
      statistics.reads += 1;
      const entry = entries.get(key);

      if (!entry) {
        return null;
      }

      if (fixture.state.now >= entry.expiresAt) {
        entries.delete(key);
        return null;
      }

      return entry.value;
    },

    async put(key, value, { expirationTtl }) {
      statistics.writes += 1;
      entries.set(key, {
        value,
        expiresAt: fixture.state.now + expirationTtl * 1000,
      });
    },
  };

  return { binding, entries, statistics };
}

/**
 * Test-only transport: retain the Worker's configured HTTPS hostname while
 * physically connecting to a local ephemeral HTTP origin. Production Worker
 * code never learns the localhost address.
 */
function createUpstreamTransport(fixture) {
  return async function fetchUpstream(input, options) {
    const originalUrl = new URL(input instanceof Request ? input.url : input);

    if (originalUrl.protocol !== 'https:' || originalUrl.hostname !== TEST_UPSTREAM_HOST) {
      throw new Error('Unexpected upstream destination in integration test');
    }

    const target = new URL(originalUrl.pathname + originalUrl.search, fixture.baseUrl);

    if (!(input instanceof Request)) {
      return fetch(target, { ...options, redirect: 'manual' });
    }

    const headers = new Headers(input.headers);
    headers.delete('Host');
    headers.delete('Connection');
    headers.delete('Transfer-Encoding');
    headers.delete('Content-Length');

    const initialization = {
      method: input.method,
      headers,
      redirect: 'manual',
    };

    if (input.method !== 'GET' && input.method !== 'HEAD') {
      initialization.body = input.body;
      initialization.duplex = 'half';
    }

    return fetch(new Request(target, initialization));
  };
}

function requestHeaders(incoming) {
  const headers = new Headers();

  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined || ['host', 'connection', 'cf-connecting-ip'].includes(name)) {
      continue;
    }

    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }

  // Pretend the request entered via Cloudflare. Do not trust a client-sent IP.
  headers.set('CF-Connecting-IP', '198.51.100.42');
  return headers;
}

async function handleGatewayHttp(incoming, outgoing, gateway, environment, hostname) {
  try {
    const requestUrl = 'https://' + hostname + incoming.url;
    const initialization = {
      method: incoming.method,
      headers: requestHeaders(incoming),
    };

    if (incoming.method !== 'GET' && incoming.method !== 'HEAD') {
      initialization.body = Readable.toWeb(incoming);
      initialization.duplex = 'half';
    }

    const workerRequest = new Request(requestUrl, initialization);
    const workerResponse = await gateway(workerRequest, environment);

    outgoing.statusCode = workerResponse.status;

    for (const [name, value] of workerResponse.headers.entries()) {
      if (name.toLowerCase() !== 'set-cookie') {
        outgoing.setHeader(name, value);
      }
    }

    const cookies = workerResponse.headers.getSetCookie();
    if (cookies.length > 0) {
      outgoing.setHeader('Set-Cookie', cookies);
    }

    if (!workerResponse.body || incoming.method === 'HEAD') {
      outgoing.end();
    } else {
      await pipeline(Readable.fromWeb(workerResponse.body), outgoing);
    }
  } catch {
    if (!outgoing.headersSent) {
      outgoing.writeHead(502, { 'Content-Type': 'text/plain' });
    }

    outgoing.end('Test gateway transport failure');
  }
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  return 'http://127.0.0.1:' + server.address().port;
}

async function closeServer(server) {
  server.closeAllConnections();

  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Two real HTTP servers:
 * client fetch -> local gateway listener -> Worker engine -> local fixture app.
 */
export async function startGatewayHarness(profile) {
  const fixture = await startFixtureServer({ gatewaySecret: GATEWAY_SECRET });
  const storage = createMemoryStorage(fixture);
  const controls = {
    loginAllowed: true,
    unknownAllowed: true,
    loginChecks: 0,
    unknownChecks: 0,
  };

  const environment = {
    ORIGIN_URL: 'https://' + TEST_UPSTREAM_HOST + '/',
    ORIGIN_GATEWAY_SECRET: GATEWAY_SECRET,
    HMAC_SECRET: FINGERPRINT_SECRET,
    RECOGNIZED: storage.binding,
    AUTH_FLOW_LIMITER: {
      async limit() {
        controls.loginChecks += 1;
        return { success: controls.loginAllowed };
      },
    },
    UNKNOWN_LIMITER: {
      async limit() {
        controls.unknownChecks += 1;
        return { success: controls.unknownAllowed };
      },
    },
  };

  const gateway = createGateway(profile, {
    fetchUpstream: createUpstreamTransport(fixture),
  });

  const gatewayServer = createServer((incoming, outgoing) => {
    void handleGatewayHttp(incoming, outgoing, gateway, environment, profile.hostname);
  });

  try {
    const gatewayUrl = await listen(gatewayServer);

    return {
      fixture,
      storage,
      controls,
      environment,
      gatewayUrl,
      request(path, options = {}) {
        return fetch(gatewayUrl + path, { redirect: 'manual', ...options });
      },
      async close() {
        await closeServer(gatewayServer);
        await fixture.close();
      },
    };
  } catch (error) {
    await fixture.close();
    throw error;
  }
}
