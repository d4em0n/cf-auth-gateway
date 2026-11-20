import { extractCredential, fingerprintCredential } from './credentials.js';
import { proxyRequest, resolveOrigin } from './origin.js';
import { matchRoute, validateProfile } from './profile.js';
import { checkRateLimit } from './rate-limit.js';
import { rememberCredential, wasRecognized } from './recognition.js';
import { validateCredential } from './validation.js';

function deny(status, message) {
  return new Response(message, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}

function rateLimitFailure(decision) {
  if (decision === 'limited') {
    return deny(429, 'Too many authentication attempts');
  }

  if (decision !== 'allowed') {
    return deny(503, 'Authentication rate limiter unavailable');
  }

  return null;
}

function isWebSocketRequest(request) {
  return request.headers.get('Upgrade')?.trim().toLowerCase() === 'websocket';
}

/**
 * A transparent gate, not an identity provider:
 *
 * 1. Allow only explicit public and auth lifecycle routes without a credential.
 * 2. For protected routes, recognize known credential fingerprints.
 * 3. Validate unknown credentials with the origin before forwarding.
 * 4. Leave all real authentication and resource authorization to the origin.
 */
export function createGateway(profileDefinition, { fetchUpstream = fetch } = {}) {
  const profile = validateProfile(profileDefinition);

  return async function handleRequest(request, environment) {
    try {
      const origin = resolveOrigin(environment, profile);
      const hostname = new URL(request.url).hostname.toLowerCase();

      if (hostname !== profile.hostname) {
        return deny(421, 'Unknown hostname');
      }

      const upgrade = request.headers.get('Upgrade');
      const isWebSocket = isWebSocketRequest(request);

      if (upgrade && !isWebSocket) {
        return deny(400, 'Unsupported protocol upgrade');
      }

      if (isWebSocket && request.method !== 'GET') {
        return deny(400, 'WebSocket upgrades require GET');
      }

      const route = matchRoute(profile, request);
      const isPublicRoute = route.access === 'public' || route.access === 'auth_flow';

      // Public HTML/assets must not accidentally grant public WebSocket access.
      if (isPublicRoute && !isWebSocket) {
        if (route.rateLimit === true) {
          const decision = await checkRateLimit(
            request,
            environment,
            profile,
            'AUTH_FLOW_LIMITER',
          );

          const failure = rateLimitFailure(decision);
          if (failure) {
            return failure;
          }
        }

        return proxyRequest(request, environment, origin, fetchUpstream);
      }

      const credential = extractCredential(request, profile);

      if (!credential || credential.error) {
        return deny(401, 'Authentication required');
      }

      const fingerprint = await fingerprintCredential(
        credential,
        profile,
        environment.HMAC_SECRET,
      );

      const recognized = await wasRecognized(environment.RECOGNIZED, fingerprint);

      if (!recognized) {
        const decision = await checkRateLimit(
          request,
          environment,
          profile,
          'UNKNOWN_LIMITER',
        );

        const failure = rateLimitFailure(decision);
        if (failure) {
          return failure;
        }

        const validation = await validateCredential(
          credential,
          profile,
          environment,
          origin,
          fetchUpstream,
        );

        if (validation === 'invalid') {
          return deny(401, 'Invalid credential');
        }

        if (validation !== 'valid') {
          return deny(503, 'Credential validator unavailable');
        }

        await rememberCredential(environment.RECOGNIZED, fingerprint, profile.retentionDays);
      }

      return proxyRequest(request, environment, origin, fetchUpstream);
    } catch {
      // A Worker exception must never fall back to sending the request to origin.
      return deny(503, 'Gateway unavailable');
    }
  };
}
