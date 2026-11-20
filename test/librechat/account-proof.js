import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const directory = process.env.GATEWAY_QA_DIR;
const base = process.env.GATEWAY_QA_URL;
const account = JSON.parse(await readFile(directory + '/account.json', 'utf8'));
const compose = ['compose', '-f', 'test/librechat/compose.yaml'];
const copied = spawnSync(
  'docker',
  [
    ...compose,
    'cp',
    'test/librechat/account-state.cjs',
    'api:/app/config/gateway-account-state.cjs',
  ],
  { stdio: 'ignore' },
);
assert.equal(copied.status, 0);
function fence(fenced) {
  const result = spawnSync(
    'docker',
    [...compose, 'exec', '-T', 'api', 'node', '/app/config/gateway-account-state.cjs'],
    {
      input: JSON.stringify({ email: account.email, fenced }),
      stdio: ['pipe', 'ignore', 'ignore'],
    },
  );
  assert.equal(result.status, 0, 'QA-only account state change');
}
const login = async () => {
  const response = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: account.email, password: account.password }),
  });
  assert.equal(response.status, 200);
  return response.json();
};
const first = await login();
const neverRecognized = await login();
const request = (token) =>
  fetch(base + '/api/convos', { headers: { Authorization: 'Bearer ' + token } });
assert.equal((await request(first.token)).status, 200);
try {
  fence(true);
  assert.equal((await request(first.token)).status, 401);
  assert.equal((await request(neverRecognized.token)).status, 401);
} finally {
  fence(false);
}
assert.equal((await request(first.token)).status, 200);
const expiry = JSON.parse(Buffer.from(neverRecognized.token.split('.')[1], 'base64url')).exp;
await new Promise((resolve) => setTimeout(resolve, Math.max(0, expiry * 1000 - Date.now() + 1000)));
assert.equal((await request(neverRecognized.token)).status, 401);
const results = {
  recognizedAccountFencedRejectedByBackend: true,
  unknownAccountFencedRejectedByValidator: true,
  accountRestorationPreservesBackendAuthority: true,
  neverRecognizedExpiredTokenRejected: true,
};
await writeFile(directory + '/account-proof.json', JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
