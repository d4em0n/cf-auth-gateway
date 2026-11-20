# Cloudflare authentication gateway

A lightweight, declarative Cloudflare Worker that limits unauthenticated exposure of self-hosted applications. The backend keeps its own login, sessions and authorization. The Worker has **no runtime dependencies** or identity database.

**Status: draft production hardening, staging verified. No production cutover.** The [LibreChat compatibility report](docs/librechat/README.md) identifies tested versions, evidence and remaining limits. Review that scope before deploying.

## Request policy

1. Explicit public HTML/assets/config and authentication lifecycle routes pass their optional request contract, then existing rate limits, before reaching the backend.
2. Protected requests without an acceptable credential stop at the gateway.
3. Recognized credential fingerprints go directly to the backend.
4. Unknown credentials are selectively rate-limited and validated by a fixed backend-owned endpoint. Only a successful JSON identity response permits forwarding and fingerprint recognition.

**Recognized does not mean currently authenticated.** An expired/revoked recognized credential can still reach the backend, which must reject it independently. Fingerprints have fixed retention (default 30 days, maximum 90); reads never extend it. KV is eventually consistent, not a revocation store.

Profiles contain data only. Routes match exact methods and literal paths or known directory prefixes; no file-extension bypass exists. Ordered bearer/cookie schemes have explicit validators. LibreChat's refresh cookie and Agent API keys are not session-JWT credentials.

Protected and uncontracted HTTP bodies, uploads/downloads, SSE and WebSocket connections stream through the gateway. WebSocket upgrades always require protected-route authentication, including on otherwise public paths. Requests never choose the origin, and origin authentication must be enforced independently of Cloudflare source IPs.

## Checks

Node.js 22.13+:

```sh
npm ci
npm run format:check
npm run lint
npm run check
npm test
npm run test:runtime
npm run build
```

CI runs formatting/lint, strict profile validation, unit/security/real-HTTP tests, real workerd/Miniflare streaming/WebSocket tests and a Wrangler dry-run. The separate manual LibreChat workflow exercises an isolated real deployment with private test credentials.

## Source map

| Module                            | Responsibility                                            |
| --------------------------------- | --------------------------------------------------------- |
| `src/gateway.js`                  | Auditable request policy and explicit failure responses   |
| `src/profile.js`                  | Strict declarative configuration and route classification |
| `src/request-contract.js`         | Bounded public-body checks and unchanged-byte forwarding  |
| `src/request-contract-profile.js` | Strict request-contract configuration                     |
| `scripts/load-profile.js`         | Build-time safe YAML/legacy JSON loader                   |
| `src/credentials.js`              | Credential extraction and scoped HMAC fingerprints        |
| `src/first-use.js`                | Bounded in-flight validation coalescing within an isolate |
| `src/validation.js`               | Fixed, bounded, timed backend validator                   |
| `src/recognition.js`              | Fixed-retention KV registry and outage behavior           |
| `src/rate-limit.js`               | Selective Cloudflare location-local limits                |
| `src/origin.js`                   | Origin secret, headers, redirects and streaming proxy     |
| `scripts/prepare-worker.js`       | Build a selected profile into the Worker entry point      |

`profiles/example.yaml` is illustrative. `profiles/test-server.yaml` and its HTTP fixture remain independent generic tests. `profiles/librechat-v0.8.9.yaml` targets the source-inspected and staging-tested LibreChat version. Original schema-v1 JSON profiles remain supported as compatibility snapshots; existing deployed Workers change only after a deliberate rebuild/deployment.

## YAML request contracts

Schema-v2 YAML profiles optionally embed `request` in public/authentication-flow rules. Contracts bound actual body bytes, restrict Content-Type, validate flat JSON fields and deny explicitly named framework headers. Valid bytes are forwarded unchanged; invalid requests stop before the backend. Protected bodies and WebSocket authentication retain their existing behavior. YAML is parsed safely at build time and adds no Worker runtime dependency.

```yaml
# Fragment of a schemaVersion: 2 profile's routes array
- access: auth_flow
  methods: [POST]
  exact: [/api/auth/refresh]
  request:
    maxBodyBytes: 0
```

The [request-contract guide](docs/request-contracts/README.md) includes complete copyable YAML, every supported property, defaults, migration, staging tests, LibreChat contracts, limits and rollback.

## Deploy and operate

Use a separate staging hostname first. [Deployment instructions](docs/deployment/README.md) cover KV/secrets/rate limits, Wrangler staging and production templates, Custom Domains versus Routes, HTTPS, Nginx origin-secret enforcement, bypass tests, profile changes, rollback, secret rotation and troubleshooting. Real account identifiers and secrets belong in ignored local configuration or secret bindings.

The [threat model](docs/threat-model.md) describes the boundary. A Cloudflare IP allowlist or global Authenticated Origin Pulls certificate does **not** identify this Worker. Keep raw app ports private and reject origin requests without the gateway secret on every path and alternate virtual host. Never remove backend authentication.

See [all documentation](docs/README.md), [test-suite details](test/README.md), and [real LibreChat test setup](docs/librechat/testing.md).
