# Cloudflare Authentication Gateway

A small, **profile-driven Cloudflare Worker** that filters requests to an existing self-hosted application without replacing its login system.

It is an **authentication-aware exposure filter**, not a new identity provider or a second factor of authentication. If a credential was valid at least once, the gateway can recognize it for a configured period; the application remains responsible for expiry, revocation, and all per-user authorization.

**Status: experimental. Do not deploy the example profile to production.**

## Request flow

```text
Browser / native app
    |
    v
Cloudflare Worker
    |-- public route (HTML/CSS/JS/config) -----------> origin
    |-- auth flow (login/refresh/logout) ------------> origin
    |
    `-- protected route
          |-- no credential -------------------------> 401
          |-- recognized fingerprint ----------------> origin
          `-- unknown credential
                |-- rate limit ----------------------> 429
                |-- validator rejects ---------------> 401
                |-- validator unavailable -----------> 503
                `-- validator confirms identity ----> remember HMAC fingerprint -> origin
```

WebSocket upgrades take the **protected** branch, even if the request path matches a public route. A successful upstream WebSocket `101` response is passed back unchanged. Server-sent events and HTTP response bodies are streamed.

## Structure

| Module | Responsibility |
| --- | --- |
| `src/gateway.js` | Explicit request flow; no app-specific logic |
| `src/profile.js` | Strict declarative profile validation and route matching |
| `src/credentials.js` | Bearer/cookie extraction and HMAC fingerprint |
| `src/validation.js` | Unknown credential validation against a fixed origin URL |
| `src/recognition.js` | KV registry with fixed retention |
| `src/rate-limit.js` | Small Cloudflare per-IP rate-limit adapter |
| `src/origin.js` | Origin URL, secret header, HTTP and WebSocket proxy |
| `profiles/example.json` | **Illustrative only**, not a verified application profile |
| `test/gateway.test.js` | Mocked upstream and gateway behavior tests |

Profiles contain **data only**, never executable scripts. Routes are method-scoped and use exact paths or constrained directory prefixes. Every unlisted route requires a credential.

## Local checks

Node.js 22 or later:

```sh
npm install
npm run check
npm test
npm run build
```

The CI workflow runs all three checks. The build uses Wrangler `--dry-run` and does not publish a Worker.

The integration suite starts two local HTTP servers (a fake application origin and an HTTP gateway wrapping the actual Worker engine) using `profiles/test-server.json`. It exercises HTML/JS/CSS, login, session cookies, token refresh, expiry, logout, rate limiting, SSE and origin enforcement. See [`test/README.md`](test/README.md).

## Deployment prerequisites

1. Replace the example profile with a profile whose public endpoints, credential scheme, and validation response have been verified against the actual backend and client versions.
2. Set `ORIGIN_URL` to a separate HTTPS hostname that reaches your server. The Worker intentionally disallows looping back to the public gateway hostname.
3. Bind a Workers KV namespace as `RECOGNIZED` in `wrangler.jsonc`. A valid namespace ID is required; none is pre-configured.
4. Create `HMAC_SECRET` and `ORIGIN_GATEWAY_SECRET` as Wrangler secrets, each at least 32 random characters. Do **not** store them in Git.
5. Configure the origin reverse proxy to **verify `X-CF-Auth-Gateway-Secret` on every request**, reject callers without it, and strip/override identity headers. A Cloudflare IP allowlist by itself does **not** prove a request came through this Worker.
6. Set a catch-all Worker Route for the public hostname with **fail-closed behavior**. Do not use `passThroughOnException` or allow cached protected responses to bypass the Worker.
7. Configure the provided `AUTH_FLOW_LIMITER` and `UNKNOWN_LIMITER` bindings; their thresholds are per Cloudflare location and approximate. Also use appropriate WAF/rate-limit rules for distributed attacks.
8. Test browser login, mobile clients, refresh flows, cookies and WebSockets with the **real** service before making the host public.

Example deployment instructions are deliberately not automated. The gateway's backend and Cloudflare account need to be configured correctly before deployment.

## Application profile

`profiles/example.json` demonstrates:

- `public` routes for the login shell, version metadata and a known static asset directory;
- `auth_flow` routes that forward the application's own login/refresh/logout requests;
- ordered `bearer` and named `cookie` credentials, each with a fixed validator endpoint;
- `retentionDays` (1–90), `validationTimeoutMs`, and `epoch` to invalidate previously recognized fingerprints when the validation contract changes.

The validator only considers an HTTP 200 JSON response with the configured **nonempty identity field** successful. HTTP redirects, login HTML, oversized payloads, and errors never count as successful validation. Your application-specific coding agent must verify that this response cannot be produced by unauthenticated callers.

## Security model and limitations

- Recognized **does not mean currently authorized**. An expired, revoked or stolen but previously recognized token can still reach the backend during retention. The backend must validate every protected request independently.
- A credential may be revalidated in another location while Workers KV is propagating its record.
- The gateway stores only HMAC fingerprints, not plaintext bearer tokens or cookies. The original credential still passes to the backend as part of the original request.
- Login and refresh endpoints must remain reachable by unauthenticated clients. They are still exposed to the internet and need abuse controls.
- Do not enable public self-registration if you expect this gateway to significantly restrict who can become recognized.
- WebSocket **handshakes** are filtered; messages inside an established WebSocket are not inspected. WebSocket clients using query-string tokens are **not** supported in v1.
- Apps using multiple independent session cookies, signed download URLs or custom auth protocols require explicit adapter work and tests.
- Cookie domains, reverse-proxy Host rules and login callbacks must be verified for each origin hostname.
- There is no dashboard, identity database, global strict rate limit or immediate credential revocation system. V1 is intentionally small and auditable.
