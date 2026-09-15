/**
 * HMAC signing/verification and salted hashing using WebCrypto
 * (available in Workers; no Node Buffer required).
 */

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Constant-time string comparison to avoid signature timing leaks. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Values shipped in `.dev.vars.example` and `wrangler.toml`. A deploy that
 * still carries one of these has no real secret: signatures become forgeable
 * and event_group_ids are rejected by the platform. We refuse to process
 * trusted traffic rather than silently accept forged input.
 */
const PLACEHOLDER_SECRETS = new Set([
  "0000000000000000000000000000000000000000000000000000000000000000",
  "1111111111111111111111111111111111111111111111111111111111111111",
  "2222222222222222222222222222222222222222222222222222222222222222",
  "3333333333333333333333333333333333333333333333333333333333333333",
  "your-analytics-read-token",
  "your-cloudflare-account-id",
  "REPLACE_WITH_EVENT_GROUP_ID",
]);

/** True when the value is empty, blank, or a documented placeholder. */
export function isPlaceholderSecret(value: string | undefined | null): boolean {
  if (value === undefined || value === null) return true;
  const v = value.trim();
  if (v === "") return true;
  return PLACEHOLDER_SECRETS.has(v);
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/**
 * Compute HMAC-SHA256 over the canonical message and return hex.
 * Canonical message binds the count-relevant fields + expiry.
 */
export async function signMessage(secret: string, message: string): Promise<string> {
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return toHex(sig);
}

/**
 * Verify a tag URL signature. The signed message is:
 *   `${advertiserId}|${campaignId}|${creativeId}|${exp}`
 * `exp` is a unix-seconds expiry; requests after it are rejected.
 *
 * `advertiser_id` is inside the signed message because it is the field that
 * decides whose counts an impression is credited to, and it cannot be inferred
 * from the campaign id. A tag URL is public by design (it is the ad markup), so
 * without this binding anyone who saw the tag could re-point beacons at another
 * advertiser.
 *
 * `ifa` and `lmt` deliberately cannot be bound: the ad server substitutes them
 * on the device via macros, so they are not known when we sign. Count inflation
 * through fabricated `ifa` values is mitigated by the per-IP rate limit and the
 * dedup window instead.
 */
export async function verifyTagSignature(
  secret: string,
  advertiserId: string,
  campaignId: string,
  creativeId: string,
  exp: number,
  providedSig: string,
  nowSeconds: number,
): Promise<{ ok: true } | { ok: false; reason: "expired" | "bad_signature" }> {
  if (!Number.isFinite(exp) || exp < nowSeconds) {
    return { ok: false, reason: "expired" };
  }
  const expected = await signMessage(
    secret,
    `${advertiserId}|${campaignId}|${creativeId}|${exp}`,
  );
  if (!timingSafeEqual(expected, providedSig.toLowerCase())) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true };
}

/**
 * Salted SHA-256 hash of an IFA. We never store the raw identifier.
 * Returns hex digest.
 */
export async function hashIfa(salt: string, ifa: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${salt}|${ifa}`));
  return toHex(digest);
}

/**
 * Salt rotation support: hash with the current salt, and additionally with the
 * previous salt when one is configured. During a rotation window the dedup
 * check consults both hashes so devices first seen under the old salt are not
 * double-counted. `prev` is null once the window has passed.
 */
export async function hashIfaWithRotation(
  salt: string,
  prevSalt: string | undefined,
  ifa: string,
): Promise<{ current: string; prev: string | null }> {
  const current = await hashIfa(salt, ifa);
  const prev = prevSalt ? await hashIfa(prevSalt, ifa) : null;
  return { current, prev };
}

/**
 * Verify an HMAC-SHA256 webhook signature that is bound to a timestamp.
 *
 * The signed message is `${timestamp}.${rawBody}`, and the timestamp must be
 * within `maxSkewSeconds` of now. Binding the timestamp is what makes a
 * captured payload stop working: a body-only HMAC stays valid forever, so a
 * replayed /call would fire the conversion again.
 */
export async function verifyTimestampedSignature(
  secret: string,
  timestamp: string,
  rawBody: string,
  providedSig: string,
  nowSeconds: number,
  maxSkewSeconds: number,
): Promise<{ ok: true } | { ok: false; reason: "bad_signature" | "expired" }> {
  if (!providedSig) return { ok: false, reason: "bad_signature" };
  const ts = Number(timestamp);
  if (timestamp.trim() === "" || !Number.isFinite(ts)) {
    return { ok: false, reason: "bad_signature" };
  }
  if (Math.abs(nowSeconds - ts) > maxSkewSeconds) {
    return { ok: false, reason: "expired" };
  }
  const expected = await signMessage(secret, `${timestamp}.${rawBody}`);
  if (!timingSafeEqual(expected, providedSig.toLowerCase())) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true };
}
