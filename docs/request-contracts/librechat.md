# LibreChat v0.8.9 contracts

Target: the same isolated installed v0.8.9 derivative, commit `d4e85d2205c78413ee27d631d7e3b7313556f21d`. Profile: [`profiles/librechat-v0.8.9.yaml`](../../profiles/librechat-v0.8.9.yaml). No public paths/methods were added or removed. MFA rules are split by their verified body shape; rate limiting is unchanged.

| POST route                                          | Enforced request                                                                                                                                                                                          |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/auth/login`                                   | `application/json`, ≤8192 bytes; required string `email` ≤320 and `password` ≤128; no extra fields.                                                                                                       |
| `/api/auth/refresh`                                 | Empty body, zero bytes. Authentication remains backend-owned refresh cookies.                                                                                                                             |
| `/api/auth/logout`                                  | Empty body, zero bytes. Backend still requires the access JWT.                                                                                                                                            |
| `/api/auth/2fa/verify-temp`                         | `application/json`, ≤12288 bytes; required string `tempToken` ≤8192; optional strings `token` ≤32 and `backupCode` ≤256; no extra fields. Backend verifies challenge purpose, account, expiry and factor. |
| `/api/auth/2fa/setup`, `/api/auth/2fa/setup/cancel` | `application/json`, ≤12288 bytes; required string `tempToken` ≤8192; no extra fields.                                                                                                                     |
| `/api/auth/2fa/setup/confirm`                       | `application/json`, ≤12288 bytes; required strings `tempToken` ≤8192 and `token` ≤32; no extra fields.                                                                                                    |
| `/api/auth/2fa/setup/acknowledge`                   | `application/json`, ≤12288 bytes; required string `acknowledgementToken` ≤8192; no extra fields.                                                                                                          |
| `/api/auth/2fa/setup/finalize`                      | `application/json`, ≤12288 bytes; required string `finalizationToken` ≤8192; no extra fields.                                                                                                             |

Login and all public MFA routes also reject `Next-Action` and `X-Middleware-Subrequest` header presence. These are optional defensive restrictions for protocols LibreChat does not use, not claims that LibreChat uses Next.js. GET/HEAD HTML/assets and GET `/api/config` have no request contracts. Authenticated factor-management routes remain protected and their bodies are not inspected.

The gateway does not enforce email syntax, minimum password length, exactly one factor, JWT purpose/signature, or a six-digit TOTP format. Those remain LibreChat decisions. Size/string limits bound the supported request formats; the password cap matches installed server validation. The optional MFA caps are conservative envelope limits, not newly asserted backend semantics.

## Evidence and scope

**Confirmed by source inspection:** installed `api/strategies/validators.js` login schema declares email/password and maximum password length 128. `packages/data-provider/src/data-service.ts` and `request.ts` send only login fields and bodyless refresh/logout. Conduit's `packages/conduit_core/lib/features/librechat/services/librechat_auth_service.dart` sends the same shapes and optional `{tempToken, token}` or `{tempToken, backupCode}`. Installed `packages/api/src/auth/enrollment.ts` consumes those challenge fields. The authentication route list in `api/server/routes/auth.js` has not changed.

Required pre-login enrollment is disabled in ordinary staging and production. The five setup contracts were verified against source-declared browser request types and a **separate disposable backend** with `ENFORCE_TWO_FACTOR_AUTHENTICATION=true`, using real LibreChat behind local workerd. Setup/cancel, TOTP confirmation, acknowledgement, finalization, backend rejection of replayed finalization, subsequent MFA login and protected access passed. No authentication settings on the existing staging or owner instance changed. This is HTTP/runtime verification; browser/native enrollment-screen acceptance is not claimed.

Registration/password reset/social/passkey routes retain the existing unsupported/protected policy; no public POST was added.

Local, real-edge, browser/native and MFA results for this change are recorded in the [compatibility results](../librechat/results.md). Physical iOS, required-enrollment browser/native UI, federated auth, Agent API keys and multi-region KV behavior are not established by these tests.
