import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import WebSocket from 'ws';
import { runtimeGateway } from './harness.js';

const origin = await readFile(new URL('./origin.js', import.meta.url), 'utf8');

async function setup(t) {
  const runtime = await runtimeGateway(origin);
  t.after(() => runtime.dispose());
  const request = (path, init = {}) =>
    runtime.dispatchFetch('https://app.fixture.test' + path, {
      ...init,
      headers: { 'CF-Connecting-IP': '192.0.2.5', ...init.headers },
    });
  return { runtime, request };
}

const authorized = { Authorization: 'Bearer good' };

test('workerd preserves redirects, separate cookies and compressed bytes', async (t) => {
  const { request } = await setup(t);
  const login = await request('/auth/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'fixture-password' }),
  });
  assert.equal(login.status, 302);
  assert.equal(login.headers.get('Location'), 'https://app.fixture.test/login');
  assert.equal(login.headers.getSetCookie().length, 2);
  const compressed = await request('/assets/compressed');
  assert.equal(await compressed.text(), 'compressed response');
});

test('workerd streams a file body and SSE without waiting for stream completion', async (t) => {
  const { request } = await setup(t);
  const bytes = crypto.getRandomValues(new Uint8Array(65536));
  const response = await request('/api/echo', { method: 'POST', headers: authorized, body: bytes });
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  const events = await request('/api/events', { headers: authorized });
  const reader = events.body.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), 'event: message\ndata: first\n\n');
  await reader.cancel();
});

test('workerd strips spoofed headers and rejects invalid/missing tokens', async (t) => {
  const { request } = await setup(t);
  assert.equal((await request('/api/private')).status, 401);
  assert.equal(
    (await request('/api/private', { headers: { Authorization: 'Bearer bad' } })).status,
    401,
  );
  const response = await request('/api/private', {
    headers: {
      ...authorized,
      Host: 'evil.example',
      Forwarded: 'host=evil.example',
      'X-Forwarded-Host': 'evil.example',
      'X-Forwarded-For': '127.0.0.1',
      'X-Original-URL': '/admin',
    },
  });
  const headers = await response.json();
  assert.equal(headers['x-forwarded-host'], 'app.fixture.test');
  assert.equal(headers['x-forwarded-for'], '192.0.2.5');
  assert.equal(headers.forwarded, undefined);
  assert.equal(headers['x-original-url'], undefined);
  assert.notEqual(headers.host, 'evil.example');
});

test('workerd WebSocket carries messages and clean disconnects through gateway', async (t) => {
  const { runtime, request } = await setup(t);
  // Prime recognition using the same runtime and its real KV binding.
  assert.equal((await request('/api/private', { headers: authorized })).status, 200);
  const local = new URL(await runtime.ready);
  local.protocol = 'wss:';
  local.pathname = '/api/socket';
  const socket = new WebSocket(local, {
    headers: { ...authorized, Host: 'app.fixture.test' },
    rejectUnauthorized: false, // Only the ephemeral local test certificate.
  });
  t.after(() => socket.terminate());
  await once(socket, 'open');
  socket.send('hello');
  const [message] = await once(socket, 'message');
  assert.equal(message.toString(), 'hello');
  socket.close(1000, 'finished');
  const [code, reason] = await once(socket, 'close');
  assert.equal(code, 1000);
  assert.equal(reason.toString(), 'finished');
});

test('workerd coalesces concurrent first-use validation across request contexts', async (t) => {
  const { request } = await setup(t);
  const responses = await Promise.all(
    Array.from({ length: 8 }, () =>
      request('/api/private', {
        headers: { Authorization: 'Bearer delayed' },
      }),
    ),
  );
  assert.ok(responses.every((response) => response.status === 200));
  const stats = await (await request('/assets/stats')).json();
  assert.equal(stats.validations, 1);
});

test('workerd validator timeout fails closed', async (t) => {
  const profile = JSON.parse(
    await readFile(new URL('../../profiles/test-server.json', import.meta.url)),
  );
  profile.validationTimeoutMs = 100;
  const runtime = await runtimeGateway(origin, { profile });
  t.after(() => runtime.dispose());
  const response = await runtime.dispatchFetch('https://app.fixture.test/api/private', {
    headers: { Authorization: 'Bearer timeout', 'CF-Connecting-IP': '192.0.2.7' },
  });
  assert.equal(response.status, 503);
});

test('workerd rate-limit binding blocks unknown attempts while recognized requests continue', async (t) => {
  const runtime = await runtimeGateway(origin, { unknownLimit: 2 });
  t.after(() => runtime.dispose());
  const request = (token) =>
    runtime.dispatchFetch('https://app.fixture.test/api/private', {
      headers: { Authorization: 'Bearer ' + token, 'CF-Connecting-IP': '192.0.2.8' },
    });
  assert.equal((await request('good')).status, 200);
  assert.equal((await request('bad')).status, 401);
  assert.equal((await request('bad-again')).status, 429);
  assert.equal((await request('good')).status, 200);
});
