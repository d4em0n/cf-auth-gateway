import assert from 'node:assert/strict';

// No valid credentials or user data are included in these rejection probes.
export async function checkPublicContracts(request, results, query = '') {
  const probes = [
    ['/api/auth/2fa/verify-temp', '{}', { 'Content-Type': 'application/json' }, 400],
    ['/api/auth/2fa/verify-temp', '{"tempToken":42}', { 'Content-Type': 'application/json' }, 400],
    [
      '/api/auth/2fa/verify-temp',
      '{"tempToken":"invalid","extra":true}',
      { 'Content-Type': 'application/json' },
      400,
    ],
    ['/api/auth/login', '{}', { 'Content-Type': 'text/plain' }, 415],
    ['/api/auth/login', '{}', { 'Content-Type': 'application/json' }, 400],
    [
      '/api/auth/login',
      '{"email":"qa@example.test","password":"wrong","extra":true}',
      { 'Content-Type': 'application/json' },
      400,
    ],
    [
      '/api/auth/login',
      '{"email":4,"password":false}',
      { 'Content-Type': 'application/json' },
      400,
    ],
    [
      '/api/auth/login',
      '{"email":"a","email":"b","password":"wrong"}',
      { 'Content-Type': 'application/json' },
      400,
    ],
    ['/api/auth/login', '{', { 'Content-Type': 'application/json' }, 400],
    ['/api/auth/login', ' '.repeat(8193), { 'Content-Type': 'application/json' }, 413],
    [
      '/api/auth/login',
      '{}',
      { 'Content-Type': 'application/json', 'Next-Action': 'unexpected' },
      400,
    ],
    [
      '/api/auth/login',
      '{}',
      { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      415,
    ],
    ['/api/auth/refresh', '{}', { 'Content-Type': 'application/json' }, 413],
    ['/api/auth/logout', ' ', {}, 413],
  ];
  for (const [path, body, headers, status] of probes) {
    const response = await request(path + query, { method: 'POST', headers, body });
    assert.equal(response.status, status, path + ' contract rejection');
    await response.arrayBuffer();
  }
  results.publicContractRejections = probes.length;
}
