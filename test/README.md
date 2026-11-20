# Integration test fixture

The profile in `profiles/test-server.json` is **only** for automated testing.
It is not a LibreChat/Immich adapter and must never be deployed as-is.

## What runs

```text
node fetch()
    |
    v
Test gateway HTTP server (127.0.0.1, ephemeral port)
    |
    v
createGateway(test-server.json) -- real Worker engine
    |
    v
Test-only HTTPS-to-localhost fetch adapter
    |
    v
Fixture HTTP origin (127.0.0.1, ephemeral port)
```

The fake origin implements a browser login page and actual HTTP responses
for JavaScript, CSS, SVG, version metadata, login, session/bearer validation,
refresh-token rotation, logout, protected JSON/HTML/CSS endpoints, POST bodies,
and server-sent events.

It rejects every request without the injected origin-gateway secret.
Only the test transport translates the configured HTTPS origin name to a
localhost HTTP port; production gateway code remains unchanged.

Each test creates separate servers, credentials, an in-memory KV binding with
fixed TTL simulation, and rate limiter bindings. No Cloudflare account, network
connection, external service or real secrets are needed.

## Test commands

```sh
npm test
npm run check
npm run build
```

`npm test` runs both the existing unit suite and this full HTTP integration
suite. The test profile is validated by `npm run check`.

## What the suite establishes

- Public login HTML, JS, CSS, SVG and safe metadata are reachable without a token.
- Private HTML/API routes are denied without credentials; suffixes like `.css`
  do not automatically allow public access.
- Login and refresh responses (including multiple `Set-Cookie` headers)
  pass through the gateway.
- First-use bearer and cookie credentials are validated against the origin.
  Subsequent requests recognize the fingerprint without revalidation.
- Unknown invalid or expired credentials do not reach protected application
  handlers.
- A previously recognized credential can remain in KV after it expires or
  is revoked, but the original application still rejects it.
- Refresh tokens rotate without requiring a valid access token; new access
  tokens are validated on first protected use.
- Logout, origin-bypass protection, rate limits, redirects, HTML validation
  failures, expired recognition records, POST bodies and SSE are covered.

## Deliberate limitations

This is a real local HTTP integration test, **not** a Cloudflare edge deployment.
It does not prove behavior of Cloudflare KV across regions, Workers CPU quotas,
Cloudflare rate limiter distribution, real TLS/origin certificates, browser
cookie policies, or a production application's undocumented endpoints.

WebSocket `101` response handling is covered by the separate gateway unit
tests. End-to-end WebSocket messages are not simulated by the Node HTTP fixture
because Node's native HTTP server and the Workers WebSocket runtime have
different upgrade APIs. Real application/Cloudflare integration tests remain
necessary before production deployment.
