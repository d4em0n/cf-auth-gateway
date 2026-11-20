import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadProfile, parseProfile } from '../scripts/load-profile.js';
import { validateProfile } from '../src/profile.js';
import { enforceRequestContract } from '../src/request-contract.js';
import { createGateway } from '../src/gateway.js';
import { startGatewayHarness } from './fixtures/harness.js';

const profile = await loadProfile(new URL('../profiles/test-server.yaml', import.meta.url));
const contract = profile.routes.find((route) => route.exact?.includes('/auth/login')).request;
const login = '{"username":"alice","password":"fixture-password"}';
const jsonHeaders = { 'Content-Type': 'application/json' };
const makeRequest = (body = login, headers = jsonHeaders) =>
  new Request('https://app.fixture.test/auth/login', { method: 'POST', headers, body });

for (const [label, body, headers, status] of [
  ['wrong media type', login, { 'Content-Type': 'text/plain' }, 415],
  ['missing media type', new TextEncoder().encode(login), {}, 415],
  ['duplicate media type', login, { 'Content-Type': 'application/json, application/json' }, 415],
  ['non-UTF8 charset', login, { 'Content-Type': 'application/json; charset=latin1' }, 415],
  ['unknown parameter', login, { 'Content-Type': 'application/json; boundary=x' }, 415],
  ['missing field', '{"username":"alice"}', jsonHeaders, 400],
  ['extra field', login.replace('}', ',"admin":true}'), jsonHeaders, 400],
  ['wrong type', '{"username":42,"password":false}', jsonHeaders, 400],
  ['null string', '{"username":null,"password":"x"}', jsonHeaders, 400],
  ['long string', JSON.stringify({ username: 'a'.repeat(321), password: 'x' }), jsonHeaders, 400],
  ['large body', ' '.repeat(8193), jsonHeaders, 413],
  ['bad syntax', '{"username":', jsonHeaders, 400],
  ['trailing comma', '{"username":"x",}', jsonHeaders, 400],
  ['duplicate keys', '{"username":"a","username":"b","password":"x"}', jsonHeaders, 400],
  [
    'escaped duplicate keys',
    '{"username":"a","user\\u006eame":"b","password":"x"}',
    jsonHeaders,
    400,
  ],
  ['nested object', '{"username":{"value":"alice"},"password":"x"}', jsonHeaders, 400],
  ['deep input', '['.repeat(1000) + ']'.repeat(1000), jsonHeaders, 400],
  ['array root', '[]', jsonHeaders, 400],
  ['scalar root', 'null', jsonHeaders, 400],
  ['BOM', '\ufeff' + login, jsonHeaders, 400],
  ['invalid UTF8', new Uint8Array([0xff]), jsonHeaders, 400],
  ['gzip body', login, { ...jsonHeaders, 'Content-Encoding': 'gzip' }, 415],
  ['framework header', login, { ...jsonHeaders, 'Next-Action': '' }, 400],
  ['middleware header', login, { ...jsonHeaders, 'x-middleware-subrequest': 'middleware' }, 400],
  ['prototype field', '{"__proto__":"x"}', jsonHeaders, 400],
]) {
  test('contract blocks ' + label + ' before the HTTP backend and limiter', async (t) => {
    const harness = await startGatewayHarness(profile);
    t.after(() => harness.close());
    const response = await harness.request('/auth/login', { method: 'POST', headers, body });
    assert.equal(response.status, status);
    assert.equal(harness.fixture.state.observedRequests.length, 0);
    assert.equal(harness.controls.loginChecks, 0);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  });
}

test('validated HTTP login preserves exact whitespace, Unicode and escape bytes', async (t) => {
  const harness = await startGatewayHarness(profile);
  t.after(() => harness.close());
  const body = ' {\n "password" : "fixture-passw\\u006frd", "username" : "alice" }\r\n';
  const response = await harness.request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'Application/JSON; Charset="UTF-8"' },
    body,
  });
  assert.equal(response.status, 200);
  assert.equal(harness.fixture.state.lastLoginBody, body);
  const unicode = ' {"username":"例😀\\"{[]}","password":"a\\\\b"} ';
  const result = await enforceRequestContract(makeRequest(unicode), contract);
  assert.deepEqual(
    new Uint8Array(await result.request.arrayBuffer()),
    new TextEncoder().encode(unicode),
  );
});

