# Threat model

The gateway reduces unauthenticated exposure of a fixed application origin. It is an exposure filter, not an identity provider, second factor, JWT authority or authorization service.

An attacker may choose methods, paths, query strings, bodies, cookies and ordinary headers. The trusted components are the selected declarative profile, Worker deployment/secrets, Cloudflare ingress, TLS and the backend's authentication/authorization. The origin must authenticate this gateway independently of its network source.

- Unlisted routes require a credential. Unknown credentials must produce HTTP 200 JSON with a nonempty identity at a fixed application-owned validator. Redirects, errors, timeouts, malformed/oversized JSON and unavailable limiters fail closed.
- KV holds HMAC fingerprints scoped by application, profile epoch and credential scheme. It stores no plaintext credentials. Reads never renew retention (30 days by default; maximum 90). Concurrent regional misses can validate/write again; KV cannot guarantee an atomic first-ever write or global expiry boundary.
- Recognition means previously accepted. Expired, revoked, disabled and stolen recognized credentials may reach the backend until registry expiry. The backend must enforce its own authentication and resource permissions on every request. Logout semantics remain those of the backend.
- Public login/refresh and allowed assets remain attackable. Registration is excluded from the LibreChat profile. Legitimate users and stolen valid credentials can become recognized. Local approximate rate limits are neither global quotas nor distributed attack protection.
- In-flight validation coalescing is bounded to 256 fingerprints per isolate. It shares only a scalar decision, never persists an authentication result, and cannot coordinate regions. A saturated map fails closed.
- Plaintext ingress is rejected before forwarding, so the gateway never returns login tokens/cookies over HTTP. Upstream destination and validator are fixed. Caller Host/forwarding/routing headers are removed or replaced. Redirects are not followed with secrets. Same-origin absolute redirects are rewritten to the public host; external redirects remain the application's responsibility.
- All forwarded responses disable shared caching. There is no application-body buffering or scanning. SSE and WebSocket handshakes are gated; established WebSocket messages remain the backend's responsibility.
- Cloudflare IP allowlisting and global Authenticated Origin Pulls do not identify this Worker. Require a private gateway secret on every origin path or separately scoped mTLS, including alternate virtual hosts. Keep app ports private and preserve HTTPS verification on every hop.

Not covered: malicious backend code, compromised Cloudflare/account/secrets, backend authentication bugs, XSS, application CSRF, prompt injection, content inspection, denial of service within provider limits, or immediate global revocation. Browser service workers and private caches are application-owned; the gateway cannot erase data a client already received.
