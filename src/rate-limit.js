/**
 * These Cloudflare location-local limits protect expensive authentication
 * endpoints. They are not global quotas or a replacement for a WAF.
 */
export async function checkRateLimit(request, environment, profile, bindingName) {
  const limiter = environment[bindingName];
  const clientIp = request.headers.get('CF-Connecting-IP');

  if (!limiter || typeof limiter.limit !== 'function' || !clientIp) {
    return 'unavailable';
  }

  try {
    const decision = await limiter.limit({
      key: `${profile.id}:${clientIp}`,
    });

    if (typeof decision?.success !== 'boolean') {
      return 'unavailable';
    }

    return decision.success ? 'allowed' : 'limited';
  } catch {
    return 'unavailable';
  }
}