test('actual streamed bytes enforce the limit despite missing or misleading Content-Length', async () => {
  for (const declared of [undefined, '1']) {
    let cancelled = false;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(8192));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const headers = { ...jsonHeaders };
    if (declared) headers['Content-Length'] = declared;
    const request = new Request('https://app.fixture.test/auth/login', {
      method: 'POST',
      headers,
      body: stream,
      duplex: 'half',
    });
    const result = await enforceRequestContract(request, contract);
    assert.equal(result.status, 413);
    assert.equal(cancelled, true);
  }
  const body = login + ' '.repeat(8192 - Buffer.byteLength(login));
  assert.ok((await enforceRequestContract(makeRequest(body), contract)).request);
});

test('byte counts include multibyte UTF8 and empty means zero bytes including whitespace', async () => {
  assert.equal((await enforceRequestContract(makeRequest('é'.repeat(4097)), contract)).status, 413);
  for (const body of ['', ' ', '{}', '\n']) {
    const result = await enforceRequestContract(makeRequest(body), { maxBodyBytes: 0 });
    assert.equal(result.status ?? 200, body === '' ? 200 : 413);
  }
});

test('body read errors and a stalled stream fail closed and cancel', async () => {
  const broken = new Request('https://app.fixture.test/auth/login', {
    method: 'POST',
    headers: jsonHeaders,
    duplex: 'half',
    body: new ReadableStream({
      start(controller) {
        controller.error(new Error('broken'));
      },
    }),
  });
  assert.equal((await enforceRequestContract(broken, contract)).status, 408);
  let cancelled = false;
  const stalled = new Request(broken.url, {
    method: 'POST',
    headers: jsonHeaders,
    duplex: 'half',
    body: new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
  });
  assert.equal((await enforceRequestContract(stalled, contract)).status, 408);
  assert.equal(cancelled, true);
});

test('primitive fields, optional fields and additionalProperties follow the declared policy', async () => {
  const custom = {
    ...contract,
    json: {
      type: 'object',
      required: ['s'],
      additionalProperties: false,
      properties: {
        s: { type: 'string', maxLength: 3 },
        b: { type: 'boolean' },
        n: { type: 'number' },
        i: { type: 'integer' },
        z: { type: 'null' },
      },
    },
  };
  for (const [body, accepted] of [
    [{ s: 'abc' }, true],
    [{ s: '😀', b: false, n: 1.5, i: 2, z: null }, true],
    [{ s: 'abcd' }, false],
    [{ s: 'ok', i: 1.5 }, false],
    [{ s: 'ok', z: 0 }, false],
    [{ s: 'ok', other: 1 }, false],
  ]) {
    const result = await enforceRequestContract(makeRequest(JSON.stringify(body)), custom);
    assert.equal(Boolean(result.request), accepted);
  }
  custom.json.additionalProperties = true;
  assert.ok((await enforceRequestContract(makeRequest('{"s":"ok","other":1}'), custom)).request);
  assert.equal(
    (await enforceRequestContract(makeRequest('{"s":"ok","other":1e999}'), custom)).status,
    400,
  );
  assert.equal(
    (await enforceRequestContract(makeRequest('{"s":"ok","other":{}}'), custom)).status,
    400,
  );
});

test('header-only contracts and uncontracted public/protected bodies remain unread', async () => {
  const environment = {
    ORIGIN_URL: 'https://origin.fixture.test',
    ORIGIN_GATEWAY_SECRET: 'test-secret-with-at-least-32-characters',
    HMAC_SECRET: 'test-hmac-with-at-least-32-characters',
    RECOGNIZED: { get: async () => 'recognized' },
  };
  let reads = 0;
  const create = (path, headers) =>
    new Request('https://app.fixture.test' + path, {
      method: 'POST',
      headers,
      duplex: 'half',
      body: new ReadableStream(
        {
          pull() {
            reads += 1;
          },
        },
        { highWaterMark: 0 },
      ),
    });
  const headersOnly = create('/auth/login');
  assert.equal(
    (await enforceRequestContract(headersOnly, { denyHeaders: ['Next-Action'] })).request,
    headersOnly,
  );
  const legacy = await loadProfile(new URL('../profiles/test-server.json', import.meta.url));
  const gateway = createGateway(legacy, { fetchUpstream: async () => new Response('untouched') });
  const publicProfile = structuredClone(legacy);
  publicProfile.routes.find((route) => route.exact?.includes('/auth/login')).rateLimit = false;
  const publicGateway = createGateway(publicProfile, {
    fetchUpstream: async () => new Response('untouched'),
  });
  assert.equal((await publicGateway(create('/auth/login'), environment)).status, 200);
  assert.equal(
    (
      await gateway(
        create('/api/upload', { Authorization: 'Bearer known', 'Next-Action': 'allowed' }),
        environment,
      )
    ).status,
    200,
  );
  assert.equal(reads, 0);
});

