# cf-auth-gateway

Experimental, profile-driven authentication-aware request filter on Cloudflare Workers.

**Goal:** Keep normal browser and native iOS/Android app logins working, but block most unknown unauthenticated requests before they reach a self-hosted application's protected API. The application **still performs all real authorization**.

## How it works

1. Exact public routes (login page, CSS, JS, safe version endpoints) and explicitly listed authentication lifecycle routes are proxied as-is.
2. Protected requests must carry a configured bearer token or named session cookie.
3. The Worker computes an HMAC-SHA256 fingerprint (not a raw stored token) and looks it up in Workers KV.
4. Unknown credentials are sent to a **fixed upstream validation endpoint** with only the credential and an optional private gateway origin header.
5. A valid JSON response with a nonempty configured user identity field permits the request and creates a fixed-lifetime KV record. Recognition lasts 30 days by default even if the underlying token has since expired. The backend remains responsible for expiry, revocation, and permissions.
6. Unknown invalid credentials fail closed. Previously recognized credentials are forwarded without revalidation; this is **not** an independent authentication factor.

## Getting started (example profile is NOT for production)

- Install Node.js 22+, run `npm install`, `npm test`, `npm run check`, and `npm run build`.
- Copy `profiles/example.json` to an application-specific profile. Adjust `src/index.js` to import that profile. Confirm all login, refresh, asset, cookie, and validation paths against the actual backend; the supplied paths are **illustrations only**.
- Set `ORIGIN_URL` as a Worker environment variable to an **HTTPS origin hostname distinct from the public gateway hostname**. Never point it back to the gateway or it can create a proxy loop. The origin must be reachable by Cloudflare and preserve the app's expected host and cookie behavior.
- Create a Workers KV namespace and bind it in `wrangler.jsonc` as `RECOGNIZED`. Generate a random `HMAC_SECRET` with at least 32 characters using `wrangler secret put HMAC_SECRET`. Optionally configure `ORIGIN_GATEWAY_SECRET` using `wrangler secret put ORIGIN_GATEWAY_SECRET`.
- Deploy only after configuring a catch-all Worker route for the application hostname, **fail-closed routing**, origin-side bypass protection, and verified app profile tests.
- Ensure the reverse proxy at your actual origin **checks** the injected gateway secret (or uses a zone-specific mTLS/AOP origin control). Cloudflare IP allowlisting alone is insufficient. Do not deploy a gateway secret that the origin does not validate.
- Avoid public registration if you want this to materially reduce who can gain backend access; any valid registered account can mint a recognized credential.

## Profile contract

JSON schema version 1; no executable profile code. Every route rule is either `public` or `auth_flow`, with exact methods and literal paths or constrained path prefixes. Unmatched routes are protected. Credentials are `bearer` or named `cookie`; each specifies a fixed validation method/path and dot-separated JSON field containing a nonempty string identity. Profile changes can increment `epoch` to ignore old fingerprints. Retention may be 1–90 days.

**No generic CSS/JS extension bypass**: only approved asset directories should be public. Sensitive HTML and API responses must not be shared-cacheable.

## Boundaries and known limitations

- A remembered credential, even if expired or stolen, can reach the backend until its fingerprint expires. The backend must continue authenticating every request and checking per-resource permissions.
- A new credential requires a backend validation call. This implementation has no single-flight coalescing or explicit rate limiter yet. Before exposing a production service, add Cloudflare WAF/rate limits to login, refresh, and credential-miss paths.
- Cookies are simplistic named values. Compound cookie authentication, OAuth redirects, CSRF/session variants, cross-origin redirects, signed download links, WebSockets, and specialized client protocols require profile-specific verification and integration tests.
- Validations use bounded 16 KiB JSON response bodies, timeouts, and do not follow redirects.
- The gateway does not have an emergency blocklist yet; origin authorization is authoritative.
- Workers KV may be eventually consistent; a brand-new fingerprint can be revalidated in another region. It cannot guarantee global instantaneous revocation.
- Do not publish secrets, cache protected responses ahead of the Worker, or configure Worker fallback to bypass processing.
- HTTPS origin hostname may require configuration of Host/SNI/TLS and cookie-domain behavior for your specific application. Test it end-to-end before enabling traffic.
- This repository contains a generic proof-of-concept, **not a verified LibreChat adapter**, and is not production ready.

## CI

GitHub Actions checks example profile validity, Node tests, and a Wrangler dry-run bundle on pull requests.
