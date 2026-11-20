import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import profile from '../../profiles/librechat-v0.8.9.json' with { type: 'json' };
import { bundle } from '../runtime/harness.js';

export async function startGateway(directory, secret) {
  const script = await bundle(`
    import { createGateway } from './src/gateway.js';
    const handle = createGateway(${JSON.stringify(profile)});
    export default {fetch: handle};
  `);
  const runtime = new Miniflare({
    host: '127.0.0.1',
    port: 19444,
    https: true,
    httpsKeyPath: directory + '/tls.key',
    httpsCertPath: directory + '/tls.crt',
    modules: true,
    script,
    compatibilityDate: '2026-07-01',
    kvNamespaces: ['RECOGNIZED'],
    ratelimits: {
      AUTH_FLOW_LIMITER: { namespace_id: '1001', simple: { limit: 100, period: 60 } },
      UNKNOWN_LIMITER: { namespace_id: '1002', simple: { limit: 100, period: 60 } },
    },
    bindings: {
      ORIGIN_URL: 'https://127.0.0.1:19443',
      ORIGIN_GATEWAY_SECRET: secret,
      HMAC_SECRET: 'disposable-qa-hmac-with-at-least-32-characters',
    },
    outboundService: {
      network: {
        allow: ['127.0.0.1/32'],
        tlsOptions: {
          trustBrowserCas: false,
          trustedCertificates: [await readFile(directory + '/tls.crt', 'utf8')],
        },
      },
    },
  });
  await runtime.ready;
  return runtime;
}
