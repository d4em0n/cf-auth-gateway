# Isolated LibreChat tests

The integration requires a real LibreChat server, disposable verified account, working model provider, enabled image uploads/downloads, and a short access-token lifetime (60 seconds). It deliberately creates synthetic conversations, a roughly 200-word streamed response for an active resumption check, and an 8×8 PNG. Never use an owner's account/database. Do not upload browser screenshots, traces, cookies, account files or server logs to public CI artifacts.

## Existing staging Worker

Create a mode-600 `account.json` in a private directory with `email` and `password` (optionally `name`/`username`). Staging must have the same model endpoint name **QA Gateway** and default model **gpt-6.1-sol** as the supplied fixture configuration. Set the public staging hostname as LibreChat's DOMAIN_CLIENT/DOMAIN_SERVER. Local registration can remain disabled.

```sh
npm ci
npx playwright install --with-deps chromium
GATEWAY_QA_DIR=/private/qa GATEWAY_QA_URL=https://chat-staging.example.com npm run test:librechat
```

The browser uses real HTTPS verification for remote tests. `BROWSER_EXECUTABLE` can select an installed compatible Chromium. Optional `LIBRECHAT_QA_DIRECT_URL` enables authenticated byte/JSON comparisons to trusted private backend access. Results contain booleans/status codes only; screenshots contain only this disposable account. The runner listens for automatic refresh before expiry so refresh timing does not depend on page reload.

For origin-log proof, additionally set `GATEWAY_QA_ORIGIN_LOG` to **only the staging vhost's access log** and run `node test/librechat/origin-proof.js`. It uses harmless unique query markers to prove missing/invalid credentials never reach protected handlers, valid first use reaches origin, a recognized hit skips validation, and a recognized expired JWT reaches LibreChat and receives 401. Ensure unrelated authenticated tests are stopped during the measured log intervals.

A separate `Isolated LibreChat compatibility` workflow is manually dispatched in the `librechat-staging` GitHub environment. Supply `LIBRECHAT_QA_URL` and `LIBRECHAT_QA_ACCOUNT_JSON` secrets for an isolated deployment; it runs the remote browser/API suite without publishing sensitive artifacts. It does not create infrastructure or cut over traffic. Hosted CI cannot inspect private origin logs; run that proof separately on the trusted host. Check the chosen workflow ref before running it with secrets. A new workflow existing only on this draft branch may return 404 from the dispatch API until it is present on the default branch; use the trusted-host command meanwhile. No merge is required for the host-run suite.

## Local same-image fixture

`test/librechat/compose.yaml` uses an independent database/network and loopback port 3096. Default image is the locally installed derivative; set `LIBRECHAT_IMAGE` to the pinned upstream image for a stock comparison. It never mounts production data. `prepare.py /private/fresh-directory` generates secrets and copies only the existing server-side model-provider key from the known local deployment; it is a host-specific helper, not a general Cloudflare installer. Review provider URL/network settings for another host.

```sh
python3 test/librechat/prepare.py /private/fresh-directory
export GATEWAY_QA_DIR=/private/fresh-directory
# The generated directory must be owned by the container UID (1000).
docker compose -f test/librechat/compose.yaml up -d
# Wait for http://127.0.0.1:3096/health to return 200.
docker compose -f test/librechat/compose.yaml cp test/librechat/seed.cjs api:/app/config/gateway-seed.cjs
docker compose -f test/librechat/compose.yaml exec -T api node /app/config/gateway-seed.cjs < "$GATEWAY_QA_DIR/account.json"
```

Generate a private self-signed QA certificate/key as `tls.crt`/`tls.key` with SAN `chat.example.com`, `origin.fixture.test`, and IP `127.0.0.1`. Set local staging DOMAIN_CLIENT/DOMAIN_SERVER to `https://chat.example.com:19444`. With no `GATEWAY_QA_URL`, the runner starts an actual workerd/Miniflare HTTPS gateway on loopback 19444, a secret-enforcing TLS origin on 19443, and trusts only the QA origin certificate. Chromium maps chat.example.com to loopback; certificate bypass is confined to this local browser fixture. No production TLS bypass is present.

