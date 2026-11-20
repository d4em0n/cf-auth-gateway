import https from 'node:https';
import http from 'node:http';
import { readFile } from 'node:fs/promises';

/** Local TLS origin boundary. Logs metadata only, never cookies, tokens or bodies. */
export async function startOrigin(directory, secret) {
  const observations = [];
  const server = https.createServer(
    {
      key: await readFile(directory + '/tls.key'),
      cert: await readFile(directory + '/tls.crt'),
    },
    (incoming, outgoing) => {
      const entry = {
        method: incoming.method,
        path: new URL(incoming.url, 'https://origin.fixture.test').pathname,
      };
      observations.push(entry);
      if (incoming.headers['x-cf-auth-gateway-secret'] !== secret) {
        entry.status = 403;
        outgoing.writeHead(403).end();
        return;
      }
      const headers = { ...incoming.headers, host: '127.0.0.1:3096' };
      delete headers['x-cf-auth-gateway-secret'];
      const upstream = http.request(
        { hostname: '127.0.0.1', port: 3096, path: incoming.url, method: incoming.method, headers },
        (response) => {
          entry.status = response.statusCode;
          outgoing.writeHead(response.statusCode, response.headers);
          response.pipe(outgoing);
        },
      );
      upstream.on('error', (error) => {
        console.log('QA origin transport', error.code);
        outgoing.writeHead(502).end();
      });
      outgoing.on('close', () => upstream.destroy());
      incoming.pipe(upstream);
    },
  );
  server.on('tlsClientError', (error) => console.log('QA TLS', error.code));
  await new Promise((resolve) => server.listen(19443, '127.0.0.1', resolve));
  return {
    observations,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
