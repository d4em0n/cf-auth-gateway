import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const directory = process.env.GATEWAY_QA_DIR;
const base = process.env.GATEWAY_QA_URL;
const logPath = process.env.GATEWAY_QA_ORIGIN_LOG;
if (!directory || !base || !logPath)
  throw new Error('QA directory, gateway URL and staging-only origin log required');
const account = JSON.parse(await readFile(directory + '/account.json', 'utf8'));
const request = async (path, init = {}) => {
  const response = await fetch(base + path, { ...init, redirect: 'manual' });
  const text = await response.text();
  return { status: response.status, text };
};
const marker = randomUUID();
const before = await readFile(logPath, 'utf8');
assert.equal((await request('/api/convos?gateway-proof=anonymous-' + marker)).status, 401);
assert.equal(
  (
    await request('/api/convos?gateway-proof=invalid-' + marker, {
      headers: { Authorization: 'Bearer invalid-' + marker },
    })
  ).status,
  401,
);
const login = await request('/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(account),
});
assert.equal(login.status, 200);
const token = JSON.parse(login.text).token;
const headers = { Authorization: 'Bearer ' + token };
assert.equal((await request('/api/convos?gateway-proof=first-' + marker, { headers })).status, 200);
const afterFirst = await readFile(logPath, 'utf8');
assert.equal((await request('/api/convos?gateway-proof=known-' + marker, { headers })).status, 200);
const afterKnown = await readFile(logPath, 'utf8');
const firstEntries = afterFirst.slice(before.length);
assert.equal(firstEntries.includes('anonymous-' + marker), false);
assert.equal(firstEntries.includes('invalid-' + marker), false);
assert.equal(firstEntries.includes('first-' + marker), true);
const knownEntries = afterKnown.slice(afterFirst.length);
assert.equal(knownEntries.includes('known-' + marker), true);
assert.equal(knownEntries.includes('"/api/user"'), false);
const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
await new Promise((resolve) =>
  setTimeout(resolve, Math.max(0, claims.exp * 1000 - Date.now() + 1000)),
);
const beforeExpired = await readFile(logPath, 'utf8');
assert.equal(
  (await request('/api/convos?gateway-proof=expired-' + marker, { headers })).status,
  401,
);
const expiredEntries = (await readFile(logPath, 'utf8')).slice(beforeExpired.length);
assert.equal(expiredEntries.includes('expired-' + marker), true);
assert.equal(expiredEntries.includes('"/api/user"'), false);
const results = {
  anonymousBlockedBeforeOrigin: true,
  invalidBlockedBeforeProtectedOrigin: true,
  validFirstUseReachedOrigin: true,
  recognitionHitSkippedValidator: true,
  recognizedExpiredReachedBackendAndWasRejected: true,
};
await writeFile(directory + '/origin-proof.json', JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
