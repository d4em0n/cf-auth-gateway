/**
 * Workers KV is an eventually consistent recognition registry.
 * A hit only means the credential has been validated at some point.
 * Expiry, revocation, and resource permissions remain the origin's job.
 */

export async function wasRecognized(storage, fingerprint) {
  try {
    return (await storage.get(fingerprint)) !== null;
  } catch {
    // A storage outage triggers another origin validation; never allow unknowns.
    return false;
  }
}

export async function rememberCredential(storage, fingerprint, retentionDays) {
  try {
    await storage.put(fingerprint, '1', {
      expirationTtl: retentionDays * 24 * 60 * 60,
    });
  } catch {
    // The current request was just validated. A failed write only makes the
    // next request revalidate; it must not make this request fail open.
  }
}
