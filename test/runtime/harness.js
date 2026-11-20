import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import profile from '../../profiles/test-server.json' with { type: 'json' };

export const secret = 'runtime-origin-secret-at-least-32-characters';

export async function bundle(source) {
  const result = await build({
    stdin: { contents: source, resolveDir: process.cwd(), sourcefile: 'runtime-entry.js' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
  });
  return result.outputFiles[0].text;
}

export async function runtimeGateway(originScript, options = {}) {
  const script = await bundle(`
    import { createGateway } from './src/gateway.js';
    const handle = createGateway(${JSON.stringify(options.profile ?? profile)});
    export default {fetch: handle};
  `);
  const worker = new Miniflare({
    https: true,
    workers: [
      {
        name: 'gateway',
        modules: true,
        script,
        compatibilityDate: '2026-07-01',
        kvNamespaces: ['RECOGNIZED'],
        ratelimits: {
          AUTH_FLOW_LIMITER: { namespace_id: '1001', simple: { limit: 100, period: 60 } },
          UNKNOWN_LIMITER: {
            namespace_id: '1002',
            simple: { limit: options.unknownLimit ?? 100, period: 60 },
          },
        },
        bindings: {
          ORIGIN_URL: 'https://origin.fixture.test',
          ORIGIN_GATEWAY_SECRET: secret,
          HMAC_SECRET: 'runtime-hmac-secret-with-at-least-32-characters',
        },
        outboundService: options.outboundService ?? 'origin',
      },
      { name: 'origin', modules: true, script: originScript, compatibilityDate: '2026-07-01' },
    ],
  });
  await worker.ready;
  return worker;
}
