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
  for (const name of [
    'Host',
    'Forwarded',
    'X-Forwarded-For',
    'X-Forwarded-Host',
    'X-Forwarded-Proto',
    'X-Forwarded-Port',
    'X-Real-IP',
    'X-Original-URL',
    'X-Rewrite-URL',
  ]) {
    headers.delete(name);
  }
  const publicUrl = new URL(request.url);
  headers.set('X-Forwarded-Host', publicUrl.host);
  headers.set('X-Forwarded-Proto', 'https');
  const clientIp = request.headers.get('CF-Connecting-IP');
  if (clientIp) {
    headers.set('X-Forwarded-For', clientIp);
  }
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
    signal: request.signal,
  };

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
    // Required by Node's Request implementation when proxying streaming bodies.
    init.duplex = 'half';
  }

  const upstreamRequest = new Request(target, {
    ...init,
    cache: 'no-store',
  });
  let response;
  try {
    // Disable Cloudflare's shared cache even if the origin mislabels private data.
    response = await fetchUpstream(upstreamRequest);
  } catch {
    return new Response('Origin unavailable', {
      status: 502,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

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
  headers.set('Cache-Control', 'private, no-store, no-transform');
  headers.delete('CDN-Cache-Control');
  headers.delete('Cloudflare-CDN-Cache-Control');
  const location = headers.get('Location');
  if (location) {
    const redirect = new URL(location, target);
    if (redirect.origin === origin.origin) {
      const publicUrl = new URL(request.url);
      redirect.protocol = publicUrl.protocol;
      redirect.host = publicUrl.host;
      headers.set('Location', redirect.toString());
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
