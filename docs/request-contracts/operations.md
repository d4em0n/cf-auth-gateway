# Migration and operation

## Existing deployments

The original `profiles/*.json` files remain **unchanged schema-v1 compatibility snapshots**, without contracts. Explicit builds selecting those files still work; schema-v1 rejects `request` rather than ignoring it. The new `profiles/*.yaml` files use schema 2. Schema 2 also works in a `.json` file, and schema 1 can be written in YAML. Schema version controls features, not file extension.

The default example build and supplied staging/production templates now select YAML. Existing deployed Workers do not change until rebuilt and deployed. Existing copied local Wrangler files retain their chosen profile until deliberately edited. The staging deployment for this feature was explicitly changed to YAML; production was not changed. Do not assume editing a YAML profile updates a legacy build that still names JSON.

To migrate your own profile:

1. Copy its existing data to YAML without changing application ID, hostname, epoch, credential order, validators, retention or route matches. Use `.yaml` or `.yml`.
2. Set `schemaVersion: 2`, then add optional `request` blocks only after inspecting the application's actual client/server protocol. Split a multi-path route if those endpoints need different contracts; retain its paths, methods, access and rate-limit policy.
3. Update the Wrangler build command or `GATEWAY_PROFILE` to the exact new filename. Explicit CLI filenames take precedence over the environment variable. `GATEWAY_HOSTNAME` still overrides only the deployment hostname.
4. Run the checks below and deploy on an isolated staging hostname first.

```sh
GATEWAY_PROFILE=profiles/my-app.yaml node scripts/prepare-worker.js
npm run check
npm run format:check
npm run lint
npm test
npm run test:runtime
# Use your staging config with real bindings and its explicit profile build command.
npx wrangler deploy --dry-run --config wrangler.staging.local.jsonc
```

The example is illustrative; audit another application's public routes and its own credential validator. Keep public assets explicitly allowlisted. Do not expose new paths simply to make a client error disappear.

## Testing new contracts

Use the independent YAML test profile and HTTP fixture as a pattern. Assert valid bodies retain exact bytes, malformed cases never reach origin, and protected uploads/SSE/WebSockets still work. `npm run test:runtime` checks actual workerd parsing/proxy behavior, including chunked size limits. Keep schema-v1 compatibility tests.

Capture field **names**, media types and byte counts from real browser/native requests, never passwords/tokens in test output. Test every enabled login/refresh/MFA mode, automatic refresh during parallel requests, reload and logout against a disposable instance. The [LibreChat suite](../librechat/testing.md) includes real browser/API contract probes; its separate MFA check requires a fresh secondary account. Compare trusted direct behavior, and verify harmless rejection markers are absent from the origin's access log. Hosted CI alone cannot establish app compatibility or origin filtering.

## Rollback and troubleshooting

For a broken contract, redeploy the previous known-good Worker version, or remove only the offending `request` block and rebuild/deploy. Alternatively select the preserved schema-v1 JSON profile after checking its route allowlist is still appropriate. Do not widen routes, disable backend authentication, rotate HMAC secrets or change epochs merely to roll back a request contract. Contract changes do not invalidate recognition or add KV entries.

For 400, compare allowed/required field names, primitive types, string lengths and denied header presence. For 413, inspect actual byte counts, including whitespace. For 415, check the full media type/charset and encoding; native libraries sometimes add an empty object to an otherwise bodyless POST. For 408, inspect slow/disconnected clients before changing anything. A valid contracted request may still receive backend 400/401/403 or gateway 429/502/503 under the existing policies. Check origin logs by metadata to distinguish gateway rejection from backend rejection; do not log credential bodies.

## Limits and bypass scenarios

- This is a small flat-JSON contract, not JSON Schema, a WAF, a semantic sanitizer or proof that the backend is safe. Valid strings can still exploit backend bugs. Header denial covers only explicitly named headers.
- Routes without contracts are unchanged. An earlier overlapping public rule without a contract wins; audit ordered rules and avoid alternate public paths to the same handler.
- Protected callers can submit any body accepted by the original backend. A recognized but expired credential can still reach it by the agreed design. Authentication and authorization must remain enforced there.
- Query parameters, cookies, redirects, protocol framing and backend interpretation of duplicated HTTP headers are outside body contracts. Existing method-override and path rules remain in effect. Upstream proxies must not rewrite a public route into a different protected handler or decode ambiguous paths differently.
- Direct-origin access bypasses all Worker contracts; the independent origin secret and closed application port remain mandatory. Encoded/noncanonical paths retain the existing protected policy, not a new public exception.
- Size/time limits bound a single inspected request, not global concurrency or volumetric attacks. Contract rejection occurs before the authentication limiter; use Cloudflare's existing edge protections for abusive pre-auth traffic.
- This feature adds no upload parser, JSON nesting, scripting, user database, new backend validation or identity/session behavior. It does not broaden the previously verified auth modes or native platforms.
