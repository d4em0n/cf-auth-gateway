import test from 'node:test';
import assert from 'node:assert/strict';
import { loadProfile } from '../scripts/load-profile.js';
import { createGateway } from '../src/gateway.js';

const profile = await loadProfile(new URL('../profiles/librechat-v0.8.9.yaml', import.meta.url));
const shapes = [
  ['/api/auth/2fa/setup', { tempToken: 'temporary-token' }],
  ['/api/auth/2fa/setup/cancel', { tempToken: 'temporary-token' }],
  ['/api/auth/2fa/setup/confirm', { tempToken: 'temporary-token', token: '123456' }],
  ['/api/auth/2fa/setup/acknowledge', { acknowledgementToken: 'acknowledgement-token' }],
  ['/api/auth/2fa/setup/finalize', { finalizationToken: 'finalization-token' }],
];

for (const [path, shape] of shapes) {
  test('LibreChat enrollment contract: ' + path, async () => {
    const forwarded = [];
    let limiterCalls = 0;
    const gateway = createGateway(profile, {
      fetchUpstream: async (request) => {
        forwarded.push(await request.text());
        return new Response('Backend response');
      },
    });
    const environment = {
      ORIGIN_URL: 'https://origin.fixture.test',
      ORIGIN_GATEWAY_SECRET: 'test-origin-secret-at-least-32-characters',
      AUTH_FLOW_LIMITER: {
        async limit() {
          limiterCalls += 1;
          return { success: true };
        },
      },
    };
    const send = (body, headers = {}) =>
      gateway(
        new Request('https://chat.example.com' + path, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'CF-Connecting-IP': '192.0.2.18',
            ...headers,
          },
          body,
        }),
        environment,
      );
    const bytes = ' \n' + JSON.stringify(shape, null, 2) + '\r\n';
    assert.equal((await send(bytes)).status, 200);
    assert.deepEqual(forwarded, [bytes]);
    const firstField = Object.keys(shape)[0];
    for (const invalid of [
      {},
      { ...shape, [firstField]: 42 },
      { ...shape, [firstField]: null },
      { ...shape, extra: 'unexpected' },
      { ...shape, [firstField]: 'x'.repeat(8193) },
    ]) {
      assert.equal((await send(JSON.stringify(invalid))).status, 400);
    }
    for (const field of Object.keys(shape)) {
      const missing = { ...shape };
      delete missing[field];
      assert.equal((await send(JSON.stringify(missing))).status, 400);
    }
    assert.equal((await send(bytes, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await send(bytes, { 'Content-Encoding': 'gzip' })).status, 415);
    assert.equal((await send(bytes, { 'X-Middleware-Subrequest': '' })).status, 400);
    assert.equal((await send(' '.repeat(12289))).status, 413);
    assert.equal((await send('{')).status, 400);
    assert.equal(forwarded.length, 1);
    assert.equal(limiterCalls, 1);
  });
}
