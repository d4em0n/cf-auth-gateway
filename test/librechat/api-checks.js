import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

function cookieHeader(response) {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');
}

export async function checkApiLifecycle(request, account, results) {
  const login = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(account),
  });
  assert.equal(login.status, 200);
  const session = await login.json();
  const headers = {
    Authorization: 'Bearer ' + session.token,
    'User-Agent':
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/156.0.0.0 Safari/537.36',
  };
  const simultaneous = await Promise.all(
    Array.from({ length: 8 }, () => request('/api/convos', { headers })),
  );
  assert.ok(simultaneous.every((response) => response.status === 200));
  await Promise.all(simultaneous.map((response) => response.arrayBuffer()));
  results.concurrentFirstUse = true;

  const image = await readFile(new URL('./pixel.png', import.meta.url));
  const form = new FormData();
  form.set('file', new Blob([image], { type: 'image/png' }), 'gateway-qa.png');
  form.set('endpoint', 'QA Gateway');
  form.set('file_id', crypto.randomUUID());
  form.set('width', '8');
  form.set('height', '8');
  const upload = await request('/api/files/images', {
    method: 'POST',
    headers: { ...headers, Accept: 'application/json' },
    body: form,
  });
  assert.equal(upload.status, 200, 'LibreChat image upload');
  const uploadText = await upload.text();
  assert.match(
    upload.headers.get('content-type'),
    /application\/json/,
    'LibreChat upload response must be JSON',
  );
  const file = JSON.parse(uploadText);
  assert.ok(file.file_id);
  const path = '/api/files/download/' + session.user.id + '/' + file.file_id;
  const download = await request(path, { headers });
  assert.equal(download.status, 200);
  const downloaded = new Uint8Array(await download.arrayBuffer());
  assert.ok(downloaded.length > 20);
  results.uploadAndDownload = true;
  if (process.env.LIBRECHAT_QA_DIRECT_URL) {
    const direct = await fetch(process.env.LIBRECHAT_QA_DIRECT_URL + path, { headers });
    assert.equal(direct.status, 200);
    assert.deepEqual(new Uint8Array(await direct.arrayBuffer()), downloaded);
    const throughResponse = await request('/api/convos', { headers });
    assert.equal(throughResponse.status, 200);
    const through = await throughResponse.json();
    const trusted = await (
      await fetch(process.env.LIBRECHAT_QA_DIRECT_URL + '/api/convos', { headers })
    ).json();
    assert.deepEqual(through, trusted);
    results.directTrustedResponseComparison = true;
  }
  await (
    await request('/api/files', {
      method: 'DELETE',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [file] }),
    })
  ).arrayBuffer();

  // Independent clients may race a rotating refresh cookie. Record the backend's
  // outcome, and require a usable final cookie; the gateway must not replay it.
  const originalCookie = cookieHeader(login);
  const refreshes = await Promise.all(
    Array.from({ length: 2 }, () =>
      request('/api/auth/refresh', {
        method: 'POST',
        headers: { Cookie: originalCookie },
      }),
    ),
  );
  assert.ok(refreshes.some((response) => response.status === 200));
  assert.ok(refreshes.every((response) => [200, 401].includes(response.status)));
  results.concurrentRefreshStatuses = refreshes.map((response) => response.status);
  const rotated = refreshes.filter((response) => response.status === 200).map(cookieHeader);
  assert.ok(rotated.every((cookie) => cookie && cookie !== originalCookie));
  const replay = await request('/api/auth/refresh', {
    method: 'POST',
    headers: { Cookie: originalCookie },
  });
  assert.equal(replay.status, 401);
  let usableCookie;
  for (const cookie of rotated) {
    const candidate = await request('/api/auth/refresh', {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    if (candidate.status === 200) usableCookie = cookieHeader(candidate);
    else assert.equal(candidate.status, 401);
  }
  assert.ok(usableCookie, 'Concurrent refresh must leave a usable winning cookie');
  const finalRefresh = await request('/api/auth/refresh', {
    method: 'POST',
    headers: { Cookie: usableCookie },
  });
  assert.equal(finalRefresh.status, 200);
  results.concurrentRefreshHasUsableWinner = true;
  results.apiCookieRotationAndReplay = true;
}
