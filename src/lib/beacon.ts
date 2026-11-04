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
/** Nielsen DMA code from Roku's [[[METRO_CODE]]] (US only, 3 digits today). */
const DMA_RE = /^[0-9]{1,5}$/;

/**
 * The value Roku substitutes for [[[DEVICE_IP]]] when the device has opted out
 * (LMT=1) or when geographic privacy rules forbid sharing the IP. It is an
 * explicit opt-out signal, not a missing value: Roku's Ads Manager tags carry
 * no separate LMT macro, so this is the only opt-out channel we get.
 */
const OPTED_OUT_IP = "0.0.0.0";

/** Dotted-quad shape check; each octet is range-checked separately. */
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Campaign entry in the CAMPAIGNS namespace.
 *
 * Two formats are accepted, because the bare-string form predates this and is
 * what the certification campaign already uses:
 *
 *   "active"          -> allowlisted, no flight window, no market override
 *   "child_directed"  -> as above, plus forced COPPA treatment
 *   {"status":"active","start":"2026-10-01","end":"2026-12-31","markets":["US"]}
 *
 * `start`/`end` are inclusive ISO-8601 dates or full timestamps, interpreted as
 * UTC. Absent means unbounded on that side.
 */
export interface CampaignConfig {
  childDirected: boolean;
  /** Unix seconds; null = unbounded. */
  startsAt: number | null;
  endsAt: number | null;
  /** Uppercase ISO-3166 alpha-2; empty = inherit the environment's markets. */
  markets: string[];
}

/**
 * Parse an ISO date or timestamp to unix seconds.
 *
 * A bare date is widened to cover the whole UTC day: "2026-12-31" as an `end`
 * must include that day's traffic, not expire at 00:00 and silently reject the
 * campaign's last 24 hours.
 */
function parseBoundary(raw: unknown, endOfDay: boolean): number | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const v = raw.trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(v);
  const ms = Date.parse(dateOnly ? `${v}T00:00:00Z` : v);
  if (!Number.isFinite(ms)) return null;
  const secs = Math.floor(ms / 1000);
  return dateOnly && endOfDay ? secs + 86399 : secs;
}

/**
 * Interpret a CAMPAIGNS value. A malformed JSON object is treated as
 * unparseable rather than as an unrestricted campaign, so a typo in a flight
 * window cannot silently widen the license.
 */
export function parseCampaignConfig(raw: string): CampaignConfig | null {
  const v = raw.trim();
  if (v === "") return null;
  if (!v.startsWith("{")) {
    return {
      childDirected: v === "child_directed",
      startsAt: null,
      endsAt: null,
      markets: [],
    };
  }

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(v) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== "object") return null;

  const status = typeof obj.status === "string" ? obj.status.trim().toLowerCase() : "active";
  // An explicitly paused/inactive campaign is not allowlisted.
  if (status !== "active" && status !== "child_directed") return null;

  const markets = Array.isArray(obj.markets)
    ? obj.markets
        .filter((m): m is string => typeof m === "string")
        .map((m) => m.trim().toUpperCase())
        .filter((m) => COUNTRY_RE.test(m))
    : [];

  return {
    childDirected: status === "child_directed" || obj.child_directed === true,
    startsAt: parseBoundary(obj.start, false),
    endsAt: parseBoundary(obj.end, true),
    markets,
  };
}

/** Markets the data license covers, from config; defaults to US (DSA §3(a)). */
export function licensedMarkets(env: Env): string[] {
  const raw = (env.LICENSED_MARKETS ?? "").trim();
  if (raw === "") return ["US"];
  const list = raw
    .split(",")
    .map((m) => m.trim().toUpperCase())
    .filter((m) => COUNTRY_RE.test(m));
  return list.length > 0 ? list : ["US"];
}

/**
 * True for a syntactically valid, non-zero IPv4 address. Roku documents
 * [[[DEVICE_IP]]] as IPv4-only, so anything else is a macro that did not
 * expand or a value we must not treat as a device identity.
 */
export function isUsableIpv4(raw: string): boolean {
  const m = IPV4_RE.exec(raw);
  if (m === null) return false;
  if (raw === OPTED_OUT_IP) return false;
  for (let i = 1; i <= 4; i++) {
    const octet = m[i];
    // Reject zero-padded octets ("01"): they are ambiguous and some parsers
    // read them as octal, so two spellings of one address would hash apart.
    if (octet.length > 1 && octet[0] === "0") return false;
    if (Number(octet) > 255) return false;
  }
  return true;
}

/**
 * Characters that never appear in a real device identifier but do appear in
 * unsubstituted ad-server macros: `[[[DEVICE_IP]]]` (Roku), `[IFA]` (IAB/VAST),
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
 * Recover a metro code from a tag that dropped the `=`.
 *
 * Roku trafficked `&dma[[[METRO_CODE]]]`, which after substitution arrives as a
 * bare key such as `dma501` with an empty value, so `p.get("dma")` is null.
 * Reading the digits out of the key recovers the field without waiting for the
 * tag to be re-trafficked. Only an all-digit suffix is accepted.
 */
