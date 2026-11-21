import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { totp } from './mfa-totp.js';

const directory = process.env.GATEWAY_QA_DIR;
const base = process.env.GATEWAY_QA_URL;
const accountPath = process.env.GATEWAY_QA_MFA_ACCOUNT;
if (!directory || !base || !accountPath)
  throw new Error('Isolated staging URL, QA directory and separate fresh MFA account required');
const account = JSON.parse(await readFile(accountPath, 'utf8'));

function cookies(response) {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');
}

async function post(path, body, headers = {}, expected = 200) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, expected, path);
  return response;
}

const credentials = { email: account.email, password: account.password };
const login = await post('/api/auth/login', credentials);
const session = await login.json();
assert.ok(session.token, 'Use a fresh separate QA account without MFA');
const headers = { Authorization: 'Bearer ' + session.token, Cookie: cookies(login) };
const enrollment = await (await post('/api/auth/2fa/enable', {}, headers)).json();
const secret = new URL(enrollment.otpauthUrl).searchParams.get('secret');
await post('/api/auth/2fa/confirm', { token: totp(secret) }, headers);
const challenge = async () => {
  const result = await (await post('/api/auth/login', credentials)).json();
  assert.equal(result.twoFAPending, true);
  assert.ok(result.tempToken);
  return result.tempToken;
};
const tempToken = await challenge();
await post('/api/auth/2fa/verify-temp', { tempToken, token: totp(secret), extra: true }, {}, 400);
const verified = await (
  await post('/api/auth/2fa/verify-temp', { tempToken, token: totp(secret) })
).json();
assert.ok(verified.token && verified.user);
const privateApi = await fetch(base + '/api/convos', {
  headers: { Authorization: 'Bearer ' + verified.token },
});
assert.equal(privateApi.status, 200);
const backupToken = await challenge();
const backupCode = enrollment.backupCodes[0];
const backup = await (
  await post('/api/auth/2fa/verify-temp', { tempToken: backupToken, backupCode })
).json();
assert.ok(backup.token);
await post('/api/auth/2fa/verify-temp', { tempToken: await challenge(), backupCode }, {}, 401);
const results = {
  optionalMfaEnrollment: true,
  totpChallenge: true,
  backupCodeChallenge: true,
  usedBackupCodeRejected: true,
  extraFieldStopped: true,
  protectedApiAfterMfa: true,
};
await writeFile(directory + '/contracts-mfa-results.json', JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
