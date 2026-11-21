import test from 'node:test';
import assert from 'node:assert/strict';
import { loadProfile } from '../../scripts/load-profile.js';
import { runtimeGateway } from './harness.js';

const profile = await loadProfile(new URL('../../profiles/test-server.yaml', import.meta.url));
const origin = 'export default { fetch(request) { return new Response(request.body); } };';

test('workerd enforces each LibreChat setup contract without changing validated bytes', async (t) => {
  const librechat = await loadProfile(
    new URL('../../profiles/librechat-v0.8.9.yaml', import.meta.url),
  );
  let calls = 0;
  const runtime = await runtimeGateway(origin, {
    profile: librechat,
    outboundService: async (request) => {
      calls += 1;
      return new Response(await request.arrayBuffer());
    },
  });
  t.after(() => runtime.dispose());
  for (const [path, shape] of [
    ['setup', { tempToken: 'temporary-token' }],
    ['setup/cancel', { tempToken: 'temporary-token' }],
    ['setup/confirm', { tempToken: 'temporary-token', token: '123456' }],
    ['setup/acknowledge', { acknowledgementToken: 'acknowledgement-token' }],
    ['setup/finalize', { finalizationToken: 'finalization-token' }],
  ]) {
    const request = (body) =>
      runtime.dispatchFetch('https://chat.example.com/api/auth/2fa/' + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.19' },
        body,
      });
    const before = calls;
    assert.equal((await request('{}')).status, 400);
    assert.equal(calls, before);
    const bytes = ' \n' + JSON.stringify(shape, null, 2) + '\r\n';
    const response = await request(bytes);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), bytes);
    assert.equal(calls, before + 1);
  }
});

test('workerd validates JSON and forwards its original bytes to the origin service', async (t) => {
  const runtime = await runtimeGateway(origin);
  t.after(() => runtime.dispose());
  const body = ' {\n"username":"例😀", "password":"escaped\\npassword" }\r\n';
  const response = await runtime.dispatchFetch('https://app.fixture.test/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.11' },
    body,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new TextEncoder().encode(body));
});

test('workerd rejects malformed public requests before issuing any origin subrequest', async (t) => {
  let originCalls = 0;
  const runtime = await runtimeGateway(origin, {
    outboundService: () => {
      originCalls += 1;
      return new Response('unexpected');
    },
  });
  t.after(() => runtime.dispose());
  for (const [body, headers, expected] of [
    ['{}', { 'Content-Type': 'application/json' }, 400],
    ['{}', { 'Content-Type': 'text/plain' }, 415],
    ['{', { 'Content-Type': 'application/json' }, 400],
    ['{"username":"a","username":"b","password":"x"}', { 'Content-Type': 'application/json' }, 400],
    ['{}', { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, 415],
    ['{}', { 'Content-Type': 'application/json', 'X-Middleware-Subrequest': '' }, 400],
    [' '.repeat(8193), { 'Content-Type': 'application/json' }, 413],
  ]) {
    const response = await runtime.dispatchFetch('https://app.fixture.test/auth/login', {
      method: 'POST',
      headers,
      body,
    });
    assert.equal(response.status, expected);
    await response.arrayBuffer();
  }
  const emptyBody = await runtime.dispatchFetch('https://app.fixture.test/auth/refresh', {
    method: 'POST',
    body: '{}',
  });
  assert.equal(emptyBody.status, 413);
  assert.equal(originCalls, 0);
});

test('workerd bounds chunked bodies and counts bytes even without Content-Length', async (t) => {
  const runtime = await runtimeGateway(origin, { profile });
  t.after(() => runtime.dispose());
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(4096));
      controller.enqueue(new Uint8Array(4096));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    },
  });
  const response = await runtime.dispatchFetch('https://app.fixture.test/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    duplex: 'half',
  });
  assert.equal(response.status, 413);
});
