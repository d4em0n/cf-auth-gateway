import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { chromium } from '@playwright/test';
import { startOrigin } from './origin.js';
import { checkApiLifecycle } from './api-checks.js';
import { startGateway } from './gateway.js';

const directory = process.env.GATEWAY_QA_DIR;
if (!directory) throw new Error('GATEWAY_QA_DIR is required');
const account = JSON.parse(await readFile(directory + '/account.json', 'utf8'));
const secret = randomBytes(32).toString('hex');
const remoteUrl = process.env.GATEWAY_QA_URL;
const baseUrl = remoteUrl ?? 'https://chat.example.com:19444';
const origin = remoteUrl ? null : await startOrigin(directory, secret);
let runtime;
let browser;
const results = {};
try {
  if (!remoteUrl) runtime = await startGateway(directory, secret);
  const request = (path, init = {}) =>
    remoteUrl
      ? fetch(baseUrl + path, { ...init, redirect: 'manual' })
      : runtime.dispatchFetch(baseUrl + path, {
          ...init,
          headers: { 'CF-Connecting-IP': '192.0.2.9', ...init.headers },
        });
  const before = origin?.observations.length;
  assert.equal((await request('/api/convos')).status, 401);
  if (origin) assert.equal(origin.observations.length, before);
  results.anonymousPrivateApiRejected = true;
  results.anonymousStoppedBeforeOrigin = origin ? true : 'check staging access logs';
  const bad = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: account.email, password: 'wrong-disposable-password' }),
  });
  assert.ok([401, 404].includes(bad.status));
  results.invalidLogin = true;
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE,

    args: remoteUrl
      ? []
      : [
          '--host-resolver-rules=MAP chat.example.com 127.0.0.1',
          '--no-proxy-server',
          '--ignore-certificate-errors',
        ],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: !remoteUrl });
  const page = await context.newPage();
  const pageErrors = [];
  const assetFailures = [];
  page.on('pageerror', () => pageErrors.push('browser exception'));
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (response.status() >= 400 && (path.startsWith('/assets/') || !path.startsWith('/api/'))) {
      assetFailures.push({ path, status: response.status() });
    }
  });
  await page.goto(baseUrl + '/login', { waitUntil: 'domcontentloaded' });
  await page.locator('input[name=email]').fill(account.email);
  await page.locator('input[name=password]').fill(account.password);
  const loginResponse = page.waitForResponse(
    (response) => response.url().includes('/api/auth/login') && response.status() === 200,
  );
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const login = await (await loginResponse).json();
  await page.waitForURL('**/c/new');
  results.browserLogin = true;
  console.log('Passed browser login');
  const cookies = await context.cookies();
  assert.ok(
    cookies.find(
      (cookie) =>
        cookie.name === 'refreshToken' &&
        cookie.httpOnly &&
        cookie.secure &&
        cookie.sameSite === 'Strict',
    ),
  );
  results.secureHttpOnlyCookies = true;
  const bearer = { Authorization: 'Bearer ' + login.token };
  const conversations = await request('/api/convos', { headers: bearer });
  assert.equal(conversations.status, 200);
  results.conversations = true;
  const validationCount = () =>
    origin?.observations.filter((item) => item.path === '/api/user').length;
  const validations = validationCount();
  await (await request('/api/convos', { headers: bearer })).arrayBuffer();
  if (origin) assert.equal(validationCount(), validations);
  results.recognitionHit = origin ? true : 'check staging access logs';
  await page
    .getByRole('textbox', { name: 'Message input', exact: true })
    .fill('Reply exactly GATEWAY_LIBRECHAT_OK.');
  const streamResponse = page.waitForResponse((response) =>
    response.headers()['content-type']?.includes('text/event-stream'),
  );
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const stream = await streamResponse;
  assert.equal(stream.status(), 200);
  await page.getByText('GATEWAY_LIBRECHAT_OK', { exact: true }).last().waitFor({ timeout: 120000 });
  results.realModelStreamingConversation = true;
  const resumeUrl = new URL(stream.url());
  resumeUrl.searchParams.set('resume', 'true');
  const resumed = await request(resumeUrl.pathname + resumeUrl.search, { headers: bearer });
  assert.equal(resumed.status, 200);
  assert.match(resumed.headers.get('content-type'), /text\/event-stream/);
  const resumeReader = resumed.body.getReader();
  const firstResumedEvent = await resumeReader.read();
  assert.ok(firstResumedEvent.value?.length);
  await resumeReader.cancel();
  results.resumableStreamAndCancellation = true;
  console.log('Passed real model stream');
  await page.screenshot({ path: directory + '/browser.png' });
  // Listen before expiry: LibreChat may refresh automatically before a reload.
  const refreshResponse = page.waitForResponse(
    (response) => response.url().includes('/api/auth/refresh') && response.status() === 200,
    { timeout: 90000 },
  );
  // Wait for the real signed token's exp, not a fabricated expired token.
  const claims = JSON.parse(Buffer.from(login.token.split('.')[1], 'base64url').toString());
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, claims.exp * 1000 - Date.now() + 1000)),
  );
  const expiredBefore = origin?.observations.filter((item) => item.path === '/api/convos').length;
  const expired = await request('/api/convos', { headers: bearer });
  assert.equal(expired.status, 401);
  if (origin)
    assert.equal(
      origin.observations.filter((item) => item.path === '/api/convos').length,
      expiredBefore + 1,
    );
  results.recognizedExpiredRejectedByLibreChat = true;
  const refreshed = await (await refreshResponse).json();
  await page.reload({ waitUntil: 'domcontentloaded' });
  assert.ok(refreshed.token && refreshed.token !== login.token);
  await page.getByRole('textbox', { name: 'Message input', exact: true }).waitFor();
  results.expiredTokenRefreshAndReload = true;
  console.log('Passed token expiry, refresh and reload');
  const nextCookies = await context.cookies();
  assert.notEqual(
    nextCookies.find((cookie) => cookie.name === 'refreshToken').value,
    cookies.find((cookie) => cookie.name === 'refreshToken').value,
  );
  results.refreshRotation = true;
  const replay = await request('/api/auth/refresh', {
    method: 'POST',
    headers: {
      Cookie: 'refreshToken=' + cookies.find((cookie) => cookie.name === 'refreshToken').value,
    },
  });
  assert.equal(replay.status, 401);
  results.refreshReplayRejected = true;
  const newBearer = { Authorization: 'Bearer ' + refreshed.token };
  assert.equal((await request('/api/convos', { headers: newBearer })).status, 200);
  const logout = await request('/api/auth/logout', {
    method: 'POST',
    headers: {
      ...newBearer,
      Cookie: nextCookies.map((cookie) => cookie.name + '=' + cookie.value).join('; '),
    },
  });
  assert.equal(logout.status, 200);
  assert.ok(logout.headers.getSetCookie().some((cookie) => cookie.startsWith('refreshToken=;')));
  const postLogoutRefresh = await request('/api/auth/refresh', {
    method: 'POST',
    headers: {
      Cookie: nextCookies.map((cookie) => cookie.name + '=' + cookie.value).join('; '),
    },
  });
  assert.equal(postLogoutRefresh.status, 401);
  results.logoutInvalidatesRefresh = true;
  const oldAccess = await request('/api/convos', { headers: newBearer });
  results.postLogoutAccessStatus = oldAccess.status;
  console.log('Passed logout; checking API uploads and concurrency');
  await checkApiLifecycle(request, account, results);
  assert.deepEqual(assetFailures, []);
  assert.deepEqual(pageErrors, []);
  results.assetsWithoutFailures = true;
  results.browserExceptions = 0;
  console.log(JSON.stringify(results, null, 2));
  await writeFile(
    directory + (remoteUrl ? '/edge-results.json' : '/results.json'),
    JSON.stringify({ results, originRequests: origin?.observations }, null, 2),
  );
} finally {
  await browser?.close();
  await runtime?.dispose();
  await origin?.close();
}
