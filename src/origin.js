/**
 * The origin is fixed by Worker configuration. Clients cannot choose it.
 * In production, the origin reverse proxy MUST verify ORIGIN_GATEWAY_SECRET.
 */
export function resolveOrigin(environment, profile) {
  if (typeof environment.ORIGIN_URL !== 'string') {
    throw new Error('ORIGIN_URL is required');
  }

  const origin = new URL(environment.ORIGIN_URL);

  const isSafeOrigin =
    origin.protocol === 'https:' &&
    origin.hostname !== profile.hostname &&
    origin.pathname === '/' &&
    origin.search === '' &&
    origin.hash === '' &&
    origin.username === '' &&
    origin.password === '';

  if (!isSafeOrigin) {
    throw new Error('ORIGIN_URL must specify a distinct HTTPS origin with no path');
  }

  if (
    typeof environment.ORIGIN_GATEWAY_SECRET !== 'string' ||
    environment.ORIGIN_GATEWAY_SECRET.length < 32
  ) {
    throw new Error('ORIGIN_GATEWAY_SECRET must contain at least 32 characters');
  }

  return origin;
}

export function upstreamHeaders(request, environment) {
  const headers = new Headers(request.headers);

  // Never trust a caller-supplied identity or gateway verification header.
  headers.delete('X-CF-Auth-Gateway-Secret');
  headers.delete('X-CF-Auth-Gateway-User');
  headers.set('X-CF-Auth-Gateway-Secret', environment.ORIGIN_GATEWAY_SECRET);

  return headers;
}

export async function proxyRequest(request, environment, origin, fetchUpstream) {
  const target = new URL(request.url);
  target.protocol = origin.protocol;
  target.host = origin.host;

  const init = {
    method: request.method,
    headers: upstreamHeaders(request, environment),
    redirect: 'manual',
  };

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
    // Required by Node's Request implementation when proxying streaming bodies.
    init.duplex = 'half';
  }

  const upstreamRequest = new Request(target, init);
  const response = await fetchUpstream(upstreamRequest);

  if (response.status === 101) {
    // A WebSocket upgrade response cannot be rebuilt as a normal Response.
    // Returning the original response preserves its live webSocket handle.
    const isWebSocket = request.headers.get('Upgrade')?.trim().toLowerCase() === 'websocket';

    if (!isWebSocket || !response.webSocket) {
      return new Response('Invalid WebSocket upgrade', { status: 502 });
    }

    return response;
  }

  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'private, no-store');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
