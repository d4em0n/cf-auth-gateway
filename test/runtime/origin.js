let validations = 0;

export default {
  async fetch(request) {
    if (
      request.headers.get('X-CF-Auth-Gateway-Secret') !==
      'runtime-origin-secret-at-least-32-characters'
    ) {
      return new Response('Forbidden', { status: 403 });
    }
    if (request.headers.get('X-Forwarded-Host') !== 'app.fixture.test') {
      return new Response('Untrusted forwarding host', { status: 400 });
    }
    const path = new URL(request.url).pathname;
    const token = request.headers.get('Authorization');
    if (path === '/assets/stats') return Response.json({ validations });
    if (path === '/auth/whoami') {
      validations++;
      if (token === 'Bearer delayed') await new Promise((resolve) => setTimeout(resolve, 100));
      if (token === 'Bearer timeout') {
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      return ['Bearer good', 'Bearer delayed'].includes(token)
        ? Response.json({ user: { id: 'alice' } })
        : new Response('Invalid', { status: 401 });
    }
    if (path === '/api/socket') {
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].addEventListener('message', (event) => pair[1].send(event.data));
      pair[1].addEventListener('close', (event) => pair[1].close(event.code, event.reason));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (path === '/auth/login') {
      const headers = new Headers({ Location: 'https://origin.fixture.test/login' });
      headers.append('Set-Cookie', 'refresh=one; Path=/; Secure; HttpOnly; SameSite=Strict');
      headers.append('Set-Cookie', 'provider=local; Path=/; Secure; HttpOnly');
      return new Response(null, { status: 302, headers });
    }
    if (path === '/api/echo') {
      return new Response(request.body, {
        headers: { 'Content-Type': 'application/octet-stream' },
      });
    }
    if (path === '/api/events') {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event: message\ndata: first\n\n'));
        },
        cancel() {},
      });
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (path === '/assets/compressed') {
      const stream = new Blob(['compressed response'])
        .stream()
        .pipeThrough(new CompressionStream('gzip'));
      return new Response(stream, {
        headers: { 'Content-Encoding': 'gzip' },
        encodeBody: 'manual',
      });
    }
    return Response.json(Object.fromEntries(request.headers));
  },
};
