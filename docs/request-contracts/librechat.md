# LibreChat v0.8.9 contracts

Target: the same isolated installed v0.8.9 derivative, commit `d4e85d2205c78413ee27d631d7e3b7313556f21d`. Profile: [`profiles/librechat-v0.8.9.yaml`](../../profiles/librechat-v0.8.9.yaml). No public paths/methods were added or removed. The existing MFA rule was split to give the challenge endpoint its own contract; rate limiting is unchanged.

| POST route                  | Enforced request                                                                                                                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/auth/login`           | `application/json`, ≤8192 bytes; required string `email` ≤320 and `password` ≤128; no extra fields.                                                                                                       |
| `/api/auth/refresh`         | Empty body, zero bytes. Authentication remains backend-owned refresh cookies.                                                                                                                             |
| `/api/auth/logout`          | Empty body, zero bytes. Backend still requires the access JWT.                                                                                                                                            |
| `/api/auth/2fa/verify-temp` | `application/json`, ≤12288 bytes; required string `tempToken` ≤8192; optional strings `token` ≤32 and `backupCode` ≤256; no extra fields. Backend verifies challenge purpose, account, expiry and factor. |

Login and MFA challenge also reject `Next-Action` and `X-Middleware-Subrequest` header presence. These are optional defensive restrictions for protocols LibreChat does not use, not claims that LibreChat uses Next.js. GET/HEAD HTML/assets, GET `/api/config`, and the disabled required-enrollment setup flow have no request contracts.

The gateway does not enforce email syntax, minimum password length, exactly one factor, JWT purpose/signature, or a six-digit TOTP format. Those remain LibreChat decisions. Size/string limits bound the supported request formats; the password cap matches installed server validation. The optional MFA caps are conservative envelope limits, not newly asserted backend semantics.

## Evidence and scope

**Confirmed by source inspection:** installed `api/strategies/validators.js` login schema declares email/password and maximum password length 128. `packages/data-provider/src/data-service.ts` and `request.ts` send only login fields and bodyless refresh/logout. Conduit's `packages/conduit_core/lib/features/librechat/services/librechat_auth_service.dart` sends the same shapes and optional `{tempToken, token}` or `{tempToken, backupCode}`. Installed `packages/api/src/auth/enrollment.ts` consumes those challenge fields. The authentication route list in `api/server/routes/auth.js` has not changed.

Required pre-login enrollment is not enabled (`ENFORCE_TWO_FACTOR_AUTHENTICATION` is unset/false). Its source-declared bodies are `{tempToken}` for setup/cancel, `{tempToken, token}` for confirm, `{acknowledgementToken}` for acknowledgement and `{finalizationToken}` for finalize. Those routes remain explicitly allowlisted/rate-limited **without contracts** until a real required-enrollment lifecycle is verified. Registration/password reset/social/passkey routes retain the existing unsupported/protected policy; no unverified public POST was added.

Local, real-edge, browser/native and MFA results for this change are recorded in the [compatibility results](../librechat/results.md). Physical iOS, required enrollment, federated auth, Agent API keys and multi-region KV behavior are not established by these tests.
