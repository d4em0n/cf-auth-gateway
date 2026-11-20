# Deploy an application

Use Node.js 22.13+ and `npm ci`. Run `npm run format:check`, `npm run lint`, `npm run check`, `npm test`, `npm run test:runtime`, and `npm run build` before deployment. Only development dependencies are installed; the Worker has no runtime dependencies.

1. Audit a version-specific declarative profile. For LibreChat v0.8.9, start with `profiles/librechat-v0.8.9.yaml`. Review the [compatibility scope](../librechat/README.md); illustrative `example.yaml` is not an application adapter.
2. Copy `wrangler.staging.jsonc` to ignored `wrangler.staging.local.jsonc`. Replace example hosts and the zero KV ID, add your account ID if needed, and set `ORIGIN_URL` to a distinct HTTPS hostname. Never attach the gateway profile to its origin hostname. Production has a separate template and must use a separate KV namespace and secrets.
3. Create storage with `npx wrangler kv namespace create RECOGNIZED --config wrangler.staging.local.jsonc`; put the returned ID in that config. Rate-limit namespace IDs are account-wide: choose distinct IDs for unrelated staging/production policies. Bindings use approximate per-IP counters per Cloudflare location, not global quotas. Refresh is deliberately not gateway-rate-limited; the application controls refresh abuse.
4. Generate independent random secrets (for example, `openssl rand -hex 32`). Install the origin secret at the reverse proxy first. Set `HMAC_SECRET` and `ORIGIN_GATEWAY_SECRET` with `npx wrangler secret put NAME --config wrangler.staging.local.jsonc`. Keep secret values out of command arguments and Git. When bootstrapping, Wrangler may create an undeployed Worker before secrets; no request should succeed until origin authentication is installed.
5. Set the profile hostname at build time and deploy:

   ```sh
   GATEWAY_HOSTNAME=chat-staging.example.com npx wrangler deploy --config wrangler.staging.local.jsonc
   ```

   The config's build command selects the LibreChat profile and writes an ignored `.generated/worker.js`. For another application, change that command's profile path. The generic default config builds `example.yaml` only. `GATEWAY_HOSTNAME` must equal the configured public route/domain; it is validated as a DNS name.

6. The gateway requires HTTPS ingress; plaintext requests receive 400 before reaching origin. You may additionally configure an edge HTTP-to-HTTPS redirect. Prefer a **Custom Domain** for a new dedicated gateway hostname: all paths terminate at the Worker, with no direct-origin DNS fallback. The templates disable `workers.dev` and preview URLs. With **Worker Routes**, use `hostname/*`, inspect more-specific exclusions/overriding routes, disable fail-open behavior and `passThroughOnException`, and keep the origin secret guard in place even if the route disappears. Do not assume a route is an access-control boundary by itself.
7. Configure LibreChat's staging `DOMAIN_CLIENT` and `DOMAIN_SERVER` to the public staging URL, secure host-only cookies, trusted reverse-proxy hops and the same auth modes as the selected profile. Keep the actual origin hostname out of application-generated links. Do not rewrite cookie domains blindly.
8. Verify [origin bypass resistance](origin.md), browser login/assets, native clients, real model streaming, expiry/refresh, logout, uploads/downloads and resumption on staging. See [test setup](../librechat/testing.md). Production cutover requires an independent owner decision; this repository does not automate it.

Cloudflare references: [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), [Routes](https://developers.cloudflare.com/workers/configuration/routing/routes/), [rate-limit semantics](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), [KV consistency/write limits](https://developers.cloudflare.com/kv/api/write-key-value-pairs/).