function malformedDmaKey(p: URLSearchParams): string {
  for (const key of p.keys()) {
    const m = /^dma([0-9]{1,5})$/.exec(key);
    if (m) return m[1];
  }
  return "";
}

/** Read a raw query value without URLSearchParams turning base64 '+' into space. */
function rawQueryValue(url: URL, name: string): string {
  const match = new RegExp(`(?:^|&)${name}=([^&]*)`).exec(url.search.slice(1));
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]).trim();
  } catch {
    return "";
  }
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
  | {
      ok: true;
      impression: Impression;
      /**
       * Raw device IP for the bounded attribution window, or "" when the
       * device opted out or sent no usable address. Kept off `Impression` on
       * purpose: everything on that type is written to Analytics Engine and
       * the raw R2 tier, and this value must never reach either.
       */
      deviceIp: string;
    }
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
  const campaign = parseCampaignConfig(allowed);
  // An unparseable or non-active entry is not a licensed campaign.
  if (campaign === null) {
    return { ok: false, reason: "not_allowlisted" };
  }
  const childDirected = campaign.childDirected;

  // Flight window: DSA §2(b)(1) licenses collection "only for the duration of
  // the advertising campaign". `exp` on the tag is a rolling 30-day signature
  // TTL, not the campaign end date, so it cannot carry this.
  if (campaign.startsAt !== null && nowSeconds < campaign.startsAt) {
    return { ok: false, reason: "outside_flight" };
  }
  if (campaign.endsAt !== null && nowSeconds > campaign.endsAt) {
    return { ok: false, reason: "outside_flight" };
  }

  // Platform: pre-filled by us when generating the tag (`pf=ua`); defaults to
  // roku for existing tags. Determines which identity scheme applies below.
  const platform: Platform = clean(p.get("pf")) === "ua" ? "ua" : "roku";

  // A placeholder salt produces hashes that are trivially brute-forced, so
  // treat every impression as non-attributable rather than store a weak hash.
  const saltUsable = !isPlaceholderSecret(env.IFA_HASH_SALT);

  // ---------------------------------------------------------------------
  // Device identity.
  //
  // Roku Ads Manager supports no RIDA and no LMT macro (see
  // docs/ROKU_IMPRESSION_TAG.md §3): the only device-level value available is
  // [[[DEVICE_IP]]], and Roku collapses the opt-out signal into it by sending
  // "0.0.0.0" when the device opted out or privacy rules forbid sharing. So on
  // Roku the hashed IP *is* the device identity, and a zeroed IP is the opt-out.
  //
  // Universal Ads still supplies a real IFA plus a separate LMT flag, so that
  // path is unchanged.
  // ---------------------------------------------------------------------
  let lmt: boolean;
  let identityUsable: boolean;
  let ifaHash: string;
  let deviceIp = "";

  if (platform === "roku") {
    const rawDeviceIp = clean(p.get("device_ip"));
    const ipUsable = isUsableIpv4(rawDeviceIp);
    // Only "0.0.0.0" is an opt-out. An unexpanded macro or malformed value is
    // an unusable identifier, but claiming the user opted out would be a
    // fabricated privacy signal, so those stay lmt=false and non-attributable.
    lmt = childDirected || rawDeviceIp === OPTED_OUT_IP;
    identityUsable = saltUsable && !lmt && ipUsable;
    ifaHash = identityUsable ? await hashIfa(env.IFA_HASH_SALT, `ip:${rawDeviceIp}`) : "anon";
    deviceIp = identityUsable ? rawDeviceIp : "";
  } else {
    const rawIfa = clean(p.get("ifa"));
    lmt = resolveLmt(clean(p.get("lmt")), childDirected);
    identityUsable = saltUsable && !lmt && isUsableIfa(rawIfa);
    ifaHash = identityUsable ? await hashIfa(env.IFA_HASH_SALT, rawIfa) : "anon";
  }

  // Country: Roku's [[[COUNTRY]]] is authoritative for where the impression
  // served; the Cloudflare edge only sees where the beacon egressed. Fall back
  // to the edge value when the macro is absent or did not expand.
  const macroCountry = clean(p.get("country")).toUpperCase();
  const edgeCountry = (cf?.country ?? "").toUpperCase();
  const country = COUNTRY_RE.test(macroCountry)
    ? macroCountry
    : COUNTRY_RE.test(edgeCountry)
      ? edgeCountry
      : "XX";

  // Market: the DSA §3(a) license is Market-limited (United States), so an
  // impression served elsewhere is outside the license and must not be stored.
  // Checked after country resolution because Roku's [[[COUNTRY]]] macro is the
  // authoritative signal and the edge value is only a fallback.
  const markets = campaign.markets.length > 0 ? campaign.markets : licensedMarkets(env);
  const marketKnown = country !== "XX";
  if (marketKnown && !markets.includes(country)) {
    return { ok: false, reason: "out_of_market" };
  }
  if (!marketKnown && env.REJECT_UNKNOWN_MARKET === "true") {
    return { ok: false, reason: "out_of_market" };
  }

  // Nielsen DMA from [[[METRO_CODE]]]. Roku documents it as US-only, so it is
  // absent on other markets; "" reads as unknown.
  const rawDma = clean(p.get("dma")) || malformedDmaKey(p);
  const dma = DMA_RE.test(rawDma) ? rawDma : "";

  // Roku Ads Manager exposes no app/channel macro, so this stays "unknown" on
  // that platform; UA still sends a bundle.
  const appId = APP_ID_RE.test(clean(p.get("app_id"))) ? clean(p.get("app_id")) : "unknown";

  // ifa_type is a namespace label, not an identifier, so it is reported even
  // when there is no attributable IFA (e.g. under LMT) to keep platform mix
  // measurable. IFA_TYPE_RE already rejects macro-shaped and malformed values.
  const rawIfaType = clean(p.get("ifa_type")).toLowerCase();
  // On Roku the identity is a hashed device IP, not an advertising ID, so the
  // namespace is labelled as such rather than left blank or called "rida".
  const ifaType =
    platform === "roku" ? "ip" : IFA_TYPE_RE.test(rawIfaType) ? rawIfaType : "";

  // Native Roku UIDs are reporting dimensions, never signing inputs or
  // allowlist keys. Macro placeholders must not become stored "real" IDs.
  const rokuId = (name: string) => {
    const v = clean(p.get(name));
    return ID_RE.test(v) ? v : "";
  };
  const encodedCreative = rawQueryValue(url, "roku_creative_id_encoded");
  const postal = clean(p.get("roku_postal_code"));
  const cachebuster = clean(p.get("cb"));

  return {
    ok: true,
    impression: {
      advertiserId,
      campaignId,
      creativeId,
      rokuAdvertiserId: platform === "roku" ? rokuId("roku_advertiser_id") : "",
      rokuCampaignId: platform === "roku" ? rokuId("roku_campaign_id") : "",
      rokuCreativeId: platform === "roku" ? rokuId("roku_creative_id") : "",
      rokuCreativeIdEncoded:
        platform === "roku" && /^[A-Za-z0-9+/=_-]{1,128}$/.test(encodedCreative)
          ? encodedCreative
          : "",
      rokuPostalCode:
        platform === "roku" && !lmt && /^[A-Za-z0-9 -]{1,16}$/.test(postal)
          ? postal
          : "",
      rokuCachebuster:
        platform === "roku" && /^[A-Za-z0-9_-]{1,128}$/.test(cachebuster)
          ? cachebuster
          : "",
      ifaHash,
      ifaPresent: identityUsable,
      lmt,
      appId,
      country,
      dma,
      ifaType,
      platform,
    },
    deviceIp,
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
  // Must hash exactly what the live path hashed, including the "ip:" prefix on
  // Roku. Hashing a different preimage here yields a key that never matches
  // any stored row, so every device would look new for the whole rotation
  // window and dedup would silently lapse.
  const subject =
    imp.platform === "roku"
      ? (() => {
          const ip = clean(url.searchParams.get("device_ip"));
          return isUsableIpv4(ip) ? `ip:${ip}` : "";
        })()
      : clean(url.searchParams.get("ifa"));
  if (!subject) return null;
  const { prev } = await hashIfaWithRotation(env.IFA_HASH_SALT, env.IFA_HASH_SALT_PREV, subject);
  return prev ? `${prev}|${dedupScope(imp)}` : null;
}

