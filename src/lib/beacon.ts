import type { Env, Impression, Platform, RejectReason } from "../types";
import {
  hashIfa,
  hashIfaWithRotation,
  verifyTagSignature,
  isPlaceholderSecret,
} from "./crypto";

/** IDs we accept: alphanumeric, dash, underscore, reasonable length. */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** App/bundle IDs (UA sends reverse-DNS bundles, e.g. com.example.channel). */
const APP_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;
/** IFA namespace token (e.g. "rida", "idfa", "aaid"). */
const IFA_TYPE_RE = /^[A-Za-z0-9_-]{1,16}$/;
const COUNTRY_RE = /^[A-Z]{2}$/;

/**
 * Characters that never appear in a real device identifier but do appear in
 * unsubstituted ad-server macros: `[[[RIDA]]]` (Roku RAF), `[IFA]` (IAB/VAST),
 * `${IDA}`, `%%RIDA%%`, `##RIDA##`, `<IDA>`. `URLSearchParams` has already
 * percent-decoded, so the literal characters are what we see here.
 */
const MACRO_CHARS = /[[\]{}%#<>$]/;

/**
 * Values an ad server or intermediary emits when a macro did NOT resolve. These
 * are not identifiers and must not be hashed: doing so mints one shared
 * pseudo-device for every affected beacon.
 */
const NULL_SENTINELS = new Set([
  "undefined",
  "null",
  "nil",
  "n/a",
  "na",
  "nan",
  "none",
  "unknown",
  "false",
  "-",
]);

/** A zeroed IFA (LMT/opt-out) per common CTV conventions. */
const ZERO_IFA = /^[0-]+$/;

/**
 * Separators an IFA may legitimately contain. They are stripped before the
 * single-character-repeat test below, because an unset GUID is written
 * `FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF` (all-F) or
 * `00000000-0000-...` (all-zero) and the dashes would otherwise break the
 * backreference run, leaving the all-F form to be hashed as a real device.
 */
const IFA_SEPARATORS = /[-: ]/g;

/** Every significant character identical, e.g. `FFFFFFFF-FFFF-...`. */
const SAME_CHAR = /^(.)\1+$/;

/** True when every significant character of the identifier is the same. */
function isSameCharRepeat(raw: string): boolean {
  const stripped = raw.replace(IFA_SEPARATORS, "");
  return stripped.length > 0 && SAME_CHAR.test(stripped);
}

function clean(v: string | null): string {
  return (v ?? "").trim();
}

/**
 * True when a raw `ifa` value can serve as a device identifier.
 *
 * This is a denylist (macro characters, null sentinels, zeroed IDs, and
 * single-character repeats) rather than a strict shape allowlist. An allowlist
 * of UUID/AAID/hex patterns would be tighter, but a platform whose IFA format
 * we failed to anticipate would have every impression silently downgraded to
 * non-attributable — a worse failure than the residual gap here. See
 * `docs/ROKU_DSA_GAP_ANALYSIS.md` A2 for the macro tokens still to be confirmed
 * with Roku.
 */
function isUsableIfa(raw: string): boolean {
  if (raw.length === 0) return false;
  if (MACRO_CHARS.test(raw)) return false;
  if (isSameCharRepeat(raw)) return false;
  if (ZERO_IFA.test(raw.replace(IFA_SEPARATORS, ""))) return false;
  if (NULL_SENTINELS.has(raw.toLowerCase())) return false;
  return true;
}

/** Keys a platform may use to signal "limit ad tracking". */
const LIMIT_TRUE = new Set(["1", "true", "yes", "y"]);
const LIMIT_FALSE = new Set(["0", "false", "no", "n"]);

/**
 * Resolve the opt-out signal.
 *
 * Explicit truthy values are LMT. Explicit falsy values are consent. Anything
 * else that is non-empty — an unresolved macro, a null sentinel, an
 * unrecognised token — is treated as opted out, because an unreadable opt-out
 * signal must never be read as consent. An *absent* parameter is still read as
 * consent: the tags are built to send it, and failing closed on absence would
 * silently zero all attribution. Confirm the real tokens with Roku (gap A2) and
 * the Data Processing Flag (gap F5) before go-live.
 */
function resolveLmt(rawLmt: string, childDirected: boolean): boolean {
  if (childDirected) return true;
  const v = rawLmt.trim().toLowerCase();
  if (LIMIT_TRUE.has(v)) return true;
  if (LIMIT_FALSE.has(v)) return false;
  if (v === "") return false; // absent: documented as consent
  return true; // macro-shaped, sentinel, or unrecognised => fail closed
}

export type Extraction =
  | { ok: true; impression: Impression }
  | { ok: false; reason: RejectReason };

/**
 * Parse, authenticate, and validate a /pixel beacon.
 *
 * Order matters: cheap structural checks first, then signature, then the
 * (async) allowlist lookup. Returns a normalized Impression on success.
 */
export async function extractImpression(
  url: URL,
  cf: { country?: string } | undefined,
  env: Env,
  nowSeconds: number,
): Promise<Extraction> {
  const p = url.searchParams;

  const advertiserId = clean(p.get("advertiser_id"));
  const campaignId = clean(p.get("campaign_id"));
  const creativeId = clean(p.get("creative_id"));

  // Required + format validation
  if (!ID_RE.test(advertiserId) || !ID_RE.test(campaignId) || !ID_RE.test(creativeId)) {
    return { ok: false, reason: "missing_params" };
  }

  // Authenticity: HMAC-signed tag URL with expiry. The signature binds
  // campaign|creative|exp so a captured URL cannot be repointed to another
  // campaign and is only valid until `exp`.
  if (env.SIGNATURE_REQUIRED === "true") {
    // A placeholder signing key means anyone can forge a tag URL, so refuse
    // rather than accept forged beacons as genuine traffic.
    if (isPlaceholderSecret(env.HMAC_SIGNING_KEY)) {
      return { ok: false, reason: "not_configured" };
    }
    const exp = Number(p.get("exp"));
    const sig = clean(p.get("sig"));
    if (!sig) return { ok: false, reason: "bad_signature" };
    const v = await verifyTagSignature(
      env.HMAC_SIGNING_KEY,
      advertiserId,
      campaignId,
      creativeId,
      exp,
      sig,
      nowSeconds,
    );
    if (!v.ok) return { ok: false, reason: v.reason };
  }

  // Allowlist: campaign must be known/active. Value is opaque for "active";
  // the special value "child_directed" (COPPA) forces LMT treatment so no
  // behavioral identifier is ever processed for that campaign.
  const allowed = await env.CAMPAIGNS.get(`campaign:${campaignId}`);
  if (allowed === null) {
    return { ok: false, reason: "not_allowlisted" };
  }
  const childDirected = allowed === "child_directed";

  // Privacy: honor LMT. If IFA is missing/zeroed/macro-shaped, the opt-out
  // signal is unreadable, or the campaign is child-directed, we never store the
  // identifier and mark the impression non-attributable.
  const rawIfa = clean(p.get("ifa"));
  const lmt = resolveLmt(clean(p.get("lmt")), childDirected);
  // A placeholder salt produces hashes that are trivially brute-forced, so
  // treat every impression as non-attributable rather than store a weak hash.
  const saltUsable = !isPlaceholderSecret(env.IFA_HASH_SALT);
  const ifaUsable = saltUsable && !lmt && isUsableIfa(rawIfa);

  const ifaHash = ifaUsable ? await hashIfa(env.IFA_HASH_SALT, rawIfa) : "anon";

  const rawCountry = (cf?.country ?? "").toUpperCase();
  const country = COUNTRY_RE.test(rawCountry) ? rawCountry : "XX";

  const appId = APP_ID_RE.test(clean(p.get("app_id"))) ? clean(p.get("app_id")) : "unknown";

  // ifa_type is a namespace label, not an identifier, so it is reported even
  // when there is no attributable IFA (e.g. under LMT) to keep platform mix
  // measurable. IFA_TYPE_RE already rejects macro-shaped and malformed values.
  const rawIfaType = clean(p.get("ifa_type")).toLowerCase();
  const ifaType = IFA_TYPE_RE.test(rawIfaType) ? rawIfaType : "";

  // Platform: pre-filled by us when generating the tag (`pf=ua`); defaults to
  // roku for existing tags.
  const platform: Platform = clean(p.get("pf")) === "ua" ? "ua" : "roku";

  return {
    ok: true,
    impression: {
      advertiserId,
      campaignId,
      creativeId,
      ifaHash,
      ifaPresent: ifaUsable,
      appId,
      country,
      ifaType,
      platform,
    },
  };
}

/**
 * Previous-salt hash for the same impression, used only for the dedup check
 * during a salt-rotation window. Returns null when no previous salt is set or
 * the impression is non-attributable.
 */
export async function prevSaltDedupKey(
  env: Env,
  url: URL,
  imp: Impression,
): Promise<string | null> {
  if (!imp.ifaPresent || !env.IFA_HASH_SALT_PREV) return null;
  const rawIfa = clean(url.searchParams.get("ifa"));
  if (!rawIfa) return null;
  const { prev } = await hashIfaWithRotation(env.IFA_HASH_SALT, env.IFA_HASH_SALT_PREV, rawIfa);
  return prev ? `${prev}|${imp.campaignId}|${imp.creativeId}` : null;
}

/**
 * Dedup key for an impression within the window. Uses the salted ifaHash so
 * the key never contains a raw identifier. When IFA is absent we cannot dedup
 * by device, so we return null (count it, but flagged non-attributable).
 */
export function dedupKey(imp: Impression): string | null {
  if (!imp.ifaPresent) return null;
  return `${imp.ifaHash}|${imp.campaignId}|${imp.creativeId}`;
}

/**
 * Coarse frequency cap for impressions that carry no usable identifier (LMT,
 * COPPA child-directed, zeroed IFA, unexpanded macro).
 *
 * Without this those beacons are never deduplicated, so a single device can
 * inflate counts without bound and there is no frequency cap on exactly the
 * campaigns with the strictest privacy obligations. The key is a salted hash
 * of the device IP combined with an hour bucket, so no identifier is stored,
 * the key rotates every hour, and the row is purged by the dedup alarm like
 * any other. Because the key is IP-derived rather than IFA-derived, it is not
 * matched by the IFA DSAR erase path; the short TTL is the erasure mechanism.
 */
export async function nonAttributableDedupKey(
  env: Env,
  imp: Impression,
  ip: string,
  nowSeconds: number,
  enabled: boolean,
): Promise<string | null> {
  if (!enabled || !ip) return null;
  const hourBucket = Math.floor(nowSeconds / 3600);
  const h = await hashIfa(env.IFA_HASH_SALT, `ip:${ip}:${hourBucket}`);
  return `${h}|${imp.campaignId}|${imp.creativeId}`;
}