test('safe YAML loader rejects duplicates, aliases, tags, multiple documents and unknown fields', async () => {
  const source = await readFile(new URL('../profiles/test-server.yaml', import.meta.url), 'utf8');
  assert.equal(parseProfile(source).schemaVersion, 2);
  for (const suffix of [
    '\nid: duplicate',
    '\nunknown: true',
    '\n---\nid: second',
    '\na: &x [1]\nb: *x',
    '\na: !!js/function "evil"',
    '\na: !custom value',
  ]) {
    assert.throws(() => parseProfile(source + suffix));
  }
  assert.throws(() =>
    parseProfile(source.replace('schemaVersion: 2', '%YAML 1.1\n---\nschemaVersion: 2')),
  );
  const legacy = await readFile(new URL('../profiles/test-server.json', import.meta.url), 'utf8');
  assert.equal(parseProfile(legacy).schemaVersion, 1);
  assert.throws(() =>
    parseProfile(legacy.replace('"schemaVersion": 1', '"schemaVersion": 1, "schemaVersion": 2')),
  );
});

test('contract schema rejects unsupported features and incomplete or unbounded configuration', () => {
  for (const invalid of [
    { script: 'anything' },
    { maxBodyBytes: -1 },
    { maxBodyBytes: 65537 },
    { maxBodyBytes: 1.5 },
    { contentTypes: ['application/json'] },
    { maxBodyBytes: 10, contentTypes: ['*/*'] },
    { denyHeaders: ['X-*'] },
    { maxBodyBytes: 10, json: contract.json },
    { ...contract, json: { ...contract.json, required: ['missing'] } },
    { ...contract, json: { ...contract.json, additionalProperties: 'false' } },
    { ...contract, json: { ...contract.json, properties: { field: { type: 'array' } } } },
    {
      ...contract,
      json: { ...contract.json, properties: { field: { type: 'string', pattern: '.*' } } },
    },
    {
      ...contract,
      json: { ...contract.json, properties: { field: { type: 'number', maxLength: 2 } } },
    },
  ]) {
    const changed = structuredClone(profile);
    changed.routes[0].request = invalid;
    assert.throws(() => validateProfile(changed));
  }
  const old = structuredClone(profile);
  old.schemaVersion = 1;
  assert.throws(() => validateProfile(old));
  const protectedRule = structuredClone(profile);
  protectedRule.routes[0].access = 'protected';
  assert.throws(() => validateProfile(protectedRule));
});

test('LibreChat YAML migration preserves the legacy allowlist and authentication configuration', async () => {
  const legacy = await loadProfile(new URL('../profiles/librechat-v0.8.9.json', import.meta.url));
  const yaml = await loadProfile(new URL('../profiles/librechat-v0.8.9.yaml', import.meta.url));
  const flatten = (profile) =>
    profile.routes
      .flatMap((route) =>
        ['exact', 'prefix'].flatMap((kind) =>
          (route[kind] ?? []).flatMap((path) =>
            route.methods.map((method) =>
              JSON.stringify([route.access, method, kind, path, route.rateLimit ?? false]),
            ),
          ),
        ),
      )
      .sort();
  assert.deepEqual(flatten(yaml), flatten(legacy));
  for (const field of [
    'id',
    'hostname',
    'epoch',
    'credentials',
    'retentionDays',
    'validationTimeoutMs',
  ]) {
    assert.deepEqual(yaml[field], legacy[field]);
  }
});

test('public POST contracts and size-only opaque bodies work without authentication', async (t) => {
  const changed = structuredClone(profile);
  const route = changed.routes.find((rule) => rule.exact?.includes('/auth/login'));
  route.access = 'public';
  delete route.rateLimit;
  const harness = await startGatewayHarness(changed);
  t.after(() => harness.close());
  assert.equal(
    (await harness.request('/auth/login', { method: 'POST', headers: jsonHeaders, body: login }))
      .status,
    200,
  );
  assert.equal(
    (await harness.request('/auth/login', { method: 'POST', headers: jsonHeaders, body: '{}' }))
      .status,
    400,
  );
  assert.equal(harness.fixture.state.loginRequests, 1);
  assert.equal(harness.controls.loginChecks, 0);
  const bytes = new Uint8Array([0, 255, 128, 1]);
  const result = await enforceRequestContract(
    makeRequest(bytes, { 'Content-Type': 'application/octet-stream' }),
    {
      maxBodyBytes: 4,
      contentTypes: ['application/octet-stream'],
    },
  );
  assert.deepEqual(new Uint8Array(await result.request.arrayBuffer()), bytes);
});
