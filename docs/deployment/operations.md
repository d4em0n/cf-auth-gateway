# Rollback, secret rotation and troubleshooting

Rollback code with `npx wrangler rollback VERSION_ID --config wrangler.staging.local.jsonc`, or redeploy a known reviewed Git commit and its matching profile. Record the deployed version before changing it. Keep the origin secret guard and TLS/firewall policy during rollback; removing a Worker Route must not reopen the app. Configuration, route bindings and secrets need separate rollback planning: an old Worker version referencing an old origin secret will fail if the proxy only accepts the new one.

Rotate HMAC secrets with `wrangler secret put HMAC_SECRET`. All existing registry keys become unreachable, so valid credentials revalidate; old expired keys can age out naturally. Expect a validation burst and stage limiter capacity first. There is no previous-key fallback or automatic migration.

Rotate the origin secret by temporarily accepting exactly the old and new random values at the proxy, deploying the new Worker secret, testing every path, then removing the old value. Keep the overlap brief. To revoke a compromised gateway secret immediately, replace it at the proxy first; temporary 403 is safer than retaining unauthorized origin access. Do not log the values.

Increment the profile's `epoch` and rebuild/redeploy to invalidate recognition after changing validators/credential policy. It does not revoke backend sessions; backend revocation remains independent. Fixed retention is 30 days by default, configurable 1–90. Reads do not extend it. KV is eventually consistent, with up to 60 seconds or cache TTL visibility delay and one write/second/key limits; cross-region concurrent first use can validate/write again. Do not use it as a revocation database.

| Result | What to inspect                                                                                                                                                                                                 |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | Method-override headers/query, unsupported Upgrade or non-GET WebSocket                                                                                                                                         |
| 401    | Missing/malformed credential; duplicate cookies; wrong credential class; validator rejected identity. A forwarded backend 401 can also mean expiry/revocation. Compare redacted origin metadata to distinguish. |
| 403    | Origin secret mismatch, origin/WAF rules or backend permissions; check which hop returned it.                                                                                                                   |
| 421    | Public request hostname differs from the compiled profile.                                                                                                                                                      |
| 429    | Login/unknown validation limiter or backend limiter. Recognized requests do not call the Worker limiter. Local counters are approximate; inspect backend client-IP forwarding too.                              |
| 502    | Origin connection/TLS failure or invalid WebSocket handshake. Verify fixed origin host, certificate, firewall and app health.                                                                                   |
| 503    | Missing secret/config, unavailable rate limiter, validator outage/timeout or an internal gateway exception. Unknown credentials are never forwarded on these failures.                                          |

A KV read failure triggers validation; a failed KV write leaves only the current freshly validated request allowed. Diagnose KV binding/quotas and increased validator traffic. In-flight coalescing reduces bursts in an isolate, with no promise of global single-flight behavior. Never troubleshoot by logging tokens or changing a protected route to public.