Stop only this fixture with `docker compose -f test/librechat/compose.yaml down`. Private bind state remains for inspection; delete it deliberately when finished. Local and remote results are separate files. The real model provider can charge ordinary inference usage; synthetic messages request only a short marker.

On the trusted Docker host, `node test/librechat/account-proof.js` additionally exercises the disposable user deletion fence and never-recognized expired credentials. It refuses to mutate databases other than `gateway_qa`, restores the fence in a finally block and should run after browser/native tests have finished. This uses the backend’s account-unavailable state; it does not introduce a gateway identity database.

## Request contracts and optional MFA

The runner selects the schema-v2 YAML profile locally and probes malformed public requests before its browser flow. Remote staging must be explicitly rebuilt from `profiles/librechat-v0.8.9.yaml`; legacy JSON deliberately has no contracts. Browser evidence records field names and byte counts only. The local adapter serializes Node FormData before handing wire bytes to Miniflare's separate fetch classes.

`origin-proof.js` also sends the public-contract probes with a unique harmless marker and proves that marker never appears in the staging origin log. This checks rejection at the Worker rather than a matching backend error.

To verify optional TOTP/backup-code challenge contracts, seed a **fresh secondary disposable account** using `seed.cjs` and a separate private account file, then run:

```sh
GATEWAY_QA_DIR=/private/qa \
GATEWAY_QA_URL=https://chat-staging.example.com \
GATEWAY_QA_MFA_ACCOUNT=/private/qa/fresh-mfa-account.json \
node test/librechat/mfa.js
```

This deliberately enrolls MFA on that secondary account, verifies TOTP and backup-code login, rejects a used backup code and checks an extra field is stopped. It leaves that disposable account enrolled; rerunning requires another fresh account. It never changes global authentication configuration. Required enrollment has its own isolated check below. The ordinary remote workflow needs only its normal disposable account and does not run this opt-in account mutation.

## Required-enrollment POST contracts

Use a **fresh** QA directory, separate Compose project/database, free subnet, and loopback port 3097. Never enable enforced MFA on the owner instance or normal staging simply to run this check. `prepare.py` creates independent secrets/data; edit only this new directory's `librechat.env` to add `ENFORCE_TWO_FACTOR_AUTHENTICATION=true` and set DOMAIN_CLIENT/DOMAIN_SERVER to `https://chat.example.com:19444`. Keep `MONGO_URI=mongodb://mongo:27017/gateway_qa` for that separate project's own MongoDB. Generate its QA TLS certificate as described above.

```sh
export GATEWAY_QA_DIR=/private/fresh-required-mfa
export GATEWAY_QA_PORT=3097
export GATEWAY_QA_SUBNET=10.190.87.0/24
# Choose an unused subnet on your host.
docker compose -p cf-auth-required-mfa-qa -f test/librechat/compose.yaml up -d
docker compose -p cf-auth-required-mfa-qa -f test/librechat/compose.yaml cp test/librechat/seed.cjs api:/app/config/gateway-seed.cjs
docker compose -p cf-auth-required-mfa-qa -f test/librechat/compose.yaml exec -T api node /app/config/gateway-seed.cjs < "$GATEWAY_QA_DIR/account.json"
node test/librechat/required-mfa.js
docker compose -p cf-auth-required-mfa-qa -f test/librechat/compose.yaml down
```

The runner starts the YAML-profile workerd gateway/TLS origin locally and targets only backend loopback port 3097. It tests cancellation and the full setup → TOTP confirmation → backup-code acknowledgement → finalization sequence, rejects replay, verifies subsequent MFA login/private access, and proves malformed input stops before origin. It leaves the disposable account enrolled; use another fresh account for another run. Logs/results contain status metadata, never tokens or TOTP secrets. It does not test the enrollment screens in a browser/native client or change public callback/SPA routes.

The MongoDB fixture sets `nofile=64000`: LibreChat creates enough collections/indexes to exhaust Docker's 1024-file soft default, especially if multiple databases are created on one MongoDB. Keep required-MFA testing in its separate database/container; a WiredTiger open-file failure must not be worked around by changing production.
