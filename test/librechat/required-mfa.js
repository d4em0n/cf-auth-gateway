import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { startOrigin } from './origin.js';
import { startGateway } from './gateway.js';
import { totp } from './mfa-totp.js';

// Use a separate disposable backend with enforced enrollment, never the owner
// instance or the normal optional-MFA staging account/database.
const directory = process.env.GATEWAY_QA_DIR;
if (!directory) throw new Error('A separate required-MFA QA directory is required');
const account = JSON.parse(await readFile(directory + '/account.json', 'utf8'));
const secret = randomBytes(32).toString('hex');
const origin = await startOrigin(directory, secret, { backendPort: 3097 });
let runtime;
const results = {};
try {
  runtime = await startGateway(directory, secret);
  const request = (path, init = {}) =>
    runtime.dispatchFetch('https://chat.example.com:19444' + path, {
      ...init,
      headers: { 'CF-Connecting-IP': '192.0.2.18', ...init.headers },
    });
  const post = async (path, body, expected = 200) => {
    const response = await request('/api/auth/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, expected, path);
    return response;
  };
  const login = async () => {
    const response = await post('login', { email: account.email, password: account.password });
    const result = await response.json();
    assert.equal(
      result.twoFASetupRequired,
      true,
      'Use a fresh account on an enforced-MFA QA backend',
    );
    assert.ok(result.tempToken && !result.token);
    return result.tempToken;
  };
  const cancelledToken = await login();
  await post('2fa/setup', { tempToken: cancelledToken });
  const cancelled = await post('2fa/setup/cancel', { tempToken: cancelledToken });
  assert.ok(cancelled.headers.getSetCookie().some((cookie) => cookie.startsWith('refreshToken=;')));
  results.setupAndCancellation = true;

  const tempToken = await login();
  const enrollment = await (await post('2fa/setup', { tempToken })).json();
  const totpSecret = new URL(enrollment.otpauthUrl).searchParams.get('secret');
  const beforeInvalid = origin.observations.length;
  await post('2fa/setup/confirm', { tempToken, token: totp(totpSecret), extra: true }, 400);
  assert.equal(origin.observations.length, beforeInvalid);
  const confirmation = await (
    await post('2fa/setup/confirm', { tempToken, token: totp(totpSecret) })
  ).json();
  assert.ok(confirmation.backupCodes?.length && confirmation.acknowledgementToken);
  const acknowledgement = await (
    await post('2fa/setup/acknowledge', {
      acknowledgementToken: confirmation.acknowledgementToken,
    })
  ).json();
  assert.ok(acknowledgement.finalizationToken);
  const finalized = await post('2fa/setup/finalize', {
    finalizationToken: acknowledgement.finalizationToken,
  });
  const session = await finalized.json();
  assert.ok(session.token && session.user);
  results.enrollmentConfirmationAcknowledgementFinalization = true;
  const replay = await request('/api/auth/2fa/setup/finalize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ finalizationToken: acknowledgement.finalizationToken }),
  });
  assert.ok([400, 401].includes(replay.status), 'Backend must reject used enrollment nonce');
  results.finalizationReplayRejectedByBackend = true;
  const privateApi = await request('/api/convos', {
    headers: { Authorization: 'Bearer ' + session.token },
  });
  assert.equal(privateApi.status, 200);
  const challenge = await (
    await post('login', { email: account.email, password: account.password })
  ).json();
  assert.ok(challenge.twoFAPending && challenge.tempToken && !challenge.twoFASetupRequired);
  const signedIn = await (
    await post('2fa/verify-temp', { tempToken: challenge.tempToken, token: totp(totpSecret) })
  ).json();
  assert.ok(signedIn.token);
  results.subsequentMfaLoginAndProtectedAccess = true;
  results.invalidContractStoppedBeforeOrigin = true;
  await writeFile(
    directory + '/results.json',
    JSON.stringify({ results, originRequests: origin.observations }, null, 2),
  );
  console.log(JSON.stringify(results, null, 2));
} finally {
  await runtime?.dispose();
  await origin.close();
}
