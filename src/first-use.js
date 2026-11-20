import { checkRateLimit } from './rate-limit.js';
import { rememberCredential } from './recognition.js';
import { validateCredential } from './validation.js';

const MAX_PENDING_VALIDATIONS = 256;

/** Coalesce only in-flight checks within this isolate; never cache an auth result. */
export function createFirstUseValidator(profile, fetchUpstream) {
  const pending = new Map();

  async function validate(credential, fingerprint, request, environment, origin) {
    const decision = await checkRateLimit(request, environment, profile, 'UNKNOWN_LIMITER');
    if (decision !== 'allowed') {
      return decision === 'limited' ? 'limited' : 'limiter_unavailable';
    }
    const result = await validateCredential(
      credential,
      profile,
      environment,
      origin,
      fetchUpstream,
    );
    if (result === 'valid') {
      await rememberCredential(environment.RECOGNIZED, fingerprint, profile.retentionDays);
    }
    return result;
  }

  return async function validateFirstUse(credential, fingerprint, request, environment, origin) {
    const existing = pending.get(fingerprint);
    if (existing) return existing;
    if (pending.size >= MAX_PENDING_VALIDATIONS) return 'unavailable';

    // Only a scalar decision crosses request contexts, never a response body or socket.
    const validation = validate(credential, fingerprint, request, environment, origin);
    pending.set(fingerprint, validation);
    try {
      return await validation;
    } finally {
      pending.delete(fingerprint);
    }
  };
}
