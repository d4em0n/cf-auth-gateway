# Architectural decisions

## Recognition, not authorization

The Worker limits how much of the upstream application is reachable by an unauthenticated caller. A cached fingerprint records that the token was **previously** accepted by the origin; it is not a promise that the token remains valid. Access is still controlled by the application.

The registry uses an HMAC-SHA256 fingerprint. The key contains the app ID, profile epoch and credential-scheme ID. A fixed KV expiration is applied on the **first** successful validation; reads never extend it.

## Route classification

All requests are protected unless they match a validated public or authentication-flow rule by both path and method.

- Public routes may include login HTML, JavaScript, CSS, fonts, and safe metadata. Never use a generic file-extension bypass.
- Authentication-flow routes forward to the original backend, with selective rate limiting on configured login routes.
- Protected routes require a recognized credential or successful validation on first use.
- WebSocket upgrades are always treated as protected, including upgrades to paths otherwise public.

The same canonical URL is used for route classification and proxying. URL paths containing encoded characters are never classified public; a known credential is still allowed to pass them to the origin.

## Credential extraction

Profiles explicitly list supported bearer and named-cookie schemes. The first present scheme takes precedence, which handles native apps that send an access bearer plus a refresh cookie. A malformed Authorization header does not fall back to a cookie. No third-party authorization header conventions or executable extensions are allowed in profiles.

## First-use validation

The Worker sends the unknown credential to the configured validator endpoint on the **fixed** trusted origin, with redirects disabled, a timeout, and a 16 KiB response cap. A 200 response is only accepted if it is JSON and contains the configured nonempty identity field. This must be tested against real valid/invalid credentials.

If KV is unavailable, the Worker can still validate with the origin and forward that validated request. If validation cannot be performed, unknown credentials fail closed.

## Origin trust

A shared Cloudflare IP allowlist does not prevent a different Cloudflare route from reaching a public IP. The origin must verify a gateway-specific secret or an equivalent authenticated origin channel. The Worker replaces any client-provided gateway secret before forwarding.

## Boundaries not covered

This is **not** independent user authentication, anti-replay, fine-grained authorization, global per-user revocation, traffic inspection inside WebSockets, or protection against malicious users who can legitimately log in.

The public login route is intentionally exposed. Distributed attackers can still attempt abuse; the in-Worker rate limiter is a local approximation.