/** Native Roku campaign/creative IDs isolate traffic sharing a signed tag. */
function dedupScope(imp: Impression): string {
  const rokuScope =
    imp.platform === "roku" && imp.rokuCampaignId && imp.rokuCreativeId
      ? `|${imp.rokuCampaignId}|${imp.rokuCreativeId}`
      : "";
  return `${imp.campaignId}|${imp.creativeId}${rokuScope}`;
}

/**
 * Dedup key for an impression within the window. Uses the salted ifaHash so
 * the key never contains a raw identifier. When IFA is absent we cannot dedup
 * by device, so we return null (count it, but flagged non-attributable).
 */
export function dedupKey(imp: Impression): string | null {
  if (!imp.ifaPresent) return null;
  return `${imp.ifaHash}|${dedupScope(imp)}`;
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
  // Peppered with a dedicated secret when one is set, falling back to the IFA
  // salt. Rotating the IFA salt is routine privacy hygiene, and sharing it here
  // made every rotation silently reset the frequency cap on exactly the
  // LMT/child-directed traffic that has no other cap — this key class has no
  // previous-salt alias, so there is nothing to carry the old bucket across.
  // A placeholder value is ignored rather than used, matching how every other
  // secret is treated: the shipped `.dev.vars.example` default would otherwise
  // become a live pepper on any deploy that set it without rotating.
  const configured = env.IP_CAP_SALT?.trim();
  const pepper =
    configured && !isPlaceholderSecret(configured) ? configured : env.IFA_HASH_SALT;
  const h = await hashIfa(pepper, `ip:${ip}:${hourBucket}`);
  return `${h}|${dedupScope(imp)}`;
}
